const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'db', 'inventory.db');
let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDB() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS session_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      model TEXT DEFAULT '',
      etiket TEXT DEFAULT '',
      seri TEXT DEFAULT '',
      not_text TEXT DEFAULT '',
      components_only INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      list_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'CPU',
      qty INTEGER DEFAULT 1,
      name TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      health TEXT DEFAULT '',
      FOREIGN KEY (device_id) REFERENCES session_devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_component_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      health TEXT DEFAULT '',
      FOREIGN KEY (component_id) REFERENCES session_components(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_name TEXT DEFAULT '',
      asset_tag TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      model TEXT DEFAULT '',
      category TEXT DEFAULT '',
      status TEXT DEFAULT '',
      checked_out_to TEXT DEFAULT '',
      location TEXT DEFAULT '',
      search_text TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS inventory_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      category TEXT DEFAULT '',
      total INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0,
      location TEXT DEFAULT '',
      search_text TEXT DEFAULT ''
    );
  `);

  // Seed users
  const users = [
    ['bahadir', 'Bahadır'],
    ['anil', 'Anıl'],
    ['eren', 'Eren'],
    ['emre', 'Emre'],
    ['yagiz', 'Yağız'],
    ['volkan', 'Volkan']
  ];
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, display_name) VALUES (?, ?)');
  for (const [u, d] of users) insertUser.run(u, d);

  // Normalize previously seeded ASCII-only Turkish display names.
  const legacyDisplayByUsername = {
    bahadir: 'Bahadir',
    anil: 'Anil',
    yagiz: 'Yagiz'
  };
  const selectDisplayName = db.prepare('SELECT display_name FROM users WHERE username = ?');
  const updateDisplayName = db.prepare('UPDATE users SET display_name = ? WHERE username = ?');
  for (const [u, d] of users) {
    const existing = selectDisplayName.get(u);
    if (existing && legacyDisplayByUsername[u] && existing.display_name === legacyDisplayByUsername[u]) {
      updateDisplayName.run(d, u);
    }
  }

  // Import inventory data if tables are empty
  const assetCount = db.prepare('SELECT COUNT(*) as c FROM inventory_assets').get().c;
  if (assetCount === 0) {
    const assetsPath = path.join(__dirname, 'data', 'assets_all.json');
    if (fs.existsSync(assetsPath)) {
      const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
      const ins = db.prepare(`INSERT INTO inventory_assets (asset_name, asset_tag, serial, model, category, status, checked_out_to, location, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        for (const a of assets) {
          const searchText = [a['Asset Name'], a['Asset Tag'], a.Serial, a.Model, a.Category, a.Location]
            .filter(Boolean).join(' ').toLowerCase();
          ins.run(a['Asset Name'] || '', a['Asset Tag'] || '', a.Serial || '', a.Model || '',
            a.Category || '', a.Status || '', a['Checked Out To'] || '', a.Location || '', searchText);
        }
      });
      tx();
      console.log(`Imported ${assets.length} inventory assets`);
    }
  }

  const compCount = db.prepare('SELECT COUNT(*) as c FROM inventory_components').get().c;
  if (compCount === 0) {
    const compsPath = path.join(__dirname, 'data', 'components_all.json');
    if (fs.existsSync(compsPath)) {
      const comps = JSON.parse(fs.readFileSync(compsPath, 'utf8'));
      const ins = db.prepare(`INSERT INTO inventory_components (name, serial, category, total, remaining, location, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        for (const c of comps) {
          const searchText = [c.Name, c.Serial, c.Category, c.Location]
            .filter(Boolean).join(' ').toLowerCase();
          ins.run(c.Name || '', c.Serial || '', c.Category || '', c.Total || 0,
            c.Remaining || 0, c.Location || '', searchText);
        }
      });
      tx();
      console.log(`Imported ${comps.length} inventory components`);
    }
  }

  console.log('Database initialized');
}

module.exports = { getDb, initDB };
