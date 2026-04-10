#!/usr/bin/env python3

import argparse
import csv
import getpass
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from import_to_snipeit import ApiError, SnipeClient, cleaned_text, get_payload_id
except ModuleNotFoundError as exc:
    if exc.name == "requests":
        print("Missing dependency: requests", file=sys.stderr)
        print("Install it with: py -m pip install requests", file=sys.stderr)
        raise SystemExit(2) from exc
    raise


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PATH = REPO_ROOT / "data" / "component_batch_2026-04-09.tsv"
SETTINGS_PATH = REPO_ROOT / "component_batch_import.local.json"
DEFAULT_CATEGORY = "SAS Disk"
DEFAULT_LOCATION = "IN DEPOT"
PROFILE_CHOICES = ("test", "prod")


class InputValidationError(RuntimeError):
    pass


class LiveConfirmationDeclined(RuntimeError):
    pass


@dataclass(frozen=True)
class BatchRow:
    row_number: int
    name: str
    serial: str

    @property
    def serial_key(self) -> str:
        return self.serial.upper()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interactively import component batches into Snipe-IT.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Validate and report without creating anything.")
    mode.add_argument("--live", action="store_true", help="Create missing components after confirmation.")
    parser.add_argument("--profile", choices=PROFILE_CHOICES, help="Settings profile to use.")
    parser.add_argument("--api-base", help="Snipe-IT API base URL, for example https://example/api/v1")
    parser.add_argument("--input", help="Path to a CSV or TSV file with Name and Serial headers.")
    parser.add_argument("--category", help="Component category name.")
    parser.add_argument("--location", help="Component location name.")
    parser.add_argument("--report", help="Path to write the JSON report.")
    return parser.parse_args()


def load_settings() -> dict[str, Any]:
    if not SETTINGS_PATH.exists():
        return {"last_profile": "test", "profiles": {}}

    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"last_profile": "test", "profiles": {}}

    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        profiles = {}

    last_profile = data.get("last_profile")
    if last_profile not in PROFILE_CHOICES:
        last_profile = "test"

    return {
        "last_profile": last_profile,
        "profiles": profiles,
    }


def save_settings(profile: str, api_base: str, input_path: Path, category: str, location: str) -> None:
    payload = {
        "last_profile": profile,
        "profiles": {
            **load_settings().get("profiles", {}),
            profile: {
                "api_base": api_base,
                "input": serialize_path(input_path),
                "category": category,
                "location": location,
            },
        },
    }
    SETTINGS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def serialize_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO_ROOT))
    except ValueError:
        return str(resolved)


def resolve_setting_path(value: str | None, fallback: Path) -> Path:
    if not value:
        return fallback

    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate

    repo_relative = REPO_ROOT / candidate
    if repo_relative.exists():
        return repo_relative

    return Path.cwd() / candidate


def pretty_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        try:
            return str(path.resolve().relative_to(REPO_ROOT))
        except ValueError:
            return str(path.resolve())


def prompt_choice(label: str, options: tuple[str, ...], default: str) -> str:
    options_display = "/".join(option.upper() if option == default else option for option in options)
    while True:
        response = input(f"{label} [{options_display}]: ").strip().lower()
        if not response:
            return default
        if response in options:
            return response
        print(f"Please choose one of: {', '.join(options)}")


def prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        response = input(f"{label}{suffix}: ").strip()
        if response:
            return response
        if default is not None:
            return default
        print("A value is required.")


def prompt_yes_no(label: str, default: bool = False) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        response = input(f"{label} [{suffix}]: ").strip().lower()
        if not response:
            return default
        if response in {"y", "yes"}:
            return True
        if response in {"n", "no"}:
            return False
        print("Please answer yes or no.")


def determine_profile(args: argparse.Namespace, settings: dict[str, Any]) -> str:
    if args.profile:
        return args.profile
    return prompt_choice("Profile", PROFILE_CHOICES, settings.get("last_profile", "test"))


def determine_dry_run(args: argparse.Namespace) -> bool:
    if args.live:
        return False
    if args.dry_run:
        return True
    mode = prompt_choice("Mode", ("dry-run", "live"), "dry-run")
    return mode == "dry-run"


def determine_api_base(args: argparse.Namespace, profile_settings: dict[str, Any]) -> str:
    if args.api_base:
        return args.api_base.strip().rstrip("/")
    default = str(profile_settings.get("api_base") or "")
    return prompt_text("Snipe-IT API base URL", default).rstrip("/")


def determine_input_path(args: argparse.Namespace, profile_settings: dict[str, Any]) -> Path:
    if args.input:
        return resolve_setting_path(args.input, DEFAULT_INPUT_PATH)
    default = resolve_setting_path(profile_settings.get("input"), DEFAULT_INPUT_PATH)
    return resolve_setting_path(prompt_text("Input file", pretty_path(default)), default)


def determine_category(args: argparse.Namespace, profile_settings: dict[str, Any]) -> str:
    if args.category:
        return args.category.strip()
    return prompt_text("Component category", str(profile_settings.get("category") or DEFAULT_CATEGORY))


def determine_location(args: argparse.Namespace, profile_settings: dict[str, Any]) -> str:
    if args.location:
        return args.location.strip()
    return prompt_text("Location", str(profile_settings.get("location") or DEFAULT_LOCATION))


def derive_report_path(profile: str, dry_run: bool) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    mode = "dryrun" if dry_run else "live"
    return REPO_ROOT / f"component-batch-{profile}-{mode}-{stamp}.json"


def determine_report_path(args: argparse.Namespace, profile: str, dry_run: bool) -> Path:
    if args.report:
        return resolve_setting_path(args.report, derive_report_path(profile, dry_run))
    default = derive_report_path(profile, dry_run)
    return resolve_setting_path(prompt_text("Report file", pretty_path(default)), default)


def resolve_token() -> str:
    env_token = os.environ.get("SNIPEIT_API_TOKEN", "").strip()
    if env_token:
        return env_token

    while True:
        token = getpass.getpass("Snipe-IT API token: ").strip()
        if token:
            return token
        print("A token is required.")


def detect_delimiter(text: str) -> str:
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t")
        return dialect.delimiter
    except csv.Error:
        first_line = text.splitlines()[0] if text.splitlines() else ""
        return "\t" if first_line.count("\t") >= first_line.count(",") else ","


def load_batch_rows(path: Path) -> tuple[int, list[BatchRow], list[dict[str, Any]], list[dict[str, Any]]]:
    text = path.read_text(encoding="utf-8-sig")
    delimiter = detect_delimiter(text)
    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    if not reader.fieldnames:
        raise InputValidationError("Input file is missing headers.")

    normalized_headers = {str(name).strip(): name for name in reader.fieldnames}
    if "Name" not in normalized_headers or "Serial" not in normalized_headers:
        raise InputValidationError("Input file must contain Name and Serial headers.")

    rows: list[BatchRow] = []
    invalid_rows: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    seen_serials: dict[str, BatchRow] = {}

    parsed_rows = 0
    for index, raw_row in enumerate(reader, start=2):
        parsed_rows += 1
        name = cleaned_text(raw_row.get(normalized_headers["Name"]))
        serial = cleaned_text(raw_row.get(normalized_headers["Serial"]))

        reasons: list[str] = []
        if not name:
            reasons.append("Missing Name")
        if not serial:
            reasons.append("Missing Serial")
        if reasons:
            invalid_rows.append(
                {
                    "row_number": index,
                    "name": name,
                    "serial": serial,
                    "reason": "; ".join(reasons),
                }
            )
            continue

        row = BatchRow(row_number=index, name=name, serial=serial)
        existing = seen_serials.get(row.serial_key)
        if existing:
            duplicates.append(
                {
                    "serial": row.serial,
                    "first_row_number": existing.row_number,
                    "duplicate_row_number": row.row_number,
                }
            )
            continue

        seen_serials[row.serial_key] = row
        rows.append(row)

    return parsed_rows, rows, invalid_rows, duplicates


def normalize_category_type(value: Any) -> str:
    return cleaned_text(value).lower()


def normalize_name(value: Any) -> str:
    return cleaned_text(value).lower()


def ensure_component_category(
    client: SnipeClient,
    category_name: str,
    preview_only: bool,
    report: dict[str, Any],
) -> int | None:
    categories = client.get_all("categories")
    existing = {
        (normalize_name(row.get("name")), normalize_category_type(row.get("category_type"))): int(row["id"])
        for row in categories
    }
    key = (category_name.lower(), "component")
    if key in existing:
        report["category_resolution"] = {"name": category_name, "id": existing[key], "created": False}
        return existing[key]

    if preview_only:
        report["category_resolution"] = {"name": category_name, "id": None, "created": False, "would_create": True}
        return None

    response = client.post(
        "categories",
        {
            "name": category_name,
            "category_type": "component",
            "require_acceptance": False,
            "use_default_eula": False,
        },
    )
    category_id = get_payload_id(response)
    report["category_resolution"] = {"name": category_name, "id": category_id, "created": True}
    return category_id


def ensure_location(
    client: SnipeClient,
    location_name: str,
    preview_only: bool,
    report: dict[str, Any],
) -> int | None:
    locations = client.get_all("locations")
    existing = {normalize_name(row.get("name")): int(row["id"]) for row in locations}
    key = location_name.lower()
    if key in existing:
        report["location_resolution"] = {"name": location_name, "id": existing[key], "created": False}
        return existing[key]

    if preview_only:
        report["location_resolution"] = {"name": location_name, "id": None, "created": False, "would_create": True}
        return None

    response = client.post("locations", {"name": location_name})
    location_id = get_payload_id(response)
    report["location_resolution"] = {"name": location_name, "id": location_id, "created": True}
    return location_id


def build_existing_component_index(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    indexed: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        serial = cleaned_text(row.get("serial"))
        if not serial:
            continue
        indexed.setdefault(serial.upper(), []).append(
            {
                "id": row.get("id"),
                "name": cleaned_text(row.get("name")),
                "serial": serial,
                "location": cleaned_text(row.get("location", {}).get("name") if isinstance(row.get("location"), dict) else row.get("location")),
            }
        )
    return indexed


def build_note(source_file: Path, profile: str, row: BatchRow) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        f"Batch import source: {source_file.name}",
        f"Batch import profile: {profile}",
        f"Batch import row: {row.row_number}",
        f"Batch import timestamp: {timestamp}",
    ]
    return "\n".join(lines)


def prepare_report(
    profile: str,
    dry_run: bool,
    api_base: str,
    input_path: Path,
    category: str,
    location: str,
    report_path: Path,
) -> dict[str, Any]:
    return {
        "profile": profile,
        "dry_run": dry_run,
        "api_base": api_base,
        "input": str(input_path.resolve()),
        "category": category,
        "location": location,
        "report_path": str(report_path.resolve()),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "parsed_rows": 0,
        "create_candidates": 0,
        "created": 0,
        "skipped_existing_serials": [],
        "skipped_invalid_rows": [],
        "duplicate_input_serials": [],
        "planned_creations": [],
        "created_items": [],
        "errors": [],
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print("")
    print("Import summary")
    print(f"  Profile: {report['profile']}")
    print(f"  Mode: {'dry-run' if report['dry_run'] else 'live'}")
    print(f"  API base: {report['api_base']}")
    print(f"  Input: {report['input']}")
    print(f"  Category: {report['category']}")
    print(f"  Location: {report['location']}")
    print(f"  Parsed rows: {report['parsed_rows']}")
    print(f"  Invalid rows: {len(report['skipped_invalid_rows'])}")
    print(f"  Existing serials: {len(report['skipped_existing_serials'])}")
    print(f"  Create candidates: {report['create_candidates']}")
    print(f"  Report file: {report['report_path']}")


def require_live_confirmation(report: dict[str, Any]) -> None:
    print_summary(report)
    print("")
    confirmed = prompt_yes_no("Proceed with live import", default=False)
    if not confirmed:
        raise LiveConfirmationDeclined("Live import canceled by user.")


def collect_create_rows(
    client: SnipeClient,
    rows: list[BatchRow],
    report: dict[str, Any],
) -> list[BatchRow]:
    existing_components = client.get_all("components")
    existing_by_serial = build_existing_component_index(existing_components)

    create_rows: list[BatchRow] = []
    for row in rows:
        matches = existing_by_serial.get(row.serial_key)
        if matches:
            report["skipped_existing_serials"].append(
                {
                    "row_number": row.row_number,
                    "name": row.name,
                    "serial": row.serial,
                    "matches": matches,
                }
            )
            continue

        create_rows.append(row)

    report["create_candidates"] = len(create_rows)
    report["planned_creations"] = [
        {"row_number": row.row_number, "name": row.name, "serial": row.serial}
        for row in create_rows
    ]

    return create_rows


def create_components(
    client: SnipeClient,
    rows: list[BatchRow],
    profile: str,
    input_path: Path,
    category_id: int,
    location_id: int,
    report: dict[str, Any],
) -> int:
    report["created"] = 0
    report["created_items"] = []
    report["errors"] = []

    for row in rows:
        payload = {
            "name": row.name,
            "serial": row.serial,
            "qty": 1,
            "category_id": category_id,
            "location_id": location_id,
            "notes": build_note(input_path, profile, row),
        }
        try:
            response = client.post("components", payload)
            report["created"] += 1
            report["created_items"].append(
                {
                    "row_number": row.row_number,
                    "name": row.name,
                    "serial": row.serial,
                    "id": get_payload_id(response),
                }
            )
        except ApiError as exc:
            report["errors"].append(
                {
                    "stage": "create",
                    "row_number": row.row_number,
                    "name": row.name,
                    "serial": row.serial,
                    "message": str(exc),
                }
            )

    return 1 if report["errors"] else 0


def main() -> int:
    args = parse_args()
    settings = load_settings()
    profile = determine_profile(args, settings)
    profile_settings = settings.get("profiles", {}).get(profile, {})
    dry_run = determine_dry_run(args)
    api_base = determine_api_base(args, profile_settings)
    input_path = determine_input_path(args, profile_settings)
    category = determine_category(args, profile_settings)
    location = determine_location(args, profile_settings)
    report_path = determine_report_path(args, profile, dry_run)
    token = resolve_token()

    report = prepare_report(profile, dry_run, api_base, input_path, category, location, report_path)

    exit_code = 1
    completed = False
    try:
        if not input_path.exists():
            raise InputValidationError(f"Input file does not exist: {input_path}")

        parsed_rows, rows, invalid_rows, duplicates = load_batch_rows(input_path)
        report["parsed_rows"] = parsed_rows
        report["skipped_invalid_rows"] = invalid_rows
        report["duplicate_input_serials"] = duplicates

        if duplicates:
            raise InputValidationError("Duplicate serials were found in the input file. Aborting without API writes.")

        client = SnipeClient(api_base, token)
        category_id = ensure_component_category(client, category, True, report)
        location_id = ensure_location(client, location, True, report)
        create_rows = collect_create_rows(client, rows, report)

        if dry_run:
            exit_code = 0
        else:
            require_live_confirmation(report)
            category_id = ensure_component_category(client, category, False, report)
            location_id = ensure_location(client, location, False, report)
            if category_id is None or location_id is None:
                raise InputValidationError("Could not resolve category or location for live import.")
            exit_code = create_components(client, create_rows, profile, input_path, category_id, location_id, report)

        completed = exit_code == 0
    except LiveConfirmationDeclined as exc:
        report["errors"].append({"stage": "confirmation", "message": str(exc)})
        exit_code = 1
    except (ApiError, InputValidationError, OSError) as exc:
        report["errors"].append({"stage": "fatal", "message": str(exc)})
        exit_code = 1
    finally:
        write_report(report_path, report)

    print_summary(report)
    if report["duplicate_input_serials"]:
        print(f"  Duplicate input serials: {len(report['duplicate_input_serials'])}")
    if report["errors"]:
        print(f"  Errors: {len(report['errors'])}")
    else:
        print(f"  Created: {report['created']}")
    print("")
    print(f"Report written to {report_path}")

    if completed:
        save_settings(profile, api_base, input_path, category, location)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
