#!/usr/bin/env python3

import argparse
import hashlib
import html
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests


STATUS_TYPE_MAP = {
    "In Stock": "deployable",
    "In Use": "deployable",
    "Not Usable": "undeployable",
    "Davalık": "undeployable",
    "Sold": "archived",
}

PLACEHOLDER_ASSET_SERIALS = {
    "",
    "-",
    "N/A",
    "NA",
    "NONE",
    "NULL",
    "YOK",
}


class ApiError(RuntimeError):
    pass


class SnipeClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            }
        )

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        attempts = 0
        while True:
            resp = self.session.request(method, self._url(path), timeout=60, **kwargs)
            try:
                data = resp.json()
            except ValueError:
                data = {"status": "error", "messages": resp.text or f"HTTP {resp.status_code}"}

            if resp.status_code == 429 and attempts < 10:
                retry_after = 60
                if isinstance(data, dict):
                    retry_after = int(data.get("retryAfter") or retry_after)
                attempts += 1
                print(f"Rate limited on {method} {path}; sleeping {retry_after}s (attempt {attempts})", flush=True)
                time.sleep(retry_after)
                continue

            if resp.status_code >= 400:
                raise ApiError(f"{method} {path} failed with HTTP {resp.status_code}: {data}")

            if isinstance(data, dict) and data.get("status") == "error":
                raise ApiError(f"{method} {path} failed: {data.get('messages')}")

            return data

    def get_all(self, path: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            data = self.request("GET", path, params={"offset": offset})
            batch = data.get("rows", [])
            total = data.get("total", len(batch))
            rows.extend(batch)
            if not batch or len(rows) >= total:
                return rows
            offset += len(batch)

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", path, json=payload)


def load_token(token_file: Path) -> str:
    for line in token_file.read_text().splitlines():
        if line.startswith("SNIPEIT_API_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"Could not find SNIPEIT_API_TOKEN in {token_file}")


def load_rows(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text())


def cleaned_text(value: Any) -> str:
    return html.unescape(str(value or "")).strip()


def cleaned_asset_serial(value: Any) -> str | None:
    serial = cleaned_text(value)
    if not serial:
        return None
    if serial.upper() in PLACEHOLDER_ASSET_SERIALS:
        return None
    return serial


def parse_positive_int(value: Any) -> int | None:
    text = cleaned_text(value)
    if not text:
        return None
    try:
        parsed = int(text)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def parse_decimal_string(value: Any) -> str | None:
    text = cleaned_text(value)
    if not text:
        return None
    normalized = text.replace(",", "")
    try:
        float(normalized)
    except ValueError:
        return None
    return normalized


def component_source_key(row: dict[str, Any]) -> str:
    stable = {
        "Name": cleaned_text(row.get("Name")),
        "Serial": cleaned_text(row.get("Serial")),
        "Category": cleaned_text(row.get("Category")),
        "Total": cleaned_text(row.get("Total")),
        "Remaining": cleaned_text(row.get("Remaining")),
        "Min. QTY": cleaned_text(row.get("Min. QTY")),
        "Location": cleaned_text(row.get("Location")),
        "Order Number": cleaned_text(row.get("Order Number")),
        "Purchase Date": cleaned_text(row.get("Purchase Date")),
        "Purchase Cost": cleaned_text(row.get("Purchase Cost")),
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


def note_with_source_key(lines: list[str], source_key: str | None = None) -> str | None:
    body = [line for line in lines if line]
    if source_key:
        body.insert(0, f"Source key: {source_key}")
    return "\n".join(body) if body else None


def find_existing_source_keys(component_rows: list[dict[str, Any]]) -> set[str]:
    existing: set[str] = set()
    for row in component_rows:
        notes = cleaned_text(row.get("notes"))
        for line in notes.splitlines():
            if line.startswith("Source key: "):
                existing.add(line.split(": ", 1)[1].strip())
    return existing


def get_payload_id(data: dict[str, Any]) -> int:
    payload = data.get("payload")
    if isinstance(payload, dict) and payload.get("id") is not None:
        return int(payload["id"])
    raise RuntimeError(f"Could not determine id from response: {data}")


def ensure_categories(
    client: SnipeClient,
    rows: list[dict[str, Any]],
    wanted: list[tuple[str, str]],
    report: dict[str, Any],
) -> dict[tuple[str, str], int]:
    existing = {
        (cleaned_text(row.get("name")).lower(), cleaned_text(row.get("category_type")).lower()): int(row["id"])
        for row in rows
    }
    created = 0
    for name, category_type in wanted:
        key = (name.lower(), category_type.lower())
        if key in existing:
            continue
        resp = client.post(
            "categories",
            {
                "name": name,
                "category_type": category_type,
                "require_acceptance": False,
                "use_default_eula": False,
            },
        )
        existing[key] = get_payload_id(resp)
        created += 1
    report["created_categories"] = created
    return existing


def ensure_locations(
    client: SnipeClient,
    rows: list[dict[str, Any]],
    wanted: list[str],
    report: dict[str, Any],
) -> dict[str, int]:
    existing = {cleaned_text(row.get("name")).lower(): int(row["id"]) for row in rows}
    created = 0
    for name in wanted:
        key = name.lower()
        if key in existing:
            continue
        resp = client.post("locations", {"name": name})
        existing[key] = get_payload_id(resp)
        created += 1
    report["created_locations"] = created
    return existing


def ensure_statuslabels(
    client: SnipeClient,
    rows: list[dict[str, Any]],
    wanted: dict[str, str],
    report: dict[str, Any],
) -> dict[str, int]:
    existing = {cleaned_text(row.get("name")).lower(): int(row["id"]) for row in rows}
    created = 0
    for name, status_type in wanted.items():
        key = name.lower()
        if key in existing:
            continue
        resp = client.post("statuslabels", {"name": name, "type": status_type})
        existing[key] = get_payload_id(resp)
        created += 1
    report["created_statuslabels"] = created
    return existing


def ensure_models(
    client: SnipeClient,
    existing_rows: list[dict[str, Any]],
    assets_rows: list[dict[str, Any]],
    asset_category_ids: dict[tuple[str, str], int],
    report: dict[str, Any],
) -> dict[str, int]:
    existing = {cleaned_text(row.get("name")).lower(): int(row["id"]) for row in existing_rows}
    created = 0
    wanted = []
    seen = set()
    for row in assets_rows:
        model_name = cleaned_text(row.get("Model"))
        category_name = cleaned_text(row.get("Category"))
        if not model_name or not category_name:
            continue
        key = model_name.lower()
        if key in seen:
            continue
        seen.add(key)
        wanted.append((model_name, category_name))

    for model_name, category_name in wanted:
        key = model_name.lower()
        if key in existing:
            continue
        category_id = asset_category_ids[(category_name.lower(), "asset")]
        resp = client.post("models", {"name": model_name, "category_id": category_id})
        existing[key] = get_payload_id(resp)
        created += 1
    report["created_models"] = created
    return existing


def import_assets(
    client: SnipeClient,
    existing_rows: list[dict[str, Any]],
    assets_rows: list[dict[str, Any]],
    model_ids: dict[str, int],
    location_ids: dict[str, int],
    status_ids: dict[str, int],
    report: dict[str, Any],
) -> None:
    existing_asset_tags = {cleaned_text(row.get("asset_tag")) for row in existing_rows}
    existing_serials = {
        cleaned_text(row.get("serial"))
        for row in existing_rows
        if cleaned_text(row.get("serial"))
    }

    source_serial_counts: dict[str, int] = {}
    for row in assets_rows:
        serial = cleaned_asset_serial(row.get("Serial"))
        if serial:
            source_serial_counts[serial] = source_serial_counts.get(serial, 0) + 1

    created = 0
    skipped_existing = 0
    assigned_locations = 0
    omitted_serials = 0
    errors: list[dict[str, Any]] = []

    for index, row in enumerate(assets_rows, start=1):
        asset_tag = cleaned_text(row.get("Asset Tag"))
        if asset_tag in existing_asset_tags:
            skipped_existing += 1
            continue

        model_name = cleaned_text(row.get("Model"))
        status_name = cleaned_text(row.get("Status"))
        location_name = cleaned_text(row.get("Location"))
        checked_out_to = cleaned_text(row.get("Checked Out To"))

        payload: dict[str, Any] = {
            "asset_tag": asset_tag,
            "model_id": model_ids[model_name.lower()],
            "status_id": status_ids[status_name.lower()],
        }

        if location_name:
            payload["location_id"] = location_ids[location_name.lower()]

        asset_name = cleaned_text(row.get("Asset Name"))
        if asset_name:
            payload["name"] = asset_name

        serial = cleaned_asset_serial(row.get("Serial"))
        notes: list[str] = []
        if serial:
            if source_serial_counts.get(serial, 0) > 1 or serial in existing_serials:
                omitted_serials += 1
                notes.append(f"Source serial not imported because it is duplicated: {serial}")
            else:
                payload["serial"] = serial
                existing_serials.add(serial)
        elif cleaned_text(row.get("Serial")):
            omitted_serials += 1
            notes.append(f"Source serial not imported because it is a placeholder: {cleaned_text(row.get('Serial'))}")

        purchase_cost = parse_decimal_string(row.get("Purchase Cost"))
        if purchase_cost:
            payload["purchase_cost"] = purchase_cost

        current_value = parse_decimal_string(row.get("Current Value"))
        if current_value:
            notes.append(f"Source current value: {current_value}")

        if checked_out_to and status_name == "In Use" and checked_out_to.lower() in location_ids:
            payload["assigned_location"] = location_ids[checked_out_to.lower()]
            assigned_locations += 1
        elif checked_out_to:
            notes.append(f"Source checked out to: {checked_out_to}")

        note = note_with_source_key(notes)
        if note:
            payload["notes"] = note

        try:
            client.post("hardware", payload)
            existing_asset_tags.add(asset_tag)
            created += 1
            if index % 100 == 0:
                print(f"Imported {created} assets...", flush=True)
        except Exception as exc:  # noqa: BLE001
            errors.append({"asset_tag": asset_tag, "error": str(exc)})

    report["assets"] = {
        "created": created,
        "skipped_existing": skipped_existing,
        "assigned_locations": assigned_locations,
        "omitted_serials": omitted_serials,
        "errors": errors,
    }


def import_components(
    client: SnipeClient,
    existing_rows: list[dict[str, Any]],
    component_rows: list[dict[str, Any]],
    component_category_ids: dict[tuple[str, str], int],
    location_ids: dict[str, int],
    report: dict[str, Any],
) -> None:
    existing_source_keys = find_existing_source_keys(existing_rows)

    created = 0
    skipped_existing = 0
    skipped_zero_remaining = 0
    imported_qty = 0
    errors: list[dict[str, Any]] = []

    for index, row in enumerate(component_rows, start=1):
        source_key = component_source_key(row)
        if source_key in existing_source_keys:
            skipped_existing += 1
            continue

        remaining = parse_positive_int(row.get("Remaining"))
        total = parse_positive_int(row.get("Total"))
        if remaining is None:
            remaining = 0
        if total is None:
            total = remaining

        if remaining <= 0:
            skipped_zero_remaining += 1
            continue

        name = cleaned_text(row.get("Name"))
        category_name = cleaned_text(row.get("Category"))
        location_name = cleaned_text(row.get("Location"))

        payload: dict[str, Any] = {
            "name": name,
            "category_id": component_category_ids[(category_name.lower(), "component")],
            "qty": remaining,
        }

        serial = cleaned_text(row.get("Serial"))
        if serial:
            payload["serial"] = serial

        min_qty = parse_positive_int(row.get("Min. QTY"))
        if min_qty is not None:
            payload["min_amt"] = min_qty

        if location_name:
            payload["location_id"] = location_ids[location_name.lower()]

        order_number = cleaned_text(row.get("Order Number"))
        if order_number:
            payload["order_number"] = order_number

        purchase_date = cleaned_text(row.get("Purchase Date"))
        if purchase_date:
            payload["purchase_date"] = purchase_date

        purchase_cost = parse_decimal_string(row.get("Purchase Cost"))
        if purchase_cost:
            payload["purchase_cost"] = purchase_cost

        notes = [
            f"Source total: {total}",
            f"Source remaining: {remaining}",
        ]
        if total != remaining:
            notes.append("Assigned/consumed quantity is not represented because source assignment targets were not provided.")
        payload["notes"] = note_with_source_key(notes, source_key=source_key)

        try:
            client.post("components", payload)
            existing_source_keys.add(source_key)
            created += 1
            imported_qty += remaining
            if index % 200 == 0:
                print(f"Imported {created} components...", flush=True)
        except Exception as exc:  # noqa: BLE001
            errors.append({"name": name, "serial": serial, "error": str(exc)})

    report["components"] = {
        "created": created,
        "skipped_existing": skipped_existing,
        "skipped_zero_remaining": skipped_zero_remaining,
        "imported_qty_sum": imported_qty,
        "errors": errors,
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Import assets and components JSON into Snipe-IT.")
    parser.add_argument("--api-base", default="http://127.0.0.1:8000/api/v1")
    parser.add_argument("--token-file", default="/opt/snipeit/.automation-api-token")
    parser.add_argument("--assets", default=str(repo_root / "data" / "assets_all.json"))
    parser.add_argument("--components", default=str(repo_root / "data" / "components_all.json"))
    parser.add_argument(
        "--report",
        default=str(repo_root / "data" / "snipe_import_report.json"),
    )
    args = parser.parse_args()

    token = load_token(Path(args.token_file))
    client = SnipeClient(args.api_base, token)

    assets_rows = load_rows(Path(args.assets))
    component_rows = load_rows(Path(args.components))

    report: dict[str, Any] = {
        "api_base": args.api_base,
        "source_files": {
            "assets": args.assets,
            "components": args.components,
        },
        "source_counts": {
            "assets": len(assets_rows),
            "components": len(component_rows),
        },
        "backup_hint": "/var/lib/snipeit/dumps/pre_inventory_import_2026-04-09.zip",
    }

    existing_categories = client.get_all("categories")
    existing_statuslabels = client.get_all("statuslabels")
    existing_locations = client.get_all("locations")
    existing_models = client.get_all("models")
    existing_assets = client.get_all("hardware")
    existing_components = client.get_all("components")

    asset_category_names = sorted(
        {cleaned_text(row.get("Category")) for row in assets_rows if cleaned_text(row.get("Category"))}
    )
    component_category_names = sorted(
        {cleaned_text(row.get("Category")) for row in component_rows if cleaned_text(row.get("Category"))}
    )
    location_names = sorted(
        {
            cleaned_text(value)
            for row in assets_rows + component_rows
            for value in [row.get("Location")]
            if cleaned_text(value)
        }
    )

    category_ids = ensure_categories(
        client,
        existing_categories,
        [(name, "asset") for name in asset_category_names]
        + [(name, "component") for name in component_category_names],
        report,
    )
    location_ids = ensure_locations(client, existing_locations, location_names, report)
    status_ids = ensure_statuslabels(client, existing_statuslabels, STATUS_TYPE_MAP, report)
    model_ids = ensure_models(client, existing_models, assets_rows, category_ids, report)

    import_assets(client, existing_assets, assets_rows, model_ids, location_ids, status_ids, report)
    import_components(client, existing_components, component_rows, category_ids, location_ids, report)

    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    asset_errors = len(report["assets"]["errors"])
    component_errors = len(report["components"]["errors"])
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if asset_errors or component_errors else 0


if __name__ == "__main__":
    sys.exit(main())
