// Synthetic "OpenStreetMap" world + fake Overpass responder used by the tests.
// Mimics Overpass behaviour the app relies on: count-marker sections,
// `out center`, full `out geom`, clipped `out geom(bbox)` and is_in.
'use strict';
const E = require('../src/engine.js');

const LAT0 = 47.6062, LON0 = -122.3321; // a Seattle-ish spot
const m2lat = (m) => m / 111195;
const m2lon = (m) => m / (111195 * Math.cos(LAT0 * Math.PI / 180));
const P = (dxm, dym) => [LAT0 + m2lat(dym), LON0 + m2lon(dxm)];

let nid = 1;
const nodes = [];
const ways = [];
const rels = [];
function node(dx, dy, tags) { const [lat, lon] = P(dx, dy); nodes.push({ type: 'node', id: nid++, lat, lon, tags }); }
function ring(pts, densifyM) {
  // pts in metres; densify so clipping behaves like real data
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / (densifyM || 1e9)));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(out[0]);
  return out.map(([x, y]) => { const [lat, lon] = P(x, y); return { lat, lon }; });
}
function way(geom, tags) { ways.push({ type: 'way', id: nid++, geometry: geom, tags }); return ways[ways.length - 1]; }

// --- the world -------------------------------------------------------------
// A park 300 m x 250 m north-east of centre
way(ring([[100, 150], [400, 150], [400, 400], [100, 400]]), { leisure: 'park', name: 'Test Park' });
// A small pond inside the park
way(ring([[300, 300], [340, 300], [340, 330], [300, 330]]), { natural: 'water', name: 'Duck Pond' });
// A café west of the park and a sushi restaurant south-west
node(20, 260, { amenity: 'cafe', name: 'Bean There' });
node(-250, -120, { amenity: 'restaurant', cuisine: 'sushi;japanese', name: 'Sushi Go' });
node(-200, 80, { amenity: 'restaurant', name: 'Diner' });
node(-180, 60, { amenity: 'fast_food', cuisine: 'burger', name: 'Burger Hut' });
node(600, -100, { shop: 'convenience', name: 'Quick Stop' });
// A row of bus stops along a street at y = -40
for (let x = -600; x <= 600; x += 200) node(x, -40, { highway: 'bus_stop' });
// Building-mapped station (way with centre)
way(ring([[-500, 400], [-450, 400], [-450, 430], [-500, 430]]), { railway: 'station', name: 'Central Stn' }).isPointLike = true;
// Named bridge and an unnamed culvert bridge
way(ring([[700, 300], [720, 300]]).slice(0, 2), { highway: 'primary', bridge: 'yes', name: 'Big Bridge' });
way(ring([[-700, 500], [-690, 500]]).slice(0, 2), { highway: 'footway', bridge: 'yes' });
// A big lake (relation, perimeter > 25 km) to the south: its north shore is y = -400
const lakeOuter = ring([[-15000, -400], [15000, -400], [15000, -8000], [-15000, -8000]], 60);
rels.push({ type: 'relation', id: nid++, tags: { natural: 'water', type: 'multipolygon', name: 'Big Lake' }, members: [{ type: 'way', ref: 999, role: 'outer', geometry: lakeOuter }] });
// A forest relation that fully covers a far-away tile (for "cover" test): huge square around (0, 30000)
const forestOuter = ring([[-20000, 20000], [20000, 20000], [20000, 40000], [-20000, 40000]], 200);
rels.push({ type: 'relation', id: nid++, tags: { landuse: 'forest', type: 'multipolygon', name: 'Huge Forest' }, members: [{ type: 'way', ref: 998, role: 'outer', geometry: forestOuter }] });

// --- responder ---------------------------------------------------------------
function inB(b, lat, lon) { return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e; }
function geomIntersects(g, b) {
  for (let i = 0; i < g.length; i++) {
    if (inB(b, g[i].lat, g[i].lon)) return true;
    if (i && segHitsBox(g[i - 1], g[i], b)) return true;
  }
  return false;
}
function segHitsBox(a, c, b) {
  // sample the segment (good enough for a fixture)
  for (let t = 0; t <= 1; t += 0.02) {
    if (inB(b, a.lat + (c.lat - a.lat) * t, a.lon + (c.lon - a.lon) * t)) return true;
  }
  return false;
}
function clip(g, b) {
  // keep nodes inside bbox plus their direct neighbours; others → null
  const keep = g.map((p) => inB(b, p.lat, p.lon));
  const r = g.map((p, i) => (keep[i] || keep[i - 1] || keep[i + 1] ? p : null));
  return process.env.CLIP_OMIT ? r.filter(Boolean) : r;
}
function centroid(g) {
  let la = 0, lo = 0; for (const p of g) { la += p.lat; lo += p.lon; }
  return { lat: la / g.length, lon: lo / g.length };
}
function perimeterM(g) { let s = 0; for (let i = 1; i < g.length; i++) s += E.distM(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon); return s; }
function insidePoly(g, lat, lon) {
  const segs = []; for (let i = 1; i < g.length; i++) segs.push(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
  return E.rayInside(segs, lat, lon);
}
function matchAny(tags, sets) {
  for (const [k, vals] of Object.entries(sets)) if (tags[k] && vals.includes(tags[k])) return true;
  return false;
}
const POINT = {}, AREA = {};
for (const c of E.CATEGORIES) for (const [k, v] of c.tags) {
  const tgt = c.kind === 'area' ? AREA : (c.kind === 'point' ? POINT : null);
  if (tgt) (tgt[k] = tgt[k] || []).push(v);
}
const CUIS = E.CATEGORIES.flatMap((c) => c.cuisine);
const hasCuisine = (t) => E.cuisineList(t).some((x) => CUIS.includes(x)) || (t.cuisine && CUIS.some((c) => t.cuisine.toLowerCase().includes(c)));

let requestCount = 0;
function respond(query) {
  requestCount++;
  const m = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  const b = { s: +m[1], w: +m[2], n: +m[3], e: +m[4] };
  const full = query.includes('if:length()');
  const isin = query.match(/is_in\((-?[\d.]+),(-?[\d.]+)\)/);
  const els = [];
  const count = () => els.push({ type: 'count', id: 0, tags: {} });
  // points
  count();
  for (const n of nodes) if (inB(b, n.lat, n.lon) && (matchAny(n.tags, POINT) || matchAny(n.tags, AREA) || hasCuisine(n.tags))) els.push(n);
  for (const w of ways) {
    if ((matchAny(w.tags, POINT) || hasCuisine(w.tags)) && geomIntersects(w.geometry, b)) {
      els.push({ type: 'way', id: w.id, center: centroid(w.geometry.slice(0, -1)), tags: w.tags });
    }
  }
  // area ways
  count();
  for (const w of ways) if (matchAny(w.tags, AREA) && geomIntersects(w.geometry, b)) els.push(w);
  // relations
  const relHits = rels.filter((r) => matchAny(r.tags, AREA) && r.members.some((mm) => geomIntersects(mm.geometry, b)));
  const small = relHits.filter((r) => perimeterM(r.members[0].geometry) < 25000);
  const big = relHits.filter((r) => !small.includes(r));
  if (full) {
    count(); for (const r of small) els.push(r);
    count(); for (const r of big) els.push(Object.assign({}, r, { members: r.members.map((mm) => Object.assign({}, mm, { geometry: clip(mm.geometry, b) })) }));
  } else {
    count(); for (const r of relHits) els.push(Object.assign({}, r, { members: r.members.map((mm) => Object.assign({}, mm, { geometry: clip(mm.geometry, b) })) }));
  }
  // bridges
  count();
  for (const w of ways) if (w.tags.bridge === 'yes' && geomIntersects(w.geometry, b)) els.push({ type: 'way', id: w.id, tags: w.tags, geometry: clip(w.geometry, b) });
  // is_in
  if (isin) {
    count();
    const la = +isin[1], lo = +isin[2];
    for (const r of rels) if (matchAny(r.tags, AREA) && insidePoly(r.members[0].geometry, la, lo)) els.push({ type: 'area', id: 3600000000 + r.id, tags: r.tags });
    for (const w of ways) if (matchAny(w.tags, AREA) && insidePoly(w.geometry, la, lo)) els.push({ type: 'area', id: 2400000000 + w.id, tags: w.tags });
  }
  return { version: 0.6, generator: 'fixture', elements: els };
}

module.exports = { respond, LAT0, LON0, P, m2lat, m2lon, requests: () => requestCount };
