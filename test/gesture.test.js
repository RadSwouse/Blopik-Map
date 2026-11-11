// Regression: pinch-zoom out, lift one finger, keep dragging with the other.
// The map must move by roughly the finger distance, not teleport.
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const E = require('../src/engine.js');
(async () => {
  const HTML = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => r.request().url().startsWith('https://pb.test/') ? r.fulfill({ contentType: 'text/html', body: HTML }) : r.fulfill({ status: 404, body: '' }));
  await page.addInitScript(() => localStorage.setItem('pbdecor.v1', JSON.stringify({ view: { lat: 41.8536, lon: -87.7367, zoom: 16 }, settings: { basemap: 'osm' } })));
  await page.goto('https://pb.test/');
  await page.waitForFunction(() => window.PBApp);
  const ev = (type, id, x, y) => page.evaluate(([type, id, x, y]) => {
    const c = document.querySelector('#map canvas');
    c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 1 }));
  }, [type, id, x, y]);
  const before = await page.evaluate(() => ({ lat: PBApp.map.lat, lon: PBApp.map.lon, z: PBApp.map.zoom }));
  // two fingers down, pinch in (zoom out ~1.3 levels)
  await ev('pointerdown', 1, 150, 300); await ev('pointerdown', 2, 250, 300);
  for (let i = 1; i <= 10; i++) await ev('pointermove', 2, 250 - i * 6, 300);
  // lift finger 2, keep dragging finger 1 by 60 px
  await ev('pointerup', 2, 190, 300);
  for (let i = 1; i <= 6; i++) await ev('pointermove', 1, 150 + i * 10, 300);
  await ev('pointerup', 1, 210, 300);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ lat: PBApp.map.lat, lon: PBApp.map.lon, z: PBApp.map.zoom, mpp: PBApp.map.metersPerPixel() }));
  const moved = E.distM(before.lat, before.lon, after.lat, after.lon);
  const expectMax = after.mpp * 300; // pinch midpoint shift + 60 px drag, generous bound
  console.log(JSON.stringify({ zoomBefore: before.z, zoomAfter: +after.z.toFixed(2), movedMetres: Math.round(moved), limit: Math.round(expectMax), errors }));
  if (!(after.z < before.z - 0.5) || moved > expectMax || errors.length) { console.log('FAIL'); process.exitCode = 1; } else console.log('PASS');
  await browser.close();
})();
