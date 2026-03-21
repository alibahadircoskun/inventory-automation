const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

const ZAI_API_URL = process.env.AI_API_URL || 'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions';
let apiKeyCursor = 0;

function normalizeToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeServerLabelCandidate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function formatCompactNumber(value, maxDecimals = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const fixed = numeric.toFixed(maxDecimals);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
}

function normalizeCapacityValue(value) {
  const text = normalizeWhitespace(value).toUpperCase().replace(',', '.');
  const match = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/);
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return `${formatCompactNumber(amount, 2)}${match[2]}`;
}

function normalizeDiskRpmValue(value) {
  const text = normalizeWhitespace(value).toUpperCase().replace(',', '.');
  if (!text) return '';

  const kMatch = text.match(/(\d+(?:\.\d+)?)\s*K(?:\s*RPM)?\b/);
  if (kMatch) {
    return `${formatCompactNumber(kMatch[1], 1)}K`;
  }

  const rpmMatch = text.match(/(\d{4,5})(?:\s*RPM)?\b/);
  if (!rpmMatch) return '';

  const rpm = Number(rpmMatch[1]);
  if (!Number.isFinite(rpm) || rpm < 3600 || rpm > 20000) return '';
  return `${formatCompactNumber(rpm / 1000, 1)}K`;
}

function normalizeDiskFormFactorValue(value) {
  const text = normalizeWhitespace(value).toUpperCase().replace(/&QUOT;/g, '"');
  if (/2(?:[.,]5)/.test(text)) return '2.5"';
  if (/3(?:[.,]5)/.test(text)) return '3.5"';
  return '';
}

function looksOpaquePartCode(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;

  const compact = text.replace(/[^A-Z0-9]/gi, '');
  if (compact.length < 8) return false;

  const hasLetters = /[A-Z]/i.test(compact);
  const hasDigits = /\d/.test(compact);
  if (!hasLetters || !hasDigits) return false;

  const words = text.split(/\s+/);
  if (words.length === 1) return true;
  return words.length <= 2 && /[-_/]/.test(text) && compact.length >= 10;
}

function scoreDiskCandidate(candidateName, signals) {
  const normalizedName = normalizeToken(candidateName);
  const normalizedCapacity = normalizeToken(normalizeCapacityValue(candidateName));
  const normalizedRpm = normalizeToken(normalizeDiskRpmValue(candidateName));
  const normalizedFormFactor = normalizeToken(normalizeDiskFormFactorValue(candidateName));

  let score = 0;
  if (signals.manufacturerToken && normalizedName.includes(signals.manufacturerToken)) score += 1;
  if (signals.capacityToken && (signals.capacityToken === normalizedCapacity || normalizedName.includes(signals.capacityToken))) score += 2;
  if (signals.rpmToken && (signals.rpmToken === normalizedRpm || normalizedName.includes(signals.rpmToken))) score += 2;
  if (signals.formFactorToken && (signals.formFactorToken === normalizedFormFactor || normalizedName.includes(signals.formFactorToken))) score += 1;
  if (signals.modelToken && normalizedName.includes(signals.modelToken)) score += signals.modelWeight;
  return score;
}

function isValidServerLabel(value) {
  return /^[A-Z0-9]{4,12}$/.test(String(value || ''));
}

function countFilledFields(source, keys) {
  return keys.reduce((total, key) => total + (String(source?.[key] || '').trim() ? 1 : 0), 0);
}

function getComponentSignalCount(source, hardwareType) {
  if (hardwareType === 'ram') {
    return countFilledFields(source, ['manufacturer', 'capacity', 'memoryType', 'speed', 'rank', 'partNumber']);
  }
  if (hardwareType === 'nic') {
    return countFilledFields(source, ['manufacturer', 'model', 'speed', 'ports', 'interface', 'serial', 'partNumber']);
  }
  if (hardwareType === 'cpu') {
    return countFilledFields(source, ['manufacturer', 'model', 'frequency', 'cores', 'socket', 'partNumber']);
  }
  return countFilledFields(source, ['manufacturer', 'model', 'capacity', 'serial', 'rpm', 'formFactor']);
}

function getConfiguredApiKeys() {
  const keys = [];
  const seen = new Set();
  const addKey = value => {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  String(process.env.AI_API_KEYS || '')
    .split(',')
    .forEach(addKey);
  addKey(process.env.AI_API_KEY);

  return keys;
}

const SYSTEM_PROMPT = `You are an OCR assistant specialized in reading hardware labels and short server/rack tags.
Always read both:
1) component label details (disk/ram/nic/cpu)
2) possible short server label (often vertical text near rack rails, e.g. PD2823)

Set "resultKind":
- "component" for normal hardware extraction
- "server_label" when the image is mainly a short rack/server tag

If you detect a short server label, return it in "serverLabel" as uppercase letters/numbers only.

Determine hardwareType:
- "disk" for hard drives, SSDs, NVMe drives
- "ram" for memory modules (DIMMs, SO-DIMMs)
- "nic" for network interface cards / Ethernet adapters
- "cpu" for processors / CPUs

For DISK labels, extract:
- manufacturer: Brand name (e.g. SEAGATE, WD, TOSHIBA, SAMSUNG, INTEL, MICRON, KINGSTON, CRUCIAL, HGST, HITACHI, DELL, HP, HPE, SANDISK, KIOXIA, SK HYNIX)
- model: Model or part number (e.g. ST4000DM004, WD40EFZX)
- capacity: Storage capacity with unit (e.g. "500GB", "2TB", "4TB")
- serial: Serial number
- rpm: RPM speed if present (e.g. "7200RPM", "5.4K", "5400RPM"). Empty for SSDs.
- formFactor: Form factor if visible ("2.5\\"" or "3.5\\"")

For RAM labels, extract:
- manufacturer: Brand (SAMSUNG, SK HYNIX, MICRON, KINGSTON, CRUCIAL, etc.)
- capacity: Memory size (e.g. "8GB", "16GB", "32GB", "64GB")
- memoryType: DDR generation (e.g. "DDR3", "DDR4", "DDR5"). Derive from PC designation if not explicit (PC3/PC3L=DDR3, PC4=DDR4, PC5=DDR5).
- speed: Speed rating from the label (e.g. "2133P", "2400T", "2666", "3200", "12800R", "10600E")
- rank: Rank configuration if visible (e.g. "1Rx8", "2Rx4", "2Rx8", "4DRx4")
- partNumber: Part/model number (e.g. "M391A1G43DB0-CPB0")

For NIC labels, extract:
- manufacturer: Brand (e.g. INTEL, BROADCOM, MELLANOX, NVIDIA, CHELSIO, QLOGIC, EMULEX, HP, HPE, DELL)
- model: Model name or number (e.g. X710-DA2, BCM5720, ConnectX-4, 82599ES)
- speed: Network speed (e.g. "1GbE", "10GbE", "25GbE", "40GbE", "100GbE")
- ports: Number of ports if visible (e.g. "2-port", "4-port", "Dual Port")
- interface: Bus interface if visible (e.g. "PCIe 3.0 x8", "OCP 3.0", "PCIE")
- serial: Serial number if present
- partNumber: Part number (e.g. "E10G42BTDAG", "BCM957412A4120C")

For CPU labels, extract:
- manufacturer: Brand (INTEL, AMD)
- model: Full processor name or model (e.g. "Xeon Gold 6254", "EPYC 7742", "Core i9-13900K")
- frequency: Clock speed (e.g. "3.1GHz", "2.25GHz", "3.7GHz")
- cores: Core count if visible (e.g. "18-core", "64 Cores", "8C")
- socket: Socket type if visible (e.g. "LGA4189", "SP3", "AM5", "LGA1700")
- partNumber: Part/spec number (e.g. "CD8069504194401", "100-000000053")

Return ONLY a valid JSON object with these keys:
{
  "resultKind":"component|server_label",
  "serverLabel":"",
  "hardwareType":"disk|ram|nic|cpu",
  "manufacturer":"",
  "model":"",
  "capacity":"",
  "serial":"",
  "rpm":"",
  "formFactor":"",
  "memoryType":"",
  "speed":"",
  "rank":"",
  "partNumber":"",
  "frequency":"",
  "cores":"",
  "socket":"",
  "ports":"",
  "interface":""
}
Use empty string "" for unknown fields.`;

router.post('/', async (req, res) => {
  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Görsel verisi gönderilmedi' });
  }

  const apiKeys = getConfiguredApiKeys();
  if (!apiKeys.length) {
    return res.status(500).json({ error: 'AI_API_KEY veya AI_API_KEYS tanımlı değil' });
  }

  try {
    let data = null;
    let content = '{}';
    const startIndex = apiKeyCursor % apiKeys.length;

    for (let offset = 0; offset < apiKeys.length; offset += 1) {
      const keyIndex = (startIndex + offset) % apiKeys.length;
      const apiKey = apiKeys[keyIndex];

      const response = await fetch(ZAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept-Language': 'en-US,en'
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'qwen-vl-max',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: image } },
                { type: 'text', text: 'Read this image and extract hardware fields or short server label as JSON.' }
              ]
            }
          ],
          temperature: 0.1,
          max_tokens: 512,
          response_format: { type: 'json_object' }
        })
      });

      if (response.ok) {
        data = await response.json();
        content = data.choices?.[0]?.message?.content || '{}';
        apiKeyCursor = keyIndex;
        break;
      }

      const errText = await response.text();
      console.error('AI API error:', response.status, errText);

      if (response.status === 429 && offset < apiKeys.length - 1) {
        apiKeyCursor = (keyIndex + 1) % apiKeys.length;
        console.warn('AI API key rate-limited, rotating to next key.');
        continue;
      }

      if (response.status === 429) {
        return res.status(502).json({ error: 'AI API hatası: 429 (tanımlı tüm API anahtarları kota sınırına takıldı)' });
      }

      return res.status(502).json({ error: `AI API hatası: ${response.status}` });
    }

    if (!data) {
      return res.status(502).json({ error: 'AI API isteği başarısız oldu' });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try to extract JSON from the response text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    }

    const rawType = String(parsed.hardwareType || 'disk').toLowerCase();
    const hardwareType = ['ram', 'disk', 'nic', 'cpu'].includes(rawType) ? rawType : 'disk';

    let result;
    if (hardwareType === 'ram') {
      result = {
        hardwareType: 'ram',
        manufacturer: parsed.manufacturer || '',
        capacity: parsed.capacity || '',
        memoryType: parsed.memoryType || '',
        speed: parsed.speed || '',
        rank: parsed.rank || '',
        partNumber: parsed.partNumber || '',
        raw: content
      };

      // Look up RAM in inventory by matching attributes against component names
      const capacityToken = normalizeToken(result.capacity);
      const memoryTypeToken = normalizeToken(result.memoryType);
      const speedToken = normalizeToken(result.speed);
      const rankToken = normalizeToken(result.rank);

      if (capacityToken || memoryTypeToken || speedToken || rankToken) {
        const db = getDb();
        const candidates = db.prepare(
          "SELECT name, category, total, remaining, location FROM inventory_components WHERE UPPER(category) = 'RAM'"
        ).all()
          .map(candidate => ({
            ...candidate,
            normalizedName: normalizeToken(candidate.name)
          }))
          .filter(candidate => !capacityToken || candidate.normalizedName.includes(capacityToken))
          .map(candidate => ({
            ...candidate,
            score: [memoryTypeToken, speedToken, rankToken]
              .filter(Boolean)
              .reduce((total, token) => total + (candidate.normalizedName.includes(token) ? 1 : 0), 0)
          }))
          .sort((a, b) => b.score - a.score || a.name.length - b.name.length);

        const best = candidates[0];
        const second = candidates[1];
        const confidentMatch = candidates.length === 1
          || (best && best.score > 0 && (!second || best.score > second.score));

        if (confidentMatch && best) {
          result.inventoryMatch = {
            source: 'components',
            name: decodeHtmlEntities(best.name),
            category: best.category,
            location: best.location
          };
        }
      }
    } else if (hardwareType === 'nic') {
      result = {
        hardwareType: 'nic',
        manufacturer: parsed.manufacturer || '',
        model: parsed.model || '',
        speed: parsed.speed || '',
        ports: parsed.ports || '',
        interface: parsed.interface || '',
        serial: parsed.serial || '',
        partNumber: parsed.partNumber || '',
        raw: content
      };

      // Look up NIC in inventory by model or partNumber
      const modelToken = normalizeToken(result.model);
      const partToken = normalizeToken(result.partNumber);
      const serialToken = result.serial.trim();

      const db = getDb();
      if (serialToken) {
        const comp = db.prepare(
          'SELECT name, serial, category, location FROM inventory_components WHERE UPPER(serial) = UPPER(?) LIMIT 1'
        ).get(serialToken);
        if (comp) {
          result.inventoryMatch = { source: 'components', name: decodeHtmlEntities(comp.name), serial: comp.serial, category: comp.category, location: comp.location };
        }
      }
      if (!result.inventoryMatch && (modelToken || partToken)) {
        const candidates = db.prepare(
          "SELECT name, category, location FROM inventory_components WHERE UPPER(category) = 'NIC'"
        ).all()
          .map(c => ({ ...c, n: normalizeToken(c.name) }))
          .map(c => ({
            ...c,
            score: [modelToken, partToken].filter(Boolean)
              .reduce((s, t) => s + (c.n.includes(t) ? 1 : 0), 0)
          }))
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score || a.name.length - b.name.length);

        if (candidates[0]) {
          result.inventoryMatch = { source: 'components', name: decodeHtmlEntities(candidates[0].name), category: candidates[0].category, location: candidates[0].location };
        }
      }
    } else if (hardwareType === 'cpu') {
      result = {
        hardwareType: 'cpu',
        manufacturer: parsed.manufacturer || '',
        model: parsed.model || '',
        frequency: parsed.frequency || '',
        cores: parsed.cores || '',
        socket: parsed.socket || '',
        partNumber: parsed.partNumber || '',
        raw: content
      };

      // Look up CPU in inventory by model or partNumber
      const modelToken = normalizeToken(result.model);
      const partToken = normalizeToken(result.partNumber);

      if (modelToken || partToken) {
        const db = getDb();
        const candidates = db.prepare(
          "SELECT name, category, location FROM inventory_components WHERE UPPER(category) = 'CPU'"
        ).all()
          .map(c => ({ ...c, n: normalizeToken(c.name) }))
          .map(c => ({
            ...c,
            score: [modelToken, partToken].filter(Boolean)
              .reduce((s, t) => s + (c.n.includes(t) ? 1 : 0), 0)
          }))
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score || a.name.length - b.name.length);

        if (candidates[0]) {
          result.inventoryMatch = { source: 'components', name: decodeHtmlEntities(candidates[0].name), category: candidates[0].category, location: candidates[0].location };
        }
      }
    } else {
      result = {
        hardwareType: 'disk',
        manufacturer: parsed.manufacturer || '',
        model: parsed.model || '',
        capacity: parsed.capacity || '',
        serial: parsed.serial || '',
        rpm: parsed.rpm || '',
        formFactor: parsed.formFactor || '',
        raw: content
      };

      const db = getDb();

      // Look up serial in inventory databases
      const serial = result.serial.trim();
      if (serial) {
        const asset = db.prepare(
          'SELECT asset_tag, serial, model, category, status, location FROM inventory_assets WHERE UPPER(serial) = UPPER(?) LIMIT 1'
        ).get(serial);
        if (asset) {
          result.inventoryMatch = {
            source: 'assets',
            assetTag: asset.asset_tag,
            serial: asset.serial,
            model: asset.model,
            category: asset.category,
            status: asset.status,
            location: asset.location
          };
        } else {
          const comp = db.prepare(
            'SELECT name, serial, category, location FROM inventory_components WHERE UPPER(serial) = UPPER(?) LIMIT 1'
          ).get(serial);
          if (comp) {
            result.inventoryMatch = {
              source: 'components',
              name: decodeHtmlEntities(comp.name),
              serial: comp.serial,
              category: comp.category,
              location: comp.location
            };
          }
        }
      }

      // Fuzzy match unknown disks to inventory component names
      if (!result.inventoryMatch) {
        const signals = {
          manufacturerToken: normalizeToken(result.manufacturer),
          capacityToken: normalizeToken(normalizeCapacityValue(result.capacity)),
          rpmToken: normalizeToken(normalizeDiskRpmValue(result.rpm)),
          formFactorToken: normalizeToken(normalizeDiskFormFactorValue(result.formFactor)),
          modelToken: normalizeToken(result.model),
          modelWeight: looksOpaquePartCode(result.model) ? 0.5 : 1
        };

        const hasSignals = Boolean(
          signals.manufacturerToken
          || signals.capacityToken
          || signals.rpmToken
          || signals.formFactorToken
          || signals.modelToken
        );

        if (hasSignals) {
          const candidates = db.prepare(`
            SELECT name, category, location
            FROM inventory_components
            WHERE UPPER(category) LIKE '%DISK%'
              OR UPPER(category) LIKE '%SSD%'
              OR UPPER(category) LIKE '%HDD%'
              OR UPPER(category) LIKE '%NVME%'
              OR UPPER(category) LIKE '%SAS%'
              OR UPPER(category) LIKE '%SATA%'
          `).all()
            .map((candidate, index) => ({
              ...candidate,
              score: scoreDiskCandidate(candidate.name, signals),
              dedupeKey: normalizeToken(candidate.name),
              sourceIndex: index
            }))
            .filter(candidate => candidate.score > 0);

          const bestByName = new Map();
          candidates.forEach((candidate) => {
            const key = candidate.dedupeKey || normalizeToken(candidate.name);
            if (!key) return;
            const current = bestByName.get(key);
            if (!current) {
              bestByName.set(key, candidate);
              return;
            }

            const isHigherScore = candidate.score > current.score;
            const isShorterOnTie = candidate.score === current.score && candidate.name.length < current.name.length;
            const isEarlierOnFullTie = candidate.score === current.score
              && candidate.name.length === current.name.length
              && candidate.sourceIndex < current.sourceIndex;
            if (isHigherScore || isShorterOnTie || isEarlierOnFullTie) {
              bestByName.set(key, candidate);
            }
          });

          const dedupedCandidates = Array.from(bestByName.values())
            .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.sourceIndex - b.sourceIndex);

          const best = dedupedCandidates[0];
          const second = dedupedCandidates[1];
          const confidentMatch = best
            && best.score >= 3
            && (!second || best.score > second.score);

          if (confidentMatch) {
            result.inventoryMatch = {
              source: 'components',
              name: decodeHtmlEntities(best.name),
              category: best.category,
              location: best.location
            };
          }
        }
      }
    }

    const rawResultKind = String(parsed.resultKind || parsed.result_kind || '').toLowerCase();
    const modelSaysServerLabel = rawResultKind === 'server_label' || rawResultKind === 'serverlabel';
    const serverLabelCandidate = [
      parsed.serverLabel,
      parsed.server_label,
      parsed.serverTag,
      parsed.server_tag,
      parsed.assetTag,
      parsed.asset_tag,
      parsed.label,
      parsed.tag,
      parsed.serial,
      parsed.model,
      parsed.partNumber
    ]
      .map(normalizeServerLabelCandidate)
      .find(isValidServerLabel) || '';
    const validServerLabel = isValidServerLabel(serverLabelCandidate);
    const weakComponent = getComponentSignalCount(result, hardwareType) === 0;

    result.resultKind = validServerLabel && (modelSaysServerLabel || weakComponent)
      ? 'server_label'
      : 'component';
    result.serverLabel = validServerLabel ? serverLabelCandidate : '';

    if (validServerLabel) {
      const db = getDb();
      const assetByTag = db.prepare(
        'SELECT asset_tag, serial, model, category, status, location FROM inventory_assets WHERE UPPER(asset_tag) = UPPER(?) LIMIT 1'
      ).get(serverLabelCandidate);
      if (assetByTag) {
        result.assetMatchByTag = {
          assetTag: assetByTag.asset_tag,
          serial: assetByTag.serial,
          model: assetByTag.model,
          category: assetByTag.category,
          status: assetByTag.status,
          location: assetByTag.location
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Metin tanıma işleme hatası:', err);
    res.status(500).json({ error: 'Metin tanıma işleme hatası: ' + err.message });
  }
});

module.exports = router;
