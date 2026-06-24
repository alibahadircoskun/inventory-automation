const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'db', 'inventory.db');
const LATEST_USER_VERSION = 8;
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

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function columnExists(db, tableName, columnName) {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, columnDef) {
  if (!columnExists(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`);
  }
}

function createLegacyBaseSchema(db) {
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

    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      model TEXT,
      api_key_index INTEGER,
      key_type TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      status_code INTEGER,
      response_time_ms INTEGER,
      username TEXT DEFAULT ''
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
  const resolveSeedPath = (candidates) => {
    for (const name of candidates) {
      const candidate = path.join(__dirname, 'data', name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const assetCount = db.prepare('SELECT COUNT(*) as c FROM inventory_assets').get().c;
  if (assetCount === 0) {
    const assetsPath = resolveSeedPath(['assets_all.local.json', 'assets_sample.json']);
    if (assetsPath) {
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
    const compsPath = resolveSeedPath(['components_all.local.json', 'components_sample.json']);
    if (compsPath) {
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
}

function runMigration(db, version, migrate) {
  const tx = db.transaction(() => {
    migrate(db);
    db.pragma(`user_version = ${version}`);
  });

  tx();
}

function runMigrations(db) {
  const currentVersion = db.pragma('user_version', { simple: true }) || 0;

  const migrations = [
    {
      version: 1,
      migrate(db) {
        addColumnIfMissing(db, 'users', 'role', "role TEXT NOT NULL DEFAULT 'tech'");
        addColumnIfMissing(db, 'users', 'pin_hash', 'pin_hash TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'users', 'must_change_pin', 'must_change_pin INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'users', 'failed_pin_attempts', 'failed_pin_attempts INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'users', 'locked_until', 'locked_until TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'users', 'pin_changed_at', 'pin_changed_at TEXT DEFAULT NULL');

        db.exec(`
          CREATE TABLE IF NOT EXISTS auth_sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            last_seen_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
          CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
        `);
      }
    },
    {
      version: 2,
      migrate(db) {
        addColumnIfMissing(db, 'work_sessions', 'submitted_at', 'submitted_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'submitted_by', 'submitted_by INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'reviewed_by', 'reviewed_by INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'reviewed_at', 'reviewed_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'review_comment', "review_comment TEXT DEFAULT ''");
        addColumnIfMissing(db, 'work_sessions', 'snipeit_sync_status', 'snipeit_sync_status TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'snipeit_sync_started_at', 'snipeit_sync_started_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'snipeit_sync_finished_at', 'snipeit_sync_finished_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'snipeit_sync_summary', 'snipeit_sync_summary TEXT DEFAULT NULL');

        db.exec(`
          CREATE TABLE IF NOT EXISTS session_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            actor_user_id INTEGER DEFAULT NULL,
            event_type TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
          );

          CREATE INDEX IF NOT EXISTS idx_work_sessions_user_status ON work_sessions(user_id, status);
          CREATE INDEX IF NOT EXISTS idx_work_sessions_status ON work_sessions(status, updated_at);
          CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id, created_at);
        `);

        db.prepare("UPDATE work_sessions SET status = 'approved' WHERE status = 'completed'").run();
      }
    },
    {
      version: 3,
      migrate(db) {
        addColumnIfMissing(db, 'session_devices', 'asset_resolution_mode', "asset_resolution_mode TEXT DEFAULT 'unresolved'");
        addColumnIfMissing(db, 'session_devices', 'snipeit_asset_id', 'snipeit_asset_id INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'session_devices', 'snipeit_asset_snapshot', 'snipeit_asset_snapshot TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'session_devices', 'snipeit_validated_at', 'snipeit_validated_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'session_devices', 'proposed_new_asset_status', "proposed_new_asset_status TEXT DEFAULT ''");
        addColumnIfMissing(db, 'session_devices', 'proposed_new_asset_location', "proposed_new_asset_location TEXT DEFAULT ''");

        addColumnIfMissing(db, 'session_components', 'snipeit_component_id', 'snipeit_component_id INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'session_components', 'snipeit_component_snapshot', 'snipeit_component_snapshot TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'session_components', 'snipeit_match_status', "snipeit_match_status TEXT DEFAULT 'unresolved'");

        addColumnIfMissing(db, 'session_component_units', 'snipeit_component_id', 'snipeit_component_id INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'session_component_units', 'snipeit_component_snapshot', 'snipeit_component_snapshot TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'session_component_units', 'snipeit_match_status', "snipeit_match_status TEXT DEFAULT 'unresolved'");
      }
    },
    {
      version: 4,
      migrate(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sync_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            operation TEXT NOT NULL,
            snipeit_endpoint TEXT NOT NULL,
            request_payload TEXT,
            response_status INTEGER,
            response_body TEXT,
            success INTEGER DEFAULT 0,
            idempotency_key TEXT DEFAULT NULL,
            FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_sync_audit_log_session_id ON sync_audit_log(session_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_sync_audit_log_idempotency_key ON sync_audit_log(idempotency_key);
        `);
      }
    },
    {
      version: 5,
      migrate(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT DEFAULT '',
            data TEXT DEFAULT NULL,
            read_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, read_at, created_at);
        `);
      }
    },
    {
      version: 6,
      migrate(db) {
        addColumnIfMissing(db, 'work_sessions', 'archived_at', 'archived_at TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'archived_by_user_id', 'archived_by_user_id INTEGER DEFAULT NULL');
        addColumnIfMissing(db, 'work_sessions', 'source_session_id', 'source_session_id TEXT DEFAULT NULL');

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_work_sessions_archived_status ON work_sessions(archived_at, status, updated_at);
          CREATE INDEX IF NOT EXISTS idx_work_sessions_source_session_id ON work_sessions(source_session_id);
        `);
      }
    },
    {
      version: 7,
      migrate(db) {
        addColumnIfMissing(db, 'session_components', 'proposed_new_component_category', "proposed_new_component_category TEXT DEFAULT ''");
        addColumnIfMissing(db, 'session_components', 'proposed_new_component_location', "proposed_new_component_location TEXT DEFAULT ''");
        addColumnIfMissing(db, 'session_component_units', 'proposed_new_component_category', "proposed_new_component_category TEXT DEFAULT ''");
        addColumnIfMissing(db, 'session_component_units', 'proposed_new_component_location', "proposed_new_component_location TEXT DEFAULT ''");
      }
    },
    {
      version: 8,
      migrate(db) {
        addColumnIfMissing(db, 'session_devices', 'current_state_snapshot', 'current_state_snapshot TEXT DEFAULT NULL');
        addColumnIfMissing(db, 'session_devices', 'current_state_fetched_at', 'current_state_fetched_at TEXT DEFAULT NULL');
      }
    }
  ];

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      runMigration(db, migration.version, migration.migrate);
    }
  }
}

function seedUsers(db) {
  const users = [
    ['bahadir', 'Bahadır', 'tech'],
    ['anil', 'Anıl', 'tech'],
    ['eren', 'Eren', 'tech'],
    ['emre', 'Emre', 'tech'],
    ['yagiz', 'Yağız', 'tech'],
    ['volkan', 'Volkan', 'manager']
  ];

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, display_name, role) VALUES (?, ?, ?)');
  const updateUser = db.prepare('UPDATE users SET display_name = ?, role = ? WHERE username = ?');

  for (const [username, displayName, role] of users) {
    insertUser.run(username, displayName, role);
    updateUser.run(displayName, role, username);
  }

  const legacyDisplayByUsername = {
    bahadir: 'Bahadir',
    anil: 'Anil',
    yagiz: 'Yagiz'
  };
  const selectDisplayName = db.prepare('SELECT display_name FROM users WHERE username = ?');
  const updateDisplayName = db.prepare('UPDATE users SET display_name = ? WHERE username = ?');
  for (const [username, displayName] of users) {
    const existing = selectDisplayName.get(username);
    if (existing && legacyDisplayByUsername[username] && existing.display_name === legacyDisplayByUsername[username]) {
      updateDisplayName.run(displayName, username);
    }
  }
}

function cleanupExpiredAuthSessions(db) {
  db.prepare("DELETE FROM auth_sessions WHERE datetime(expires_at) <= datetime('now')").run();
}

function initDB() {
  const db = getDb();

  createLegacyBaseSchema(db);
  runMigrations(db);
  seedUsers(db);
  cleanupExpiredAuthSessions(db);

  console.log('Database initialized');
}

module.exports = {
  DB_PATH,
  LATEST_USER_VERSION,
  cleanupExpiredAuthSessions,
  getDb,
  initDB
};
