const express = require('express');
const { asyncHandler } = require('../lib/async-handler');
const { getDb } = require('../db');
const { fetchCurrentDeviceStateSnapshot } = require('../lib/current-device-state');
const { getSnipeItClient } = require('../lib/snipeit-client');
const { requireFreshPin, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireFreshPin);

async function refreshLocalInventoryCache() {
  const client = getSnipeItClient();
  const db = getDb();
  const [assets, components] = await Promise.all([
    client.getAll('hardware'),
    client.getAll('components')
  ]);

  const insertAsset = db.prepare(`
    INSERT INTO inventory_assets (
      asset_name, asset_tag, serial, model, category, status, checked_out_to, location, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT INTO inventory_components (
      name, serial, category, total, remaining, location, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM inventory_assets').run();
    db.prepare('DELETE FROM inventory_components').run();

    for (const asset of assets) {
      const model = asset.model?.name || asset.model || '';
      const category = asset.category?.name || asset.category || '';
      const status = asset.status_label?.name || asset.status_label || '';
      const location = asset.location?.name || asset.location || '';
      const searchText = [asset.name, asset.asset_tag, asset.serial, model, category, status, location]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      insertAsset.run(
        asset.name || '',
        asset.asset_tag || '',
        asset.serial || '',
        model,
        category,
        status,
        '',
        location,
        searchText
      );
    }

    for (const component of components) {
      const category = component.category?.name || component.category || '';
      const location = component.location?.name || component.location || '';
      const searchText = [component.name, component.serial, category, location]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      insertComponent.run(
        component.name || '',
        component.serial || '',
        category,
        component.qty || 0,
        component.remaining || 0,
        location,
        searchText
      );
    }
  });

  tx();

  return {
    assets: assets.length,
    components: components.length
  };
}

async function respondWithHealth(req, res) {
  const client = getSnipeItClient();
  if (!client.isConfigured()) {
    return res.status(503).json({
      configured: false,
      healthy: false,
      base_url: client.getConfigSummary().baseUrl,
      dry_run: client.getConfigSummary().dryRun
    });
  }

  try {
    await client.request('GET', 'statuslabels', { query: { limit: 1 } });
    res.json({
      configured: true,
      healthy: true,
      base_url: client.getConfigSummary().baseUrl,
      dry_run: client.getConfigSummary().dryRun
    });
  } catch (error) {
    res.status(error.statusCode || 503).json({
      configured: true,
      healthy: false,
      base_url: client.getConfigSummary().baseUrl,
      dry_run: client.getConfigSummary().dryRun,
      error: error.message
    });
  }
}

router.get('/status', asyncHandler(respondWithHealth));

router.get('/assets/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json([]);
  }

  const rows = await getSnipeItClient().searchAssets(q, 8);
  res.json(rows.map((row) => ({
    id: row.id,
    source: 'snipeit',
    asset_tag: row.asset_tag,
    serial: row.serial,
    model: row.model,
    location: row.location,
    status_label: row.status_label
  })));
}));

router.get('/assets/:assetId/current-state', asyncHandler(async (req, res) => {
  const assetId = Number(req.params.assetId || 0);
  if (!assetId) {
    return res.status(400).json({ error: 'Geçersiz sunucu kimliği' });
  }

  const fetchedAt = new Date().toISOString();
  const snapshot = await fetchCurrentDeviceStateSnapshot(assetId);
  res.json({ snapshot, fetched_at: fetchedAt });
}));

router.get('/assets/bytag/:tag', asyncHandler(async (req, res) => {
  try {
    const asset = await getSnipeItClient().getAssetByTag(req.params.tag);
    if (!asset) {
      return res.status(404).json({ error: 'Sunucu bulunamadı' });
    }
    res.json(asset);
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
}));

router.get('/assets/byserial/:serial', asyncHandler(async (req, res) => {
  try {
    const asset = await getSnipeItClient().getAssetBySerial(req.params.serial);
    if (!asset) {
      return res.status(404).json({ error: 'Sunucu bulunamadı' });
    }
    res.json(asset);
  } catch (error) {
    res.status(error.statusCode || 404).json({ error: error.message });
  }
}));

router.get('/components/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json([]);
  }

  const rows = await getSnipeItClient().searchComponents(q, 8);
  res.json(rows.map((row) => ({
    id: row.id,
    source: 'snipeit',
    name: row.name,
    serial: row.serial,
    category: row.category,
    location: row.location,
    remaining: row.remaining,
    qty: row.qty
  })));
}));

router.get('/models/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) {
    return res.json([]);
  }

  res.json(await getSnipeItClient().searchModels(q, 8));
}));

router.get('/locations/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(await getSnipeItClient().searchLocations(q, 20));
}));

router.get('/statuslabels/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(await getSnipeItClient().searchStatusLabels(q, 20));
}));

router.get('/categories/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || '').trim();
  if (q.length < 1) {
    return res.json([]);
  }

  const categoryType = type ? `${type[0].toUpperCase()}${type.slice(1).toLowerCase()}` : null;
  res.json(await getSnipeItClient().searchCategories(q, { limit: 20, categoryType }));
}));

router.post('/refresh-local-cache', requireRole('manager'), asyncHandler(async (req, res) => {
  const result = await refreshLocalInventoryCache();
  res.json({ ok: true, ...result });
}));

module.exports = router;
