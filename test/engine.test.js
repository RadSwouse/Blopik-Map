'use strict';
const assert = require('assert');
const E = require('../src/engine.js');
const F = require('./fixture.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n', e.stack); process.exitCode = 1; }
}

console.log('S2 / grids');
test('S2 face/uv round trip', () => {
  for (const [la, lo] of [[47.6, -122.3], [-33.9, 151.2], [35.68, 139.76], [0.1, 0.1], [89, 10], [-60, -170]]) {
    const [f, u, v] = E.latLngToFaceUV(la, lo);
    const [la2, lo2] = E.faceUVToLatLng(f, u, v);
    assert(Math.abs(la - la2) < 1e-9 && Math.abs(lo - lo2) < 1e-9, `${la},${lo} -> ${la2},${lo2}`);
  }
});
test('NYC is on S2 face 4 (tokens start 89c…)', () => {
  assert.strictEqual(E.latLngToFaceUV(40.7128, -74.006)[0], 4);
});
test('st/uv inverse', () => {
  for (const s of [0, 0.1, 0.4999, 0.5, 0.73, 1]) assert(Math.abs(E.uvToST(E.stToUV(s)) - s) < 1e-12);
});
for (const gid of Object.keys(E.GRID_LABELS)) {
  test(`${gid}: cell centre maps back to its own key; sensible size`, () => {
    const g = E.getGrid(gid);
    const k = g.keyOf(F.LAT0, F.LON0);
    const c = g.cell(k);
    assert.strictEqual(g.keyOf(c.lat, c.lon), k);
    const w = E.distM(c.corners[0][0], c.corners[0][1], c.corners[1][0], c.corners[1][1]);
    const h = E.distM(c.corners[1][0], c.corners[1][1], c.corners[2][0], c.corners[2][1]);
    assert(w > g.edge * 0.4 && w < g.edge * 2.2, `width ${w} vs edge ${g.edge}`);
    assert(h > g.edge * 0.4 && h < g.edge * 2.2, `height ${h}`);
    // the original point lies inside the cell polygon
    const segs = []; for (let i = 0; i < 4; i++) { const a = c.corners[i], b = c.corners[(i + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); }
    assert(E.rayInside(segs, F.LAT0, F.LON0));
  });
}
test('S2 L17 cell count within 100 m ≈ 5–8 (matches detector showing ≤6–7 types)', () => {
  const g = E.getGrid('s2-17');
  const b = E.expandBBox({ s: F.LAT0, n: F.LAT0, w: F.LON0, e: F.LON0 }, 200);
  let tot = 0, n = 0;
  for (let t = 0; t < 30; t++) {
    const la = F.LAT0 + (Math.random() - 0.5) * 0.002, lo = F.LON0 + (Math.random() - 0.5) * 0.002;
    let c = 0;
    for (const k of E.cellsInBBox(g, b)) { const cc = g.cell(k); if (E.distM(la, lo, cc.lat, cc.lon) <= 100) c++; }
    tot += c; n++;
  }
  const avg = tot / n;
  console.log('        avg L17 cells in range:', avg.toFixed(2), '(edge', g.edge.toFixed(0) + ' m)');
  assert(avg > 3 && avg < 10);
});
test('cellsInBBox covers every point in the box', () => {
  const g = E.getGrid('s2-18');
  const b = { s: 47.60, n: 47.605, w: -122.34, e: -122.333 };
  const keys = E.cellsInBBox(g, b);
  for (let t = 0; t < 2000; t++) {
    const la = b.s + Math.random() * (b.n - b.s), lo = b.w + Math.random() * (b.e - b.w);
    assert(keys.has(g.keyOf(la, lo)));
  }
});

console.log('Tags');
const O = E.DEFAULT_OPTS;
test('sushi restaurant → restaurant + sushi (both mode)', () => {
  assert.deepStrictEqual(E.catsFor({ amenity: 'restaurant', cuisine: 'sushi;japanese' }, 'node', 'point', O, 47, -122).sort(), ['restaurant', 'sushi']);
});
test('specific mode drops generic restaurant', () => {
  assert.deepStrictEqual(E.catsFor({ amenity: 'restaurant', cuisine: 'Sushi' }, 'node', 'point', Object.assign({}, O, { cuisineMode: 'specific' }), 47, -122), ['sushi']);
});
test('park as a way is not a point category; as a node it is', () => {
  assert.deepStrictEqual(E.catsFor({ leisure: 'park' }, 'way', 'point', O, 47, -122), []);
  assert.deepStrictEqual(E.catsFor({ leisure: 'park' }, 'node', 'point', O, 47, -122), ['park']);
  assert.deepStrictEqual(E.catsFor({ leisure: 'park' }, 'way', 'area', O, 47, -122), ['park']);
});
test('place_of_worship only in Japan', () => {
  assert.deepStrictEqual(E.catsFor({ amenity: 'place_of_worship' }, 'node', 'point', O, 47.6, -122.3), []);
  assert.deepStrictEqual(E.catsFor({ amenity: 'place_of_worship' }, 'node', 'point', O, 35.0, 135.77), ['shrine']);
  assert(!E.inJapan(37.56, 126.97) && !E.inJapan(35.1, 129.04) && !E.inJapan(43.1, 131.9), 'Seoul/Busan/Vladivostok excluded');
  assert(E.inJapan(43.06, 141.35) && E.inJapan(26.2, 127.68) && E.inJapan(33.59, 130.4), 'Sapporo/Naha/Fukuoka included');
});
test('bridge modes', () => {
  const t = { bridge: 'yes', highway: 'footway' };
  assert.deepStrictEqual(E.catsFor(t, 'way', 'line', O, 47, -122), []);
  assert.deepStrictEqual(E.catsFor(t, 'way', 'line', Object.assign({}, O, { bridgeMode: 'all' }), 47, -122), ['bridge']);
});

console.log('Overpass query + parse');
const tileKey = E.tileKeyFor(F.LAT0, F.LON0);
test('query has sections and balanced parens', () => {
  const q = E.buildQuery(tileKey, {});
  assert.deepStrictEqual(q.sections, ['points', 'areaWays', 'relFull', 'relClipped', 'bridges', 'isIn']);
  const opens = (q.query.match(/\(/g) || []).length, closes = (q.query.match(/\)/g) || []).length;
  assert.strictEqual(opens, closes);
  assert(!/area\.ins\[[^\]]+\]\(\)/.test(q.query), 'no empty bbox on area filter');
  assert(!q.query.includes('place_of_worship'), 'not queried outside Japan');
  console.log(q.query.split('\n').map((l) => '        | ' + l).join('\n'));
});
test('safe + dated variants', () => {
  const q = E.buildQuery(tileKey, { variant: 'safe', date: '2026-09-01' });
  assert(!q.query.includes('length()') && !q.query.includes('is_in') && q.query.includes('[date:"2026-09-01T00:00:00Z"]'));
  assert.deepStrictEqual(q.sections, ['points', 'areaWays', 'relClipped', 'bridges']);
});

const store = new E.FeatureStore();
function loadAround(lat, lon, radiusM) {
  const b = E.expandBBox({ s: lat, n: lat, w: lon, e: lon }, radiusM);
  for (const k of E.tilesForBBox(b)) {
    if (store.has(k)) continue;
    const q = E.buildQuery(k, {});
    store.addTile(E.parseTile(F.respond(q.query), q));
  }
}
test('parse tile', () => {
  loadAround(F.LAT0, F.LON0, 900);
  const t = store.tiles.get(tileKey);
  assert(t.points.length > 5, 'points ' + t.points.length);
  assert(t.points.some((p) => p.tags.railway === 'station' && p.et === 'way'), 'station way as point');
  const lake = [...store.tiles.values()].flatMap((x) => x.areas).find((a) => a.tags.name === 'Big Lake');
  assert(lake && lake.mode === 'ref', 'big lake clipped/ref mode');
  assert(lake.segs.length < 4 * 400, 'clipped geometry is small: ' + lake.segs.length / 4);
});

console.log('Cells, detector, isolation');
const dist = (lat, lon) => E.distM(F.LAT0, F.LON0, lat, lon);
test('lake (clipped relation) detected near shore, not far north', () => {
  const [la1, lo1] = F.P(0, -450); // 50 m into the lake
  assert(store.areasAt(la1, lo1, () => ['x']).some((a) => a.tags.name === 'Big Lake'), 'inside lake');
  const [la2, lo2] = F.P(0, -300); // 100 m north of shore
  assert(!store.areasAt(la2, lo2, () => ['x']).some((a) => a.tags.name === 'Big Lake'), 'outside lake');
  const [la3, lo3] = F.P(400, -1300); // deep in the lake, other tile
  loadAround(la3, lo3, 300);
  assert(store.areasAt(la3, lo3, () => ['x']).some((a) => a.tags.name === 'Big Lake'), 'deep inside lake (other tile)');
});
test('tile fully inside a huge forest gets a cover record', () => {
  const [la, lo] = F.P(0, 30000);
  loadAround(la, lo, 50);
  const t = store.tileAt(la, lo);
  assert(t.covers.some((c) => c.tags.name === 'Huge Forest'), JSON.stringify(t.covers));
});

const view = E.expandBBox({ s: F.LAT0, n: F.LAT0, w: F.LON0, e: F.LON0 }, 700);
let idx;
test('build cell index (S2 L17)', () => {
  const t0 = Date.now();
  idx = E.buildCellIndex(store, E.expandBBox(view, 100), { grid: 's2-17' });
  const ms = Date.now() - t0;
  const counts = {};
  for (const c of idx.cells.values()) for (const id of c.cats) counts[id] = (counts[id] || 0) + 1;
  console.log('        typed cells:', idx.cells.size, 'in', ms, 'ms', JSON.stringify(counts));
  assert(counts.park >= 6 && counts.waterside >= 10 && counts.cafe === 1 && counts.bus_stop >= 5);
  assert(counts.bridge >= 1 && [...idx.cells.values()].every((c) => !c.cats.includes('bridge') || c.src.every((x) => x.cat !== 'bridge' || x.name === 'Big Bridge')), 'only the named bridge');
});
test('detector inside the park', () => {
  const [la, lo] = F.P(250, 380);
  const d = E.detect(idx, la, lo);
  assert(d.shown.includes('park'), d.shown);
});
test('detector at a spot with nothing → roadside', () => {
  const [la, lo] = F.P(-600, 250);
  const d = E.detect(idx, la, lo);
  assert(d.roadside, JSON.stringify(d.shown));
});
let ig;
test('isolation grid + pure Park spots exist and are really pure', () => {
  const t0 = Date.now();
  ig = E.isolationGrid(idx, view, 'park', 60000);
  const spots = E.rankSpots(idx, ig, 8);
  console.log('        raster', ig.cols + 'x' + ig.rows, 'step', ig.step.toFixed(1) + ' m', Date.now() - t0, 'ms;', spots.length, 'spots');
  for (const s of spots.slice(0, 4)) console.log('        spot level', s.level, 'safe', s.safe.toFixed(0) + ' m', 'area', s.area.toFixed(0), 'det', s.detector.join(','));
  assert(spots.length && spots[0].level === 0, 'top spot is pure');
  for (const s of spots.filter((x) => x.level === 0)) {
    const d = E.detect(idx, s.lat, s.lon);
    assert.deepStrictEqual(d.shown, ['park'], 'pure spot verified by detector');
  }
});
test('Waterside: pond inside park never pure, lake shore is', () => {
  const ig2 = E.isolationGrid(idx, view, 'waterside', 60000);
  const spots = E.rankSpots(idx, ig2, 10).filter((s) => s.level === 0);
  assert(spots.length, 'has pure waterside spots');
  for (const s of spots) {
    const [pl, pn] = F.P(320, 315); // pond
    assert(E.distM(s.lat, s.lon, pl, pn) > 100, 'pure spot is not by the pond');
  }
});
test('nearest-first cap at maxShown', () => {
  const o = Object.assign({}, idx.opts, { maxShown: 1 });
  const d = E.detect(Object.assign({}, idx, { opts: o }), ...F.P(-200, 70));
  assert.strictEqual(d.shown.length, 1);
  assert(d.hidden.length >= 1);
});

console.log('Calibration');
test('evaluate models ranks the true model first', () => {
  // fake readings generated with an "unknown" true model: L18, overlap
  const truth = Object.assign({}, E.DEFAULT_OPTS, { grid: 's2-18', areaRule: 'overlap' });
  const pts = [[0, -330], [110, 140], [-230, -100], [380, 120], [-180, 30], [600, -60], [20, 230], [330, 420]];
  const readings = pts.map(([x, y], i) => { const [lat, lon] = F.P(x, y); return { id: i, lat, lon, observed: E.predictAt(store, lat, lon, truth) }; });
  const t0 = Date.now();
  const res = E.evaluateModels(store, readings, E.modelVariants(E.DEFAULT_OPTS));
  console.log('        ', res.length, 'models in', Date.now() - t0, 'ms; best:', res[0].label, res[0].score.toFixed(2));
  assert.strictEqual(res[0].score, 1);
  const best = res.filter((r) => r.score === 1).map((r) => r.opts.grid + '/' + r.opts.areaRule);
  assert(best.includes('s2-18/overlap'));
});

console.log(`\n${passed} passed`);
