// Synthetic world served as OpenMapTiles-style vector tiles (real MVT protobuf),
// plus a fake Overpass responder for the cuisine top-up. Used by the tests.
'use strict';
const zlib = require('zlib');
const E = require('../src/engine.js');

const LAT0 = 47.6062, LON0 = -122.3321;
const m2lat = (m) => m / 111195;
const m2lon = (m) => m / (111195 * Math.cos(LAT0 * Math.PI / 180));
const P = (dx, dy) => [LAT0 + m2lat(dy), LON0 + m2lon(dx)];
const rect = (x0, y0, x1, y1) => [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)]];

// layer -> features {type: 1 point | 2 line | 3 polygon, tags, parts: [[ [lat,lon], ... ]]}
const W = { poi: [], landcover: [], landuse: [], water: [], transportation: [], transportation_name: [], building: [], mountain_peak: [], aeroway: [] };
const poi = (dx, dy, cls, sub, name) => W.poi.push({ type: 1, tags: Object.assign({ class: cls, subclass: sub, rank: 1 }, name ? { name } : {}), parts: [[P(dx, dy)]] });

W.landcover.push({ type: 3, tags: { class: 'grass', subclass: 'park' }, parts: rect(100, 150, 400, 400) });
poi(250, 275, 'park', 'park', 'Test Park');
W.water.push({ type: 3, tags: { class: 'pond' }, parts: rect(300, 300, 340, 330) });
poi(20, 260, 'cafe', 'cafe', 'Bean There');
poi(-250, -120, 'restaurant', 'restaurant', 'Sushi Go');
poi(-200, 80, 'restaurant', 'restaurant', 'Diner');
poi(-180, 60, 'fast_food', 'fast_food', 'Burger Hut');
poi(600, -100, 'shop', 'convenience', 'Quick Stop');
poi(-470, 415, 'railway', 'station', 'Central Stn');
poi(-300, 700, 'place_of_worship', 'christian', 'Church'); // not a decor outside Japan
for (let x = -600; x <= 600; x += 200) poi(x, -40, 'bus', 'bus_stop');
// roads (basemap) and bridges
W.transportation.push({ type: 2, tags: { class: 'primary' }, parts: [[P(-3000, -40), P(3000, -40)]] });
W.transportation.push({ type: 2, tags: { class: 'minor' }, parts: [[P(60, -3000), P(60, 3000)]] });
W.transportation.push({ type: 2, tags: { class: 'primary', brunnel: 'bridge' }, parts: [[P(700, 300), P(720, 300)]] });
W.transportation.push({ type: 2, tags: { class: 'path', brunnel: 'bridge' }, parts: [[P(-700, 500), P(-690, 500)]] });
W.transportation_name.push({ type: 2, tags: { class: 'primary', brunnel: 'bridge', name: 'Big Bridge' }, parts: [[P(700, 300), P(720, 300)]] });
W.building.push({ type: 3, tags: {}, parts: rect(-230, 100, -170, 140) });
// big lake to the south (north shore at y = -400) and a huge forest far north
W.water.push({ type: 3, tags: { class: 'lake' }, parts: rect(-15000, -8000, 15000, -400) });
W.landcover.push({ type: 3, tags: { class: 'wood', subclass: 'forest' }, parts: rect(-20000, 20000, 20000, 40000) });

// ---- MVT encoder ------------------------------------------------------------
class Wr {
  constructor() { this.a = []; }
  varint(n) { while (n >= 128) { this.a.push((n % 128) | 128); n = Math.floor(n / 128); } this.a.push(n); }
  tag(f, wt) { this.varint(f * 8 + wt); }
  bytes(f, arr) { this.tag(f, 2); this.varint(arr.length); for (const b of arr) this.a.push(b); }
  str(f, s) { this.bytes(f, [...Buffer.from(String(s), 'utf8')]); }
  packed(f, nums) { const w = new Wr(); nums.forEach((n) => w.varint(n)); this.bytes(f, w.a); }
}
const zz = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
function clipPoly(ring, lo, hi) {
  const edges = [[(p) => p[0] >= lo, (a, b) => inter(a, b, 0, lo)], [(p) => p[0] <= hi, (a, b) => inter(a, b, 0, hi)],
    [(p) => p[1] >= lo, (a, b) => inter(a, b, 1, lo)], [(p) => p[1] <= hi, (a, b) => inter(a, b, 1, hi)]];
  let pts = ring.slice(0, -1);
  for (const [inside, cut] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); } else if (inside(prev)) out.push(cut(prev, cur));
    }
    pts = out; if (!pts.length) return null;
  }
  return pts.length >= 3 ? pts.map((q) => [Math.round(q[0]), Math.round(q[1])]) : null;
}
function inter(a, b, axis, v) { const t = (v - a[axis]) / (b[axis] - a[axis]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

function encodeTile(z, x, y, ext) {
  ext = ext || 4096;
  const BUF = 64, n = Math.pow(2, z);
  const toT = ([lat, lon]) => {
    const fx = ((lon + 180) / 360) * n;
    const s = Math.sin(lat * Math.PI / 180);
    const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    return [Math.round((fx - x) * ext), Math.round((fy - y) * ext)];
  };
  const tile = new Wr();
  let any = false;
  for (const [name, feats] of Object.entries(W)) {
    const keys = [], vals = [], fw = [];
    const ki = (k) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
    const vi = (v) => { let i = vals.indexOf(v); if (i < 0) { vals.push(v); i = vals.length - 1; } return i; };
    for (const f of feats) {
      const geom = [];
      let cx = 0, cy = 0;
      const mv = (p) => { geom.push(zz(p[0] - cx), zz(p[1] - cy)); cx = p[0]; cy = p[1]; };
      if (f.type === 1) {
        const pts = f.parts[0].map(toT).filter((p) => p[0] >= -BUF && p[1] >= -BUF && p[0] <= ext + BUF && p[1] <= ext + BUF);
        if (!pts.length) continue;
        geom.push(1 | (pts.length << 3)); pts.forEach(mv);
      } else if (f.type === 2) {
        const pts = f.parts[0].map(toT);
        // crude clip: keep if any point near the tile, clamp coordinates
        if (!pts.some((p) => p[0] >= -BUF && p[1] >= -BUF && p[0] <= ext + BUF && p[1] <= ext + BUF)) {
          // a long road crossing the tile: sample to see if it passes through
          const a = pts[0], b = pts[pts.length - 1];
          let hit = false; for (let t = 0; t <= 1; t += 0.01) { const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t; if (px >= 0 && py >= 0 && px <= ext && py <= ext) hit = true; }
          if (!hit) continue;
        }
        const cl = pts.map((p) => [Math.max(-BUF, Math.min(ext + BUF, p[0])), Math.max(-BUF, Math.min(ext + BUF, p[1]))]);
        geom.push(1 | (1 << 3)); mv(cl[0]);
        geom.push(2 | ((cl.length - 1) << 3)); cl.slice(1).forEach(mv);
      } else {
        const ring = clipPoly(f.parts[0].map(toT), -BUF, ext + BUF);
        if (!ring) continue;
        geom.push(1 | (1 << 3)); mv(ring[0]);
        geom.push(2 | ((ring.length - 1) << 3)); ring.slice(1).forEach(mv);
        geom.push(7 | (1 << 3));
      }
      const fe = new Wr();
      const tags = [];
      for (const [k, v] of Object.entries(f.tags)) tags.push(ki(k), vi(v));
      fe.packed(2, tags); fe.tag(3, 0); fe.varint(f.type); fe.packed(4, geom);
      fw.push(fe.a);
    }
    if (!fw.length) continue;
    any = true;
    const L = new Wr();
    L.tag(15, 0); L.varint(2); L.str(1, name);
    fw.forEach((a) => L.bytes(2, a));
    keys.forEach((k) => L.str(3, k));
    vals.forEach((v) => { const vw = new Wr(); if (typeof v === 'string') vw.str(1, v); else { vw.tag(4, 0); vw.varint(v); } L.bytes(4, vw.a); });
    L.tag(5, 0); L.varint(ext);
    tile.bytes(3, L.a);
  }
  return any ? Buffer.from(tile.a) : Buffer.alloc(0);
}
let tileRequests = 0;
function tileResponse(z, x, y, gzip) {
  tileRequests++;
  const raw = encodeTile(z, x, y);
  return gzip ? zlib.gzipSync(raw) : raw;
}

// ---- fake Overpass (cuisine top-up only) ------------------------------------
const cuisineNodes = [
  { type: 'node', id: 9001, lat: P(-250, -120)[0], lon: P(-250, -120)[1], tags: { amenity: 'restaurant', cuisine: 'sushi;japanese', name: 'Sushi Go' } },
  { type: 'node', id: 9002, lat: P(-900, 300)[0], lon: P(-900, 300)[1], tags: { amenity: 'restaurant', cuisine: 'pizza', name: 'Slice' } },
];
let overpassRequests = 0;
function respond(query) {
  overpassRequests++;
  const m = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  const b = { s: +m[1], w: +m[2], n: +m[3], e: +m[4] };
  return { version: 0.6, generator: 'fixture', elements: cuisineNodes.filter((n) => E.bboxContains(b, n.lat, n.lon)) };
}

module.exports = { LAT0, LON0, P, m2lat, m2lon, encodeTile, tileResponse, respond, counts: () => ({ tileRequests, overpassRequests }) };
