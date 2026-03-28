const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

// GET /api/usage — recent logs with pagination
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM ai_usage_log ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM ai_usage_log').get().count;

  res.json({ total, limit, offset, rows });
});

// GET /api/usage/summary — aggregated stats
router.get('/summary', (req, res) => {
  const db = getDb();
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2099-12-31';

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_calls,
      SUM(prompt_tokens) as total_prompt_tokens,
      SUM(completion_tokens) as total_completion_tokens,
      SUM(total_tokens) as total_tokens,
      ROUND(AVG(response_time_ms)) as avg_response_time_ms
    FROM ai_usage_log
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(from, to + ' 23:59:59');

  const byDay = db.prepare(`
    SELECT
      DATE(timestamp) as day,
      COUNT(*) as calls,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens
    FROM ai_usage_log
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY DATE(timestamp)
    ORDER BY day DESC
  `).all(from, to + ' 23:59:59');

  const byKeyType = db.prepare(`
    SELECT
      key_type,
      COUNT(*) as calls,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
      SUM(total_tokens) as total_tokens
    FROM ai_usage_log
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY key_type
  `).all(from, to + ' 23:59:59');

  const byModel = db.prepare(`
    SELECT
      model,
      COUNT(*) as calls,
      SUM(total_tokens) as total_tokens
    FROM ai_usage_log
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY model
  `).all(from, to + ' 23:59:59');

  const byUser = db.prepare(`
    SELECT
      username,
      COUNT(*) as calls,
      SUM(total_tokens) as total_tokens
    FROM ai_usage_log
    WHERE timestamp >= ? AND timestamp <= ? AND username != ''
    GROUP BY username
    ORDER BY calls DESC
  `).all(from, to + ' 23:59:59');

  res.json({ totals, byDay, byKeyType, byModel, byUser });
});

module.exports = router;
