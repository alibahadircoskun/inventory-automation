const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { generateCert, certsDir } = require('./generate-cert');
const { initDB } = require('./db');

// Load .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '');
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/app' || req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    if (req.path.startsWith('/api/')) {
      res.vary('Cookie');
    }
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', require('./routes/auth'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/approval', require('./routes/approval'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/snipeit', require('./routes/snipeit'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ocr', require('./routes/ocr'));
app.use('/api/usage', require('./routes/usage'));

// SPA fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Init DB
initDB();

// Generate self-signed cert and start HTTPS
generateCert();

const httpsOptions = {
  key: fs.readFileSync(path.join(certsDir, 'key.pem')),
  cert: fs.readFileSync(path.join(certsDir, 'cert.pem'))
};

https.createServer(httpsOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Inventory Mail Generator running at https://0.0.0.0:${PORT}`);
});

// Also listen on HTTP for convenience (redirect or direct access)
const HTTP_PORT = parseInt(PORT) + 1;
http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP also available at http://0.0.0.0:${HTTP_PORT}`);
});
