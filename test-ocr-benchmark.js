#!/usr/bin/env node
// OCR Benchmark: measures per-image and total time against /api/ocr endpoint
// Usage: node test-ocr-benchmark.js [--sequential]
// By default processes images sequentially to get clean per-image timing.

const fs = require('fs');
const path = require('path');

const BASE_URL = `http://0.0.0.0:${(parseInt(process.env.PORT) || 3000) + 1}`;
const TEST_DIR = path.join(__dirname, 'test-images');

async function loadTestImages() {
  const files = fs.readdirSync(TEST_DIR)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort();
  return files.map(name => ({
    name,
    dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(TEST_DIR, name)).toString('base64')
  }));
}

async function callOcr(imageDataUrl) {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl })
  });
  const elapsed = Date.now() - start;
  const data = await res.json();
  return { elapsed, status: res.status, data };
}

function countSignals(result) {
  if (!result) return 0;
  const keys = ['manufacturer', 'model', 'capacity', 'serial', 'rpm', 'formFactor',
    'memoryType', 'speed', 'rank', 'partNumber', 'frequency', 'cores', 'socket',
    'ports', 'interface', 'serverLabel'];
  return keys.reduce((n, k) => n + (String(result[k] || '').trim() ? 1 : 0), 0);
}

async function run() {
  const images = await loadTestImages();
  console.log(`\nBenchmarking ${images.length} images against ${BASE_URL}/api/ocr\n`);

  const results = [];
  const totalStart = Date.now();

  for (const img of images) {
    process.stdout.write(`  ${img.name} ... `);
    try {
      const { elapsed, status, data } = await callOcr(img.dataUrl);
      const signals = countSignals(data);
      const hwType = data?.hardwareType || data?.resultKind || '-';
      results.push({ name: img.name, elapsed, signals, hwType, error: null });
      console.log(`${elapsed}ms  signals=${signals}  type=${hwType}`);
    } catch (err) {
      results.push({ name: img.name, elapsed: 0, signals: 0, hwType: '-', error: err.message });
      console.log(`ERROR: ${err.message}`);
    }
  }

  const totalElapsed = Date.now() - totalStart;

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`${'Image'.padEnd(32)} ${'Time'.padStart(8)} ${'Signals'.padStart(8)} Type`);
  console.log('-'.repeat(70));
  for (const r of results) {
    const time = r.error ? 'ERR' : `${r.elapsed}ms`;
    console.log(`${r.name.padEnd(32)} ${time.padStart(8)} ${String(r.signals).padStart(8)} ${r.hwType}`);
  }
  console.log('-'.repeat(70));
  const avg = results.filter(r => !r.error).reduce((s, r) => s + r.elapsed, 0) / results.filter(r => !r.error).length;
  console.log(`Total: ${totalElapsed}ms | Avg per image: ${Math.round(avg)}ms | Images: ${results.length}`);
  console.log('='.repeat(70));
}

run().catch(err => { console.error('Benchmark failed:', err.message); process.exit(1); });
