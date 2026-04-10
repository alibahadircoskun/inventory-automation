#!/usr/bin/env node

const { getDb, initDB } = require('../db');
const { generateTemporaryPin, hashPin } = require('../lib/auth-utils');

function parseArgs(argv) {
  return {
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    usernames: argv.filter((arg) => !arg.startsWith('--'))
  };
}

function main() {
  const { force, json, usernames } = parseArgs(process.argv.slice(2));

  initDB();
  const db = getDb();
  const requested = usernames.length > 0 ? usernames : null;
  const users = requested
    ? db.prepare(`
        SELECT id, username, display_name, role, pin_hash
        FROM users
        WHERE username IN (${requested.map(() => '?').join(',')})
        ORDER BY id
      `).all(...requested)
    : db.prepare('SELECT id, username, display_name, role, pin_hash FROM users ORDER BY id').all();

  if (users.length === 0) {
    console.error('No matching users found.');
    process.exit(1);
  }

  const updateUser = db.prepare(`
    UPDATE users
    SET pin_hash = ?,
        must_change_pin = 1,
        pin_changed_at = NULL,
        failed_pin_attempts = 0,
        locked_until = NULL
    WHERE id = ?
  `);

  const generated = [];
  const tx = db.transaction(() => {
    for (const user of users) {
      if (user.pin_hash && !force) {
        continue;
      }

      const pin = generateTemporaryPin();
      updateUser.run(hashPin(pin), user.id);
      generated.push({
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        temporary_pin: pin
      });
    }
  });

  tx();

  if (generated.length === 0) {
    console.log('No users needed new PINs. Re-run with --force to rotate existing PINs.');
    return;
  }

  if (json) {
    console.log(JSON.stringify(generated, null, 2));
    return;
  }

  console.log('Temporary PINs generated. Users will be required to change them at first login.\n');
  for (const row of generated) {
    console.log(`${row.username} (${row.display_name}, ${row.role}): ${row.temporary_pin}`);
  }
}

main();
