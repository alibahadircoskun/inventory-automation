const express = require('express');
const { getDb } = require('../db');
const { activeSessions } = require('../middleware/auth');
const router = express.Router();

let apiKeyCursor = 0;
const keyUsageLog = new Map(); // apiKey → [timestamp, ...]
const FREE_TIER_RPM = 5;

const AI_PROVIDERS = {
  gemini: {
    url: process.env.AI_API_URL,
    key: process.env.AI_API_KEY,
    freeKeys: (process.env.AI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
    model: process.env.AI_MODEL || 'gemini-2.5-flash',
  }
};

function isKeyAvailable(apiKey) {
  const log = keyUsageLog.get(apiKey);
  if (!log || !log.length) return true;
  const oneMinuteAgo = Date.now() - 60000;
  while (log.length && log[0] <= oneMinuteAgo) log.shift();
  return log.length < FREE_TIER_RPM;
}

function recordKeyUsage(apiKey) {
  if (!keyUsageLog.has(apiKey)) keyUsageLog.set(apiKey, []);
  keyUsageLog.get(apiKey).push(Date.now());
}

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

function normalizeDiskBusValue(value) {
  const text = normalizeWhitespace(value).toUpperCase();
  if (!text) return '';
  if (/\bNVME\b|\bNVM[\s-]?E\b/.test(text)) return 'NVME';
  if (/\bSATA\b/.test(text)) return 'SATA';
  if (/\bSAS\b/.test(text)) return 'SAS';
  if (/\bSSD\b/.test(text)) return 'SSD';
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

function inferDiskBusFromModelCode(value) {
  const model = normalizeWhitespace(value);
  if (!model || !looksOpaquePartCode(model)) return '';
  const compact = normalizeToken(model);
  if (!compact) return '';
  return compact.endsWith('SS') ? 'SAS' : '';
}

function scoreDiskCandidate(candidateText, signals) {
  const normalizedText = normalizeToken(candidateText);
  const normalizedCapacity = normalizeToken(normalizeCapacityValue(candidateText));
  const normalizedRpm = normalizeToken(normalizeDiskRpmValue(candidateText));
  const normalizedFormFactor = normalizeToken(normalizeDiskFormFactorValue(candidateText));
  const normalizedBus = normalizeToken(normalizeDiskBusValue(candidateText));

  let score = 0;
  if (signals.manufacturerToken && normalizedText.includes(signals.manufacturerToken)) score += 1;
  if (signals.capacityToken && (signals.capacityToken === normalizedCapacity || normalizedText.includes(signals.capacityToken))) score += 2;
  if (signals.rpmToken && (signals.rpmToken === normalizedRpm || normalizedText.includes(signals.rpmToken))) score += 2;
  if (signals.formFactorToken && (signals.formFactorToken === normalizedFormFactor || normalizedText.includes(signals.formFactorToken))) score += 1;
  if (signals.busToken && (signals.busToken === normalizedBus || normalizedText.includes(signals.busToken))) score += 1;
  if (signals.modelToken && normalizedText.includes(signals.modelToken)) score += signals.modelWeight;
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

function parseRetryDelay(errorBody) {
  const match = String(errorBody).match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : 60000;
}

function parseStructuredJson(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const jsonMatch = String(content || '').match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

function logAiUsage({ model, apiKeyIndex, keyType, usage, success, statusCode, responseTimeMs, username }) {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO ai_usage_log (model, api_key_index, key_type, prompt_tokens, completion_tokens, total_tokens, success, status_code, response_time_ms, username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      model || process.env.AI_MODEL || 'unknown',
      apiKeyIndex ?? -1,
      keyType || 'unknown',
      usage?.prompt_tokens || 0,
      usage?.completion_tokens || 0,
      usage?.total_tokens || 0,
      success ? 1 : 0,
      statusCode || null,
      responseTimeMs || null,
      username || ''
    );
  } catch (e) {
    console.error('[OCR] failed to log usage:', e.message);
  }
}

async function callAiOcrOnce(image, apiKey, providerConfig) {
  const response = await fetch(providerConfig.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept-Language': 'en-US,en'
    },
    body: JSON.stringify({
      model: providerConfig.model,
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
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' }
    })
  });
  return response;
}

// Lightweight probe to check if a key has quota — uses minimal tokens
async function probeKeyQuota(apiKey, providerConfig) {
  try {
    const response = await fetch(providerConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      })
    });
    if (response.status === 429) return false;
    // Consume body to free connection
    await response.text().catch(() => {});
    return true;
  } catch {
    return true; // Network error — assume available, real call will handle it
  }
}

// On startup, probe all free keys to discover which are alive
async function discoverAvailableKeys() {
  const freeKeys = AI_PROVIDERS.gemini.freeKeys;
  if (!freeKeys.length) return;
  console.log(`[OCR] probing ${freeKeys.length} free keys...`);
  const results = await Promise.all(freeKeys.map(async (key, i) => {
    const ok = await probeKeyQuota(key, AI_PROVIDERS.gemini);
    if (!ok) markKeyExhausted(key);
    console.log(`[OCR] key=${i} ${ok ? 'available' : 'exhausted'}`);
    return ok;
  }));
  const available = results.filter(Boolean).length;
  console.log(`[OCR] ${available}/${freeKeys.length} free keys available`);
}

function markKeyExhausted(apiKey) {
  const log = keyUsageLog.get(apiKey) || [];
  const now = Date.now();
  while (log.length < FREE_TIER_RPM) log.push(now);
  keyUsageLog.set(apiKey, log);
}

async function callAiOcrWithRotation(image, _apiKeysIgnored, username, providerName) {
  const providerConfig = AI_PROVIDERS[providerName] || AI_PROVIDERS.gemini;
  const freeKeys = providerConfig.freeKeys || [];
  const paidKey = providerConfig.key;
  let lastError = null;
  const model = providerConfig.model;

  // Phase 1: try free keys, skipping those tracked as exhausted
  const startIndex = freeKeys.length ? (apiKeyCursor % freeKeys.length) : 0;
  for (let offset = 0; offset < freeKeys.length; offset += 1) {
    const keyIndex = (startIndex + offset) % freeKeys.length;
    const apiKey = freeKeys[keyIndex];

    if (!isKeyAvailable(apiKey)) continue;

    recordKeyUsage(apiKey);
    const t0 = Date.now();
    const response = await callAiOcrOnce(image, apiKey, providerConfig);
    const responseTimeMs = Date.now() - t0;

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      const parsed = parseStructuredJson(content);
      console.log(`[OCR] ${providerName} free key=${keyIndex} signals=${getComponentSignalCount(parsed, String(parsed.hardwareType || 'disk').toLowerCase())}`);
      logAiUsage({ model, apiKeyIndex: keyIndex, keyType: 'free', usage: data.usage, success: true, statusCode: 200, responseTimeMs, username });
      apiKeyCursor = keyIndex + 1;
      return { parsed, content, provider: providerName };
    }

    const errText = await response.text().catch(() => '');
    if (response.status === 429) {
      markKeyExhausted(apiKey);
      console.log(`[OCR] ${providerName} free key=${keyIndex} 429, marked exhausted`);
      logAiUsage({ model, apiKeyIndex: keyIndex, keyType: 'free', success: false, statusCode: 429, responseTimeMs, username });
      continue;
    }

    console.error(`AI API error (${providerName}):`, response.status, errText);
    logAiUsage({ model, apiKeyIndex: keyIndex, keyType: 'free', success: false, statusCode: response.status, responseTimeMs, username });
    const error = new Error(`AI API hatası: ${response.status}`);
    error.code = 'ocr_provider_error';
    error.providerStatus = response.status;
    lastError = error;
    break;
  }

  // Phase 2: all free keys exhausted or in cooldown → fall back to paid key
  if (paidKey) {
    if (freeKeys.length) console.log(`[OCR] ${providerName} free keys exhausted, using paid key`);
    const t0 = Date.now();
    const response = await callAiOcrOnce(image, paidKey, providerConfig);
    const responseTimeMs = Date.now() - t0;

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      const parsed = parseStructuredJson(content);
      console.log(`[OCR] ${providerName} paid key signals=${getComponentSignalCount(parsed, String(parsed.hardwareType || 'disk').toLowerCase())}`);
      logAiUsage({ model, apiKeyIndex: -1, keyType: 'paid', usage: data.usage, success: true, statusCode: 200, responseTimeMs, username });
      return { parsed, content, provider: providerName };
    }

    const errText = await response.text().catch(() => '');
    console.error(`AI API error (${providerName} paid key):`, response.status, errText);
    logAiUsage({ model, apiKeyIndex: -1, keyType: 'paid', success: false, statusCode: response.status, responseTimeMs, username });
    const error = new Error(response.status === 429
      ? 'AI API hatası: 429 (tüm API anahtarları kota sınırına takıldı)'
      : `AI API hatası: ${response.status}`);
    error.code = response.status === 429 ? 'ocr_provider_rate_limited' : 'ocr_provider_error';
    error.providerStatus = response.status;
    lastError = error;
  }

  throw lastError || new Error('AI API isteği başarısız oldu (tüm anahtarlar tükendi)');
}

const SYSTEM_PROMPT = `You are an OCR assistant specialized in reading hardware labels and short server/rack tags.
Always read both:
1) component label details (disk/ram/nic/cpu)
2) possible short server label (often vertical text near rack rails, e.g. PD2823)

Set "resultKind":
- "component" for normal hardware extraction
- "server_label" when the image is mainly a short rack/server tag

If you detect a short rack/asset label, return it in "serverLabel" as uppercase letters/numbers only.
Use "serverLabel" only for rack/asset labels (for example short PD*/SH* tags).
If you detect a device service tag, return it in "serviceTag" (uppercase letters/numbers).
Do not copy component serial/model/part numbers into "serverLabel" or "serviceTag".
For server-front photos, also extract device model when visible (e.g. "PowerEdge R740xd").

Determine hardwareType:
- "disk" for hard drives, SSDs, NVMe drives
- "ram" for memory modules (DIMMs, SO-DIMMs)
- "nic" for network interface cards / Ethernet adapters
- "cpu" for processors / CPUs

For DISK labels, extract:
- manufacturer: Brand name (e.g. SEAGATE, WD, TOSHIBA, SAMSUNG, INTEL, MICRON, KINGSTON, CRUCIAL, HGST, HITACHI, DELL, HP, HPE, SANDISK, KIOXIA, SK HYNIX)
- model: Model number (e.g. ST4000DM004, WD40EFZX)
- partNumber: Part number if visible (e.g. 9FJ066-006)
- capacity: Storage capacity with unit (e.g. "500GB", "2TB", "4TB")
- serial: Serial number
- rpm: RPM speed if present (e.g. "7200RPM", "5.4K", "5400RPM"). Empty for SSDs.
- formFactor: Form factor if visible ("2.5\"" or "3.5\"")
- interface: Disk bus/interface when visible or inferable ("SAS", "SATA", "NVME", "SSD"). Use empty string if unknown.

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
  "serviceTag":"",
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
    return res.status(400).json({
      code: 'ocr_request_invalid',
      error: 'Görsel verisi gönderilmedi'
    });
  }

  const providerConfig = AI_PROVIDERS.gemini;
  if (!providerConfig.url || !providerConfig.key) {
    return res.status(500).json({
      code: 'ocr_config_missing',
      error: 'OCR için AI_API_KEY veya AI_API_KEYS tanımlı değil'
    });
  }

  try {
    const sessionToken = req.cookies?.session;
    const sessionUser = sessionToken && activeSessions.get(sessionToken);
    const username = sessionUser?.username || '';
    const aiResult = await callAiOcrWithRotation(image, null, username, 'gemini');
    const parsed = aiResult.parsed;
    const content = aiResult.content;

    const rawType = String(parsed.hardwareType || 'disk').toLowerCase();
    const hardwareType = ['ram', 'disk', 'nic', 'cpu'].includes(rawType) ? rawType : 'disk';
    const serviceTagCandidate = [
      parsed.serviceTag,
      parsed.service_tag,
      parsed.servicetag
    ]
      .map(normalizeServerLabelCandidate)
      .find(isValidServerLabel) || '';

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
      const parsedBusToken = normalizeDiskBusValue(parsed.interface)
        || normalizeDiskBusValue(parsed.model)
        || normalizeDiskBusValue(parsed.partNumber)
        || normalizeDiskBusValue(content)
        || inferDiskBusFromModelCode(parsed.model);

      result = {
        hardwareType: 'disk',
        manufacturer: parsed.manufacturer || '',
        model: parsed.model || '',
        partNumber: parsed.partNumber || '',
        capacity: parsed.capacity || '',
        serial: parsed.serial || '',
        rpm: parsed.rpm || '',
        formFactor: parsed.formFactor || '',
        interface: parsedBusToken,
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
          busToken: normalizeToken(normalizeDiskBusValue(result.interface)),
          modelToken: normalizeToken(result.model),
          modelWeight: looksOpaquePartCode(result.model) ? 0.5 : 1
        };

        const hasSignals = Boolean(
          signals.manufacturerToken
          || signals.capacityToken
          || signals.rpmToken
          || signals.formFactorToken
          || signals.busToken
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
            .map((candidate, index) => {
              const candidateText = `${candidate.name || ''} ${candidate.category || ''}`;
              return {
                ...candidate,
                score: scoreDiskCandidate(candidateText, signals),
                busToken: normalizeDiskBusValue(candidateText),
                dedupeKey: normalizeToken(candidate.name),
                sourceIndex: index
              };
            })
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
          } else if (!result.interface && best && best.score >= 3 && best.busToken) {
            result.interface = best.busToken;
          }
        }
      }
    }

    result.serviceTag = serviceTagCandidate;
    if (!String(result.serial || '').trim() && serviceTagCandidate) {
      result.serial = serviceTagCandidate;
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
      parsed.tag
    ]
      .map(normalizeServerLabelCandidate)
      .find(isValidServerLabel) || '';
    const validServerLabel = isValidServerLabel(serverLabelCandidate);
    const validServiceTag = isValidServerLabel(serviceTagCandidate);
    const weakComponent = getComponentSignalCount(result, hardwareType) === 0;
    const hasDeviceTag = validServerLabel || validServiceTag;
    const shouldTreatAsServerLabel = validServiceTag || (validServerLabel && (modelSaysServerLabel || weakComponent));

    result.resultKind = shouldTreatAsServerLabel
      ? 'server_label'
      : 'component';
    result.serverLabel = validServerLabel ? serverLabelCandidate : '';

    if (hasDeviceTag) {
      const db = getDb();
      const assetByTag = db.prepare(
        'SELECT asset_tag, serial, model, category, status, location FROM inventory_assets WHERE UPPER(asset_tag) = UPPER(?) LIMIT 1'
      ).get(serverLabelCandidate || serviceTagCandidate);
      const assetBySerial = !assetByTag && result.serial
        ? db.prepare(
          'SELECT asset_tag, serial, model, category, status, location FROM inventory_assets WHERE UPPER(serial) = UPPER(?) LIMIT 1'
        ).get(result.serial)
        : null;
      const matchedAsset = assetByTag || assetBySerial;
      if (matchedAsset) {
        result.assetMatchByTag = {
          assetTag: matchedAsset.asset_tag,
          serial: matchedAsset.serial,
          model: matchedAsset.model,
          category: matchedAsset.category,
          status: matchedAsset.status,
          location: matchedAsset.location
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Metin tanıma işleme hatası:', err);

    if (err?.code === 'ocr_request_invalid') {
      return res.status(400).json({
        code: 'ocr_request_invalid',
        error: err.message || 'Görsel verisi gönderilmedi'
      });
    }

    if (err?.code === 'ocr_config_missing') {
      return res.status(500).json({
        code: 'ocr_config_missing',
        error: err.message || 'OCR yapılandırması eksik'
      });
    }

    if (err?.code === 'ocr_provider_error' || err?.code === 'ocr_provider_rate_limited') {
      return res.status(502).json({
        code: err.code,
        providerStatus: err?.providerStatus || undefined,
        error: err.message || 'AI API isteği başarısız oldu'
      });
    }

    const isProviderTransportError = err?.name === 'TypeError';
    const statusCode = isProviderTransportError ? 502 : 500;
    return res.status(statusCode).json({
      code: isProviderTransportError ? 'ocr_provider_unreachable' : 'ocr_internal_error',
      error: 'Metin tanıma işleme hatası: ' + err.message
    });
  }
});

// Probe keys on startup (non-blocking)
discoverAvailableKeys().catch(() => {});

module.exports = router;
