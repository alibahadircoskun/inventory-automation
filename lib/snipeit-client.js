const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = Number(process.env.SNIPEIT_TIMEOUT_MS || 60000);
const DEFAULT_CACHE_TTL_MS = 30 * 1000;
const LOCAL_BOOTSTRAP_URL = 'http://127.0.0.1:8000/api/v1';
const LOCAL_TOKEN_FILE = '/opt/snipeit/.automation-api-token';

class SnipeItError extends Error {
  constructor(message, statusCode = null, data = null) {
    super(message);
    this.name = 'SnipeItError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return null;
  }

  return String(baseUrl).replace(/\/+$/, '');
}

function readBootstrapToken() {
  if (process.env.SNIPEIT_API_TOKEN) {
    return process.env.SNIPEIT_API_TOKEN;
  }

  if (!fs.existsSync(LOCAL_TOKEN_FILE)) {
    return null;
  }

  const line = fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('SNIPEIT_API_TOKEN='));

  return line ? line.split('=', 2)[1].trim() : null;
}

function getSnipeConfig() {
  const baseUrl = normalizeBaseUrl(process.env.SNIPEIT_API_URL || LOCAL_BOOTSTRAP_URL);
  const token = readBootstrapToken();

  return {
    baseUrl,
    token,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: String(process.env.SNIPEIT_DRY_RUN || '').toLowerCase() === 'true'
  };
}

function buildUrl(baseUrl, pathName, query) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(pathName.replace(/^\/+/, ''), base);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function extractRetryAfter(headers, data, attempt) {
  const header = headers['retry-after'];
  if (header && !Number.isNaN(Number(header))) {
    return Number(header) * 1000;
  }

  if (data && typeof data === 'object') {
    const retryAfter = data.retryAfter || data.retry_after;
    if (retryAfter && !Number.isNaN(Number(retryAfter))) {
      return Number(retryAfter) * 1000;
    }
  }

  return Math.min(60000, 1000 * (attempt + 1));
}

function mapAsset(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    asset_tag: row.asset_tag || '',
    serial: row.serial || '',
    name: row.name || '',
    model: row.model?.name || row.model || '',
    model_id: row.model?.id ?? null,
    location: row.location?.name || row.location || '',
    location_id: row.location?.id ?? null,
    status_label: row.status_label?.name || row.status_label || '',
    status_id: row.status_label?.id ?? null,
    category: row.category?.name || row.category || '',
    raw: row
  };
}

function mapComponent(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name || '',
    serial: row.serial || '',
    qty: row.qty ?? 0,
    remaining: row.remaining ?? 0,
    category: row.category?.name || row.category || '',
    category_id: row.category?.id ?? null,
    location: row.location?.name || row.location || '',
    location_id: row.location?.id ?? null,
    raw: row
  };
}

function mapCategory(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name || '',
    category_type: row.category_type || row.type || '',
    raw: row
  };
}

function normalizeRows(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data.rows)) {
    return data.rows;
  }

  if (Array.isArray(data.payload)) {
    return data.payload;
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

class SnipeItClient {
  constructor(config = getSnipeConfig()) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.dryRun = !!config.dryRun;
    this.cache = new Map();
  }

  isConfigured() {
    return !!(this.baseUrl && this.token);
  }

  getConfigSummary() {
    return {
      configured: this.isConfigured(),
      baseUrl: this.baseUrl,
      dryRun: this.dryRun
    };
  }

  getCacheKey(method, pathName, query) {
    return JSON.stringify([method, pathName, query || null]);
  }

  getCached(key) {
    const hit = this.cache.get(key);
    if (!hit) {
      return null;
    }

    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return JSON.parse(hit.value);
  }

  setCached(key, value, ttlMs = DEFAULT_CACHE_TTL_MS) {
    this.cache.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlMs
    });
  }

  async request(method, pathName, { query, body, useCache = method === 'GET', cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    if (!this.isConfigured()) {
      throw new SnipeItError('Snipe-IT API is not configured.');
    }

    const cacheKey = useCache ? this.getCacheKey(method, pathName, query) : null;
    if (cacheKey) {
      const cached = this.getCached(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }

    let attempt = 0;
    while (attempt < 6) {
      const url = buildUrl(this.baseUrl, pathName, query);
      const response = await this.makeRequest(url, method, body);
      const text = response.bodyText || '';
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = text;
      }

      if (response.statusCode === 429) {
        const retryMs = extractRetryAfter(response.headers, data, attempt);
        attempt += 1;
        await delay(retryMs);
        continue;
      }

      if (response.statusCode >= 400) {
        throw new SnipeItError(
          `Snipe-IT request failed with HTTP ${response.statusCode}`,
          response.statusCode,
          data
        );
      }

      if (data && typeof data === 'object' && data.status === 'error') {
        throw new SnipeItError(
          typeof data.messages === 'string' ? data.messages : 'Snipe-IT returned an error.',
          response.statusCode,
          data
        );
      }

      const normalized = data ?? null;
      if (cacheKey) {
        this.setCached(cacheKey, normalized, cacheTtlMs);
      }
      return normalized;
    }

    throw new SnipeItError('Snipe-IT rate limit retries exhausted.');
  }

  makeRequest(url, method, body) {
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method,
        timeout: this.timeoutMs,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        let bodyText = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { bodyText += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            bodyText
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Snipe-IT request timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', reject);

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async getAll(pathName, query = {}) {
    const rows = [];
    let offset = 0;

    while (true) {
      const data = await this.request('GET', pathName, { query: { ...query, offset } });
      const batch = normalizeRows(data);
      const total = data?.total ?? batch.length;
      rows.push(...batch);
      if (batch.length === 0 || rows.length >= total) {
        break;
      }
      offset += batch.length;
    }

    return rows;
  }

  async searchAssets(search, limit = 8) {
    const data = await this.request('GET', 'hardware', { query: { search, limit } });
    return normalizeRows(data).map(mapAsset);
  }

  async getAssetByTag(assetTag) {
    const data = await this.request('GET', `hardware/bytag/${encodeURIComponent(assetTag)}`);
    return mapAsset(data);
  }

  async getAssetBySerial(serial) {
    const data = await this.request('GET', `hardware/byserial/${encodeURIComponent(serial)}`);
    return mapAsset(data);
  }

  async getAssetById(assetId) {
    const data = await this.request('GET', `hardware/${assetId}`);
    return mapAsset(data);
  }

  async searchComponents(search, limit = 8) {
    const data = await this.request('GET', 'components', { query: { search, limit } });
    return normalizeRows(data).map(mapComponent);
  }

  async getComponentById(componentId) {
    const data = await this.request('GET', `components/${componentId}`);
    return mapComponent(data);
  }

  async getComponentAssetAssignments(componentId) {
    const data = await this.request('GET', `components/${componentId}/assets`);
    return normalizeRows(data);
  }

  async getAssignedComponents(assetId) {
    const data = await this.request('GET', `hardware/${assetId}/assigned/components`);
    return normalizeRows(data).map((row) => ({
      assigned_pivot_id: row.assigned_pivot_id ?? row.id ?? null,
      component_id: row.name?.id ?? null,
      component_name: row.name?.name || '',
      assigned_qty: row.assigned_qty ?? 1,
      note: row.note || '',
      created_at: row.created_at || null,
      created_by: row.created_by || null,
      raw: row
    }));
  }

  async searchModels(search, limit = 8) {
    const data = await this.request('GET', 'models', { query: { search, limit } });
    return normalizeRows(data).map((row) => ({
      id: row.id,
      name: row.name || '',
      category: row.category?.name || row.category || '',
      raw: row
    }));
  }

  async searchLocations(search, limit = 8) {
    const data = await this.request('GET', 'locations', { query: { search, limit } });
    return normalizeRows(data).map((row) => ({
      id: row.id,
      name: row.name || '',
      raw: row
    }));
  }

  async searchStatusLabels(search, limit = 8) {
    const data = await this.request('GET', 'statuslabels', { query: { search, limit } });
    return normalizeRows(data).map((row) => ({
      id: row.id,
      name: row.name || '',
      type: row.type || row.status_type || '',
      raw: row
    }));
  }

  async searchCategories(search, { limit = 20, categoryType = null } = {}) {
    const query = { search, limit };
    if (categoryType) {
      query.category_type = categoryType;
    }
    const data = await this.request('GET', 'categories', { query });
    return normalizeRows(data).map(mapCategory);
  }

  async createAsset(payload) {
    return this.request('POST', 'hardware', { body: payload, useCache: false });
  }

  async createComponent(payload) {
    return this.request('POST', 'components', { body: payload, useCache: false });
  }

  async deleteAsset(assetId) {
    return this.request('DELETE', `hardware/${assetId}`, { useCache: false });
  }

  async deleteComponent(componentId) {
    return this.request('DELETE', `components/${componentId}`, { useCache: false });
  }

  async checkoutComponent(componentId, assignedToAssetId, qty) {
    return this.request('POST', `components/${componentId}/checkout`, {
      body: { assigned_to: assignedToAssetId, assigned_qty: qty },
      useCache: false
    });
  }

  async checkinComponent(componentAssignmentId, qty) {
    return this.request('POST', `components/${componentAssignmentId}/checkin`, {
      body: { checkin_qty: qty },
      useCache: false
    });
  }
}

let cachedClient = null;

function getSnipeItClient() {
  const config = getSnipeConfig();
  if (!cachedClient
    || cachedClient.baseUrl !== config.baseUrl
    || cachedClient.token !== config.token
    || cachedClient.timeoutMs !== config.timeoutMs
    || cachedClient.dryRun !== config.dryRun) {
    cachedClient = new SnipeItClient(config);
  }

  return cachedClient;
}

module.exports = {
  SnipeItClient,
  SnipeItError,
  getSnipeConfig,
  getSnipeItClient,
  mapAsset,
  mapComponent
};
