const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, 'certs');

function generateCert() {
  if (fs.existsSync(path.join(certsDir, 'key.pem'))) return;
  fs.mkdirSync(certsDir, { recursive: true });
  console.log('Generating self-signed SSL certificate...');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${certsDir}/key.pem" -out "${certsDir}/cert.pem" -days 3650 -nodes -subj "/CN=inventory-mail-generator"`,
    { stdio: 'inherit' }
  );
  console.log('SSL certificate generated.');
}

module.exports = { generateCert, certsDir };
