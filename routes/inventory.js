const express = require('express');
const { getDb } = require('../db');
const { requireFreshPin } = require('../middleware/auth');

const router = express.Router();
router.use(requireFreshPin);

router.get('/assets', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json([]);

  const results = getDb().prepare(
    'SELECT asset_name, asset_tag, serial, model, category, status, location FROM inventory_assets WHERE search_text LIKE ? LIMIT 8'
  ).all(`%${q}%`);

  res.json(results.map(r => ({
    'Asset Name': r.asset_name,
    'Asset Tag': r.asset_tag,
    Serial: r.serial,
    Model: r.model,
    Category: r.category,
    Status: r.status,
    Location: r.location
  })));
});

router.get('/components', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json([]);

  const results = getDb().prepare(
    'SELECT name, serial, category, total, remaining, location FROM inventory_components WHERE search_text LIKE ? LIMIT 8'
  ).all(`%${q}%`);

  res.json(results.map(r => ({
    Name: r.name,
    Serial: r.serial,
    Category: r.category,
    Total: r.total,
    Remaining: r.remaining,
    Location: r.location
  })));
});

module.exports = router;
