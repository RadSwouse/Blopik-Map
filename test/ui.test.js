// Headless Chrome run of dist/index.html with mocked Overpass + map tiles.
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const sharp = require('/opt/npm-tools/node_modules/sharp');
const F = require('./fixture.js');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const HTML = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

(async () => {
  const _unused = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#eef2ee' } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="0.5" y="0.5" width="255" height="255" fill="none" stroke="#d5ddd6"/><path d="M0 128H256" stroke="#fff" stroke-width="6"/></svg>'), top: 0, left: 0 }])
    .png().toBuffer();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const results = [];
  for (const vp of [{ name: 'mobile', width: 390, height: 844, mobile: true }, { name: 'desktop', width: 1280, height: 820 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    let overpassCalls = 0, tileCalls = 0;
    const busyFirst = vp.name === 'desktop';
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith('https://pb.test/')) return route.fulfill({ contentType: 'text/html', body: HTML });
      if (u === 'https://tiles.openfreemap.org/planet') {
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/20261105_001001_pt/{z}/{x}/{y}.pbf'], maxzoom: 14 }) });
      }
      const m = u.match(/planet\/\d+_\d+_pt\/(\d+)\/(\d+)\/(\d+)\.pbf/);
      if (m) {
        tileCalls++;
        const [z, x, y] = m.slice(1).map(Number);
        const body = F.tileResponse(z, x, y, x % 2 === 1); // odd x: raw gzip bytes (app must unzip)
        return route.fulfill({ status: body.length ? 200 : 204, contentType: 'application/x-protobuf', headers: { 'access-control-allow-origin': '*' }, body });
      }
      if (u.includes('/api/interpreter')) {
        overpassCalls++;
        if (busyFirst && overpassCalls === 1) return route.fulfill({ status: 429, body: 'rate limited' });
        const body = decodeURIComponent(route.request().postData().replace(/^data=/, '').replace(/\+/g, ' '));
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(F.respond(body)) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.addInitScript(([lat, lon]) => {
      localStorage.setItem('pbdecor.v1', JSON.stringify({ view: { lat, lon, zoom: 16.4 } }));
    }, [F.LAT0 + 0.0005, F.LON0]);
    await page.goto('https://pb.test/');
    await page.waitForFunction(() => window.PBApp && window.PBApp.state.index, null, { timeout: 20000 });
    await page.screenshot({ path: `${OUT}/${vp.name}-1-explore.png` });

    // choose Park via the picker
    await page.click('#pick');
    await page.fill('#pickSearch', 'park');
    await page.click('.pi[data-id="park"]');
    await page.waitForFunction(() => window.PBApp.state.spots.length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${vp.name}-2-park.png` });
    const spots = await page.evaluate(() => window.PBApp.state.spots.map((s) => ({ level: s.level, safe: Math.round(s.safe), det: s.detector })));

    // "Show" first spot → detector tab
    await page.click('[data-go="0"]');
    await page.waitForTimeout(700);
    await page.click('#tabs button[data-tab="detector"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${vp.name}-3-detector.png` });
    const badge = await page.textContent('#p-detector .badge').catch(() => null);

    // tap a busy place on the map (near diner/burger)
    const [la, lo] = F.P(-190, 70);
    await page.evaluate(([la, lo]) => window.PBApp.map.setView(la, lo + 0.0006, 17), [la, lo]);
    await page.waitForTimeout(900);
    const xy = await page.evaluate(([la, lo]) => window.PBApp.map.toScreen(la, lo), [la, lo]);
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForTimeout(600);
    const det2 = await page.evaluate(() => window.PBApp.state.probeDet && window.PBApp.state.probeDet.shown);

    // calibrate: log a reading at the tapped place, then test models
    await page.click('#tabs button[data-tab="calibrate"]');
    await page.waitForTimeout(400);
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForTimeout(500);
    for (const id of det2) await page.click(`#calChips .chip[data-id="${id}"]`);
    await page.click('#calSave');
    await page.click('#calTest');
    await page.waitForSelector('[data-use]', { timeout: 20000 });
    await page.screenshot({ path: `${OUT}/${vp.name}-4-calibrate.png`, fullPage: false });
    const calTop = await page.evaluate(() => { const r = window.PBApp.state.calResults; return { best: Math.round(r.list[0].score * 100), cur: Math.round(r.current.score * 100) }; });

    // Find nearest Park from a spot with no park in view
    await page.click('#tabs button[data-tab="spots"]');
    await page.evaluate(([la, lo]) => window.PBApp.map.setView(la, lo, 16.5), F.P(-650, -300));
    await page.waitForTimeout(900);
    await page.click('#findNearest');
    await page.waitForFunction(() => { const n = window.PBApp.state.nearest; return n && !n.busy; }, null, { timeout: 30000 });
    const nearest = await page.evaluate(() => { const n = window.PBApp.state.nearest; return n.spot ? { level: n.spot.level, d: Math.round(n.spot.distance), safe: Math.round(n.spot.safe) } : n; });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${vp.name}-6-nearest.png` });

    // cuisine target: Sushi (needs the polite Overpass top-up)
    await page.click('#pick');
    await page.fill('#pickSearch', 'sushi');
    await page.click('.pi[data-id="sushi"]');
    const t0 = Date.now();
    if (busyFirst) {
      await page.waitForFunction(() => /cuisine server busy/.test(document.querySelector('#status').textContent), null, { timeout: 15000 });
      await page.screenshot({ path: `${OUT}/${vp.name}-7-cuisine-busy.png` });
    }
    await page.waitForFunction(() => [...window.PBApp.state.index.cells.values()].some((c) => c.cats.includes('sushi')), null, { timeout: 90000 });
    const sushiWait = Math.round((Date.now() - t0) / 1000);

    // settings tab renders; switch grid → re-analysis without errors
    await page.click('#tabs button[data-tab="settings"]');
    await page.selectOption('#sGrid', 's2-18');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${vp.name}-5-settings.png` });

    // zoomed-out state message
    await page.evaluate(() => window.PBApp.map.setView(window.PBApp.map.lat, window.PBApp.map.lon, 13));
    await page.waitForTimeout(700);
    const zoomMsg = await page.textContent('#status');

    results.push({ vp: vp.name, tileCalls, overpassCalls, spots: spots.slice(0, 4), badge, det2, calTop, nearest, sushiWait, zoomMsg, errors: errors.filter((e) => !/429/.test(e)) });
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
