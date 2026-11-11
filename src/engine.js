/* Pikmin Bloom Decor Finder — engine (pure logic, no DOM).
 * Works in the browser (window.PBEngine) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const ENGINE_VERSION = '1.0.0';
  const DEG = Math.PI / 180;
  const R_EARTH = 6371008.8;
  const M_PER_DEG_LAT = R_EARTH * DEG; // ~111195 m

  // ---------------------------------------------------------------------------
  // Decor categories → OSM tags  (source: Pikipedia "Decor Pikmin", Nov 2026)
  //   kind 'point' : the POI marks the single cell it sits in
  //   kind 'area'  : a polygon marks every cell it covers (rule set in options)
  //   kind 'line'  : a line marks every cell it passes through (bridges)
  // Edit this table if the community finds new/changed tags.
  // ---------------------------------------------------------------------------
  function cat(id, name, icon, kind, tags, extra) {
    return Object.assign({
      id, name, icon, kind,
      tags: (tags || []).map((s) => s.split('=')),
      cuisine: [],
    }, extra || {});
  }

  const CATEGORIES = [
    cat('restaurant', 'Restaurant', '🍽️', 'point', ['amenity=restaurant'], { generic: true }),
    cat('cafe', 'Café', '☕', 'point', ['amenity=cafe']),
    cat('sweetshop', 'Sweetshop', '🍩', 'point', ['shop=pastry']),
    cat('cinema', 'Movie Theater', '🍿', 'point', ['amenity=cinema']),
    cat('pharmacy', 'Pharmacy', '🪥', 'point', ['amenity=pharmacy']),
    cat('zoo', 'Zoo', '🦁', 'area', ['tourism=zoo']),
    cat('forest', 'Forest', '🌰', 'area', ['natural=wood', 'landuse=forest']),
    cat('waterside', 'Waterside', '🎣', 'area', ['natural=water']),
    cat('post_office', 'Post Office', '✉️', 'point', ['amenity=post_office']),
    cat('art', 'Art Gallery', '🖼️', 'point', ['shop=art']),
    cat('airport', 'Airport', '✈️', 'area', ['aeroway=aerodrome']),
    cat('station', 'Station', '🚆', 'point', ['railway=station', 'building=train_station']),
    cat('beach', 'Beach', '🐚', 'area', ['natural=beach']),
    cat('burger', 'Burger Place', '🍔', 'point', ['amenity=fast_food'], { generic: true }),
    cat('corner_store', 'Corner Store', '🏪', 'point', ['shop=convenience']),
    cat('supermarket', 'Supermarket', '🍌', 'point', ['shop=supermarket']),
    cat('bakery', 'Bakery', '🥖', 'point', ['shop=bakery']),
    cat('hair_salon', 'Hair Salon', '✂️', 'point', ['shop=hairdresser']),
    cat('clothes', 'Clothes Store', '👕', 'point', ['shop=clothes', 'shop=shoes']),
    cat('park', 'Park', '🍀', 'area', ['leisure=park']),
    cat('library', 'Library & Bookstore', '📚', 'point', ['amenity=library', 'shop=books']),
    cat('sushi', 'Sushi Restaurant', '🍣', 'point', [], { cuisine: ['sushi'] }),
    cat('mountain', 'Mountain', '⛰️', 'point', ['natural=peak']),
    cat('stadium', 'Stadium', '⚽', 'area', ['leisure=stadium']),
    cat('theme_park', 'Theme Park', '🎡', 'area', ['tourism=theme_park']),
    cat('bus_stop', 'Bus Stop', '🚌', 'point', ['highway=bus_stop']),
    cat('italian', 'Italian Restaurant', '🍕', 'point', [], { cuisine: ['pizza', 'mediterranean', 'italian'] }),
    cat('ramen', 'Ramen Restaurant', '🍜', 'point', [], { cuisine: ['chinese', 'noodle', 'ramen', 'udon', 'soba'] }),
    cat('bridge', 'Bridge', '🌉', 'line', ['bridge=yes']),
    cat('hotel', 'Hotel', '🏨', 'point', ['tourism=hotel']),
    cat('makeup', 'Makeup Store', '💄', 'point', ['shop=department_store']),
    cat('shrine', 'Shrine & Temple (Japan)', '⛩️', 'point', ['amenity=place_of_worship'], { region: 'JP' }),
    cat('appliances', 'Appliances Store', '🔋', 'point', ['shop=appliance', 'shop=computer', 'shop=electronics']),
    cat('curry', 'Curry Restaurant', '🍛', 'point', [], { cuisine: ['curry', 'indian', 'sri_lankan'] }),
    cat('diy', 'DIY Store', '🔧', 'point', ['shop=doityourself', 'shop=hardware']),
    cat('university', 'University & College', '🎓', 'area', ['amenity=university', 'amenity=college']),
    cat('mexican', 'Mexican Restaurant', '🌮', 'point', [], { cuisine: ['mexican'] }),
    cat('laundry', 'Laundromat', '🧺', 'point', ['shop=laundry', 'shop=dry_cleaning']),
    cat('korean', 'Korean Restaurant', '🥬', 'point', [], { cuisine: ['korean'] }),
    cat('stationery', 'Stationery Store', '✏️', 'point', ['shop=stationery', 'shop=craft']),
  ];
  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  CATEGORIES.forEach((c, i) => {
    c.index = i;
    c.hue = Math.round((i * 137.508) % 360); // golden-angle hues: distinct colours
  });
  const ROADSIDE = { id: 'roadside', name: 'Roadside', icon: '🏷️' };

  const DEFAULT_OPTS = {
    grid: 's2-17',        // cell model: s2-16 | s2-17 | s2-18 | ll-0.00036 | ll-0.00072
    radius: 100,          // detector range in metres
    areaRule: 'center',   // 'center' = cell centre inside polygon, 'overlap' = any part touches
    cuisineMode: 'both',  // 'both' = sushi place also counts as Restaurant; 'specific' = cuisine wins
    bridgeMode: 'named',  // 'named' | 'all' | 'off'
    maxShown: 6,          // detector shows at most this many types (nearest first)
  };

  // ---------------------------------------------------------------------------
  // Small geo helpers (local equirectangular — accurate to <0.1% over a few km)
  // ---------------------------------------------------------------------------
  function distM(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const dx = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * DEG);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function mPerDegLon(lat) { return M_PER_DEG_LAT * Math.cos(lat * DEG); }
  function expandBBox(b, meters) {
    const dLat = meters / M_PER_DEG_LAT;
    const dLon = meters / mPerDegLon((b.s + b.n) / 2);
    return { s: b.s - dLat, w: b.w - dLon, n: b.n + dLat, e: b.e + dLon };
  }
  function bboxContains(b, lat, lon) { return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e; }
  function bboxOverlap(a, b) { return a.s <= b.n && a.n >= b.s && a.w <= b.e && a.e >= b.w; }

  function inJapan(lat, lon) {
    if (lat >= 24 && lat < 30 && lon >= 122.9 && lon <= 131.5) return true;   // Ryukyu
    if (lat >= 30 && lat < 34.75 && lon >= 128.5 && lon <= 132.2) return true; // Kyushu, Tsushima, Goto
    if (lat >= 33.2 && lat <= 45.6 && lon >= 130.8 && lon <= 146.0) {          // Honshu–Hokkaido
      if (lat > 42.3 && lon < 139.3) return false;                            // exclude Primorye
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Tag → category matching
  // ---------------------------------------------------------------------------
  function cuisineList(tags) {
    const c = tags.cuisine;
    if (!c) return [];
    return String(c).toLowerCase().split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  }
  function catMatches(c, tags, cuis) {
    for (const [k, v] of c.tags) if (tags[k] === v) return true;
    if (c.cuisine.length && cuis.length) for (const v of c.cuisine) if (cuis.includes(v)) return true;
    return false;
  }
  /** role: 'point' | 'area' | 'line'; elType: 'node'|'way'|'relation' */
  function catsFor(tags, elType, role, opts, lat, lon) {
    if (!tags) return [];
    const cuis = cuisineList(tags);
    const out = [];
    for (const c of CATEGORIES) {
      if (role === 'point' && !(c.kind === 'point' || (c.kind === 'area' && elType === 'node'))) continue;
      if (role === 'area' && c.kind !== 'area') continue;
      if (role === 'line' && c.kind !== 'line') continue;
      if (c.region === 'JP' && !inJapan(lat, lon)) continue;
      if (c.id === 'bridge') {
        if (opts.bridgeMode === 'off') continue;
        if (opts.bridgeMode === 'named' && !(tags.name || tags['bridge:name'])) continue;
      }
      if (catMatches(c, tags, cuis)) out.push(c.id);
    }
    if (opts.cuisineMode === 'specific' && out.some((id) => CAT[id].cuisine.length)) {
      return out.filter((id) => !CAT[id].generic);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Cell grids
  // ---------------------------------------------------------------------------
  // S2 (Google's sphere cells; Niantic uses them widely). Only geometry is
  // needed, so cells are keyed by (face, i, j) instead of Hilbert cell ids.
  function uvToST(u) { return u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u); }
  function stToUV(s) { return s >= 0.5 ? (1 / 3) * (4 * s * s - 1) : (1 / 3) * (1 - 4 * (1 - s) * (1 - s)); }
  function latLngToFaceUV(lat, lon) {
    const phi = lat * DEG, th = lon * DEG, cp = Math.cos(phi);
    const x = cp * Math.cos(th), y = cp * Math.sin(th), z = Math.sin(phi);
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let f;
    if (ax >= ay && ax >= az) f = x < 0 ? 3 : 0;
    else if (ay >= az) f = y < 0 ? 4 : 1;
    else f = z < 0 ? 5 : 2;
    let u, v;
    switch (f) {
      case 0: u = y / x; v = z / x; break;
      case 1: u = -x / y; v = z / y; break;
      case 2: u = -x / z; v = -y / z; break;
      case 3: u = z / x; v = y / x; break;
      case 4: u = z / y; v = -x / y; break;
      default: u = -y / z; v = -x / z;
    }
    return [f, u, v];
  }
  function faceUVToLatLng(f, u, v) {
    let x, y, z;
    switch (f) {
      case 0: x = 1; y = u; z = v; break;
      case 1: x = -u; y = 1; z = v; break;
      case 2: x = -u; y = -v; z = 1; break;
      case 3: x = -1; y = -v; z = -u; break;
      case 4: x = v; y = -1; z = -u; break;
      default: x = v; y = u; z = -1;
    }
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
    const lon = Math.atan2(y, x) / DEG;
    return [lat, lon];
  }

  const GRID_LABELS = {
    's2-16': 'S2 level 16 (~150 m cells)',
    's2-17': 'S2 level 17 (~75 m cells)',
    's2-18': 'S2 level 18 (~38 m cells)',
    'll-0.00036': 'Lat/lng grid 0.00036° (~40 m, flower grid)',
    'll-0.00072': 'Lat/lng grid 0.00072° (~80 m)',
  };

  const gridCache = new Map();
  function getGrid(id) {
    if (gridCache.has(id)) return gridCache.get(id);
    let g;
    if (id.startsWith('s2-')) {
      const L = parseInt(id.slice(3), 10);
      const N = 2 ** L;
      const edge = 9.22e6 / N; // average edge in metres
      g = {
        id, label: GRID_LABELS[id] || id, edge, step: edge * 0.22,
        keyOf(lat, lon) {
          const [f, u, v] = latLngToFaceUV(lat, lon);
          let i = Math.floor(uvToST(u) * N), j = Math.floor(uvToST(v) * N);
          if (i >= N) i = N - 1; if (i < 0) i = 0;
          if (j >= N) j = N - 1; if (j < 0) j = 0;
          return (f * N + i) * N + j;
        },
        _geom: new Map(),
        cell(key) {
          let c = this._geom.get(key);
          if (c) return c;
          const j = key % N, rest = (key - j) / N, i = rest % N, f = (rest - i) / N;
          const pt = (s, t) => faceUVToLatLng(f, stToUV(s), stToUV(t));
          const s0 = i / N, s1 = (i + 1) / N, t0 = j / N, t1 = (j + 1) / N;
          const center = pt((i + 0.5) / N, (j + 0.5) / N);
          const corners = [pt(s0, t0), pt(s1, t0), pt(s1, t1), pt(s0, t1)];
          c = mkCell(key, center, corners);
          this._geom.set(key, c);
          return c;
        },
      };
    } else if (id.startsWith('ll-')) {
      const d = parseFloat(id.slice(3));
      const OFF_I = 600000, OFF_J = 1100000, W = 2300000;
      g = {
        id, label: GRID_LABELS[id] || id, edge: d * M_PER_DEG_LAT, step: d * M_PER_DEG_LAT * 0.3,
        keyOf(lat, lon) {
          return (Math.floor(lat / d) + OFF_I) * W + (Math.floor(lon / d) + OFF_J);
        },
        _geom: new Map(),
        cell(key) {
          let c = this._geom.get(key);
          if (c) return c;
          const jj = key % W, ii = (key - jj) / W;
          const i = ii - OFF_I, j = jj - OFF_J;
          const s = i * d, w = j * d, n = s + d, e = w + d;
          c = mkCell(key, [(s + n) / 2, (w + e) / 2], [[s, w], [s, e], [n, e], [n, w]]);
          this._geom.set(key, c);
          return c;
        },
      };
    } else {
      throw new Error('Unknown grid ' + id);
    }
    gridCache.set(id, g);
    return g;
  }
  function mkCell(key, center, corners) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const [la, lo] of corners) {
      if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
    }
    return { key, lat: center[0], lon: center[1], corners, bbox: { s, w, n, e } };
  }
  /** All cell keys whose area intersects bbox (sampled lattice, robust across S2 faces). */
  function cellsInBBox(grid, b) {
    const keys = new Set();
    const midLat = (b.s + b.n) / 2;
    const dLat = grid.step / M_PER_DEG_LAT, dLon = grid.step / mPerDegLon(midLat);
    for (let la = b.s; la <= b.n + dLat; la += dLat) {
      const lat = Math.min(la, b.n);
      for (let lo = b.w; lo <= b.e + dLon; lo += dLon) keys.add(grid.keyOf(lat, Math.min(lo, b.e)));
    }
    return keys;
  }

  // ---------------------------------------------------------------------------
  // Polygon tests
  //   ray mode : complete geometry → even/odd ray cast (works on segment soup)
  //   ref mode : clipped geometry → parity along segment from a reference point
  //              whose inside/outside state Overpass told us (is_in)
  //   cover    : polygon encloses the whole tile
  // segs are flat arrays [lat1, lon1, lat2, lon2, ...]
  // ---------------------------------------------------------------------------
  function rayInside(segs, lat, lon) {
    let inside = false;
    for (let k = 0; k < segs.length; k += 4) {
      const y1 = segs[k], x1 = segs[k + 1], y2 = segs[k + 2], x2 = segs[k + 3];
      if ((y1 > lat) !== (y2 > lat)) {
        const xi = x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
        if (xi > lon) inside = !inside;
      }
    }
    return inside;
  }
  function segCross(ay, ax, by, bx, cy, cx, dy, dx) {
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  function refInsideTest(area, lat, lon) {
    const [ry, rx] = area.ref;
    let inside = area.refInside;
    const s = area.segs;
    for (let k = 0; k < s.length; k += 4) {
      if (segCross(ry, rx, lat, lon, s[k], s[k + 1], s[k + 2], s[k + 3])) inside = !inside;
    }
    return inside;
  }
  function segsBBox(segs) {
    let s = 90, n = -90, w = 180, e = -180;
    for (let k = 0; k < segs.length; k += 2) {
      const la = segs[k], lo = segs[k + 1];
      if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
    }
    return { s, w, n, e };
  }

  // ---------------------------------------------------------------------------
  // Overpass query + parse (one query per tile; all categories at once)
  // ---------------------------------------------------------------------------
  const TILE_DEG = 0.01;     // ~1.1 km tiles
  const TILE_PAD_DEG = 0.0025; // ~250 m of extra data around each tile
  const BIG_REL_M = 25000;   // relations longer than this come back clipped

  function tileKeyFor(lat, lon) { return Math.floor(lat / TILE_DEG) + '_' + Math.floor(lon / TILE_DEG); }
  function tileInfo(key) {
    const [a, b] = key.split('_').map(Number);
    const bbox = { s: a * TILE_DEG, w: b * TILE_DEG, n: (a + 1) * TILE_DEG, e: (b + 1) * TILE_DEG };
    const pbox = { s: bbox.s - TILE_PAD_DEG, w: bbox.w - TILE_PAD_DEG, n: bbox.n + TILE_PAD_DEG, e: bbox.e + TILE_PAD_DEG };
    return { key, bbox, pbox, center: [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2] };
  }
  function tilesForBBox(b) {
    const keys = [];
    for (let a = Math.floor(b.s / TILE_DEG); a <= Math.floor(b.n / TILE_DEG); a++) {
      for (let c = Math.floor(b.w / TILE_DEG); c <= Math.floor(b.e / TILE_DEG); c++) keys.push(a + '_' + c);
    }
    return keys;
  }

  function groupTags(kinds, includeRegionJP) {
    const g = {};
    for (const c of CATEGORIES) {
      if (!kinds.includes(c.kind)) continue;
      if (c.region === 'JP' && !includeRegionJP) continue;
      for (const [k, v] of c.tags) (g[k] = g[k] || new Set()).add(v);
    }
    return g;
  }
  const esc = (s) => s.replace(/[\\"]/g, '\\$&');
  function sel(type, key, vals, bb) {
    const arr = [...vals];
    if (arr.length === 1) return `${type}["${key}"="${esc(arr[0])}"](${bb});`;
    return `${type}["${key}"~"^(${arr.map(esc).join('|')})$"](${bb});`;
  }

  /**
   * Build the Overpass QL for one tile. Output is split into sections, each
   * introduced by an `out count;` element, so the parser knows what follows.
   * variant: 'full' (length() split + is_in) | 'safe' (no length()) | 'minimal' (no is_in)
   */
  function buildQuery(tileKey, opts) {
    const o = Object.assign({ date: '', variant: 'full' }, opts || {});
    const t = tileInfo(tileKey);
    const p = t.pbox;
    const bb = [p.s, p.w, p.n, p.e].map((x) => x.toFixed(6)).join(',');
    const jp = inJapan(t.center[0], t.center[1]);
    const pointTags = groupTags(['point'], jp);
    const areaTags = groupTags(['area'], jp);
    const cuisines = [...new Set(CATEGORIES.flatMap((c) => c.cuisine))];
    const L = [];
    const dateClause = o.date ? `[date:"${esc(o.date)}T00:00:00Z"]` : '';
    L.push(`[out:json][timeout:90]${dateClause};`);
    const sections = [];
    // 1) points: POIs of point categories (any element, centre) + area categories as nodes
    L.push('(');
    for (const k of Object.keys(pointTags)) L.push(sel('nwr', k, pointTags[k], bb));
    for (const k of Object.keys(areaTags)) L.push(sel('node', k, areaTags[k], bb));
    L.push(`nwr["cuisine"~"${cuisines.join('|')}",i](${bb});`);
    L.push(')->.p;', '.p out count;', '.p out tags center qt;');
    sections.push('points');
    // 2) area ways, full geometry
    L.push('(');
    for (const k of Object.keys(areaTags)) L.push(sel('way', k, areaTags[k], bb));
    L.push(')->.aw;', '.aw out count;', '.aw out geom qt;');
    sections.push('areaWays');
    // 3) area relations — small ones full, big ones clipped to the tile
    L.push('(');
    for (const k of Object.keys(areaTags)) L.push(sel('relation', k, areaTags[k], bb));
    L.push(')->.ar;');
    if (o.variant === 'full') {
      L.push(`relation.ar(if:length()<${BIG_REL_M})->.rs;`, '(.ar; - .rs;)->.rb;');
      L.push('.rs out count;', '.rs out geom qt;');
      sections.push('relFull');
      L.push('.rb out count;', `.rb out geom(${bb}) qt;`);
      sections.push('relClipped');
    } else {
      L.push('.ar out count;', `.ar out geom(${bb}) qt;`);
      sections.push('relClipped');
    }
    // 4) bridges (lines, clipped)
    L.push(`way["bridge"="yes"](${bb})->.br;`, '.br out count;', `.br out tags geom(${bb}) qt;`);
    sections.push('bridges');
    // 5) which big areas contain the tile centre (reference for clipped relations)
    if (o.variant !== 'minimal' && !o.date) {
      const [cl, cn] = t.center.map((x) => x.toFixed(6));
      L.push(`is_in(${cl},${cn})->.ins;`, '(');
      for (const k of Object.keys(areaTags)) L.push(sel('area.ins', k, areaTags[k], '').replace('()', ''));
      L.push(')->.ia;', '.ia out count;', '.ia out tags;');
      sections.push('isIn');
    }
    return { query: L.join('\n'), sections, tile: t };
  }

  /** clipBox: for clipped output, drop segments with both ends outside the box —
   *  Overpass may omit the off-box nodes, which would otherwise create false chords. */
  function geomToSegs(geom, segs, clipBox) {
    if (!geom) return;
    for (let k = 1; k < geom.length; k++) {
      const a = geom[k - 1], b = geom[k];
      if (!a || !b || a.lat == null || b.lat == null) continue;
      if (clipBox && !bboxContains(clipBox, a.lat, a.lon) && !bboxContains(clipBox, b.lat, b.lon)) continue;
      segs.push(a.lat, a.lon, b.lat, b.lon);
    }
  }

  /** Turn an Overpass JSON response into a compact, cacheable tile record. */
  function parseTile(json, built) {
    const t = built.tile;
    const out = {
      key: t.key, bbox: t.bbox, pbox: t.pbox, center: t.center,
      points: [], areas: [], lines: [], covers: [], fetched: Date.now(),
    };
    if (!json || !Array.isArray(json.elements)) throw new Error('Unexpected Overpass response');
    if (json.remark && /error/i.test(json.remark)) throw new Error('Overpass: ' + json.remark);
    let si = -1;
    const insideIds = new Map(); // area id -> tags
    const seenAreaIds = new Set();
    const relClipped = [];
    for (const el of json.elements) {
      if (el.type === 'count') { si++; continue; }
      const section = built.sections[si];
      if (section === 'points') {
        const lat = el.lat != null ? el.lat : el.center && el.center.lat;
        const lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null) continue;
        out.points.push({ id: el.type[0] + el.id, et: el.type, lat, lon, tags: el.tags || {} });
      } else if (section === 'areaWays') {
        const segs = [];
        geomToSegs(el.geometry, segs);
        if (segs.length < 12) continue;
        // close the ring if Overpass returned an unclosed way
        const g = el.geometry, a = g[0], b = g[g.length - 1];
        if (a && b && (a.lat !== b.lat || a.lon !== b.lon)) segs.push(b.lat, b.lon, a.lat, a.lon);
        out.areas.push({ id: 'w' + el.id, et: 'way', mode: 'ray', tags: el.tags || {}, segs });
        seenAreaIds.add(2400000000 + el.id);
      } else if (section === 'relFull' || section === 'relClipped') {
        const segs = [];
        for (const m of el.members || []) if (m.type === 'way') geomToSegs(m.geometry, segs, section === 'relClipped' ? t.pbox : null);
        seenAreaIds.add(3600000000 + el.id);
        if (!segs.length) continue;
        const rec = { id: 'r' + el.id, et: 'relation', mode: section === 'relFull' ? 'ray' : 'ref', tags: el.tags || {}, segs };
        out.areas.push(rec);
        if (rec.mode === 'ref') relClipped.push([rec, el.id]);
      } else if (section === 'bridges') {
        const segs = [];
        geomToSegs(el.geometry, segs, t.pbox);
        if (segs.length) out.lines.push({ id: 'w' + el.id, et: 'way', tags: el.tags || {}, segs });
      } else if (section === 'isIn') {
        insideIds.set(el.id, el.tags || {});
      }
    }
    const hasIsIn = built.sections.includes('isIn');
    for (const [rec, id] of relClipped) {
      if (hasIsIn) {
        rec.ref = t.center;
        rec.refInside = insideIds.has(3600000000 + id);
      } else {
        rec.mode = 'ray'; // best effort without a reference point
      }
    }
    // areas that contain the whole tile but have no edges near it
    for (const [aid, tags] of insideIds) {
      if (seenAreaIds.has(aid)) continue;
      const id = aid >= 3600000000 ? 'r' + (aid - 3600000000) : 'w' + (aid - 2400000000);
      out.covers.push({ id, et: aid >= 3600000000 ? 'relation' : 'way', tags });
    }
    for (const a of out.areas) a.bbox = segsBBox(a.segs);
    for (const l of out.lines) l.bbox = segsBBox(l.segs);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Feature store: merges cached tiles
  // ---------------------------------------------------------------------------
  class FeatureStore {
    constructor() { this.tiles = new Map(); this.version = 0; this._idx = null; }
    addTile(tile) { this.tiles.set(tile.key, tile); this.version++; this._idx = null; }
    has(key) { return this.tiles.has(key); }
    clear() { this.tiles.clear(); this.version++; this._idx = null; }
    tileAt(lat, lon) { return this.tiles.get(tileKeyFor(lat, lon)); }
    index() {
      if (this._idx) return this._idx;
      const points = new Map(), rayAreas = new Map(), lines = new Map();
      for (const t of this.tiles.values()) {
        for (const p of t.points) if (!points.has(p.id)) points.set(p.id, p);
        for (const a of t.areas) if (a.mode === 'ray' && !rayAreas.has(a.id)) rayAreas.set(a.id, a);
        for (const l of t.lines) lines.set(l.id + '@' + t.key, l);
      }
      // bucket points (~0.002° buckets)
      const B = 0.002, pb = new Map();
      for (const p of points.values()) {
        const k = Math.floor(p.lat / B) + ':' + Math.floor(p.lon / B);
        let arr = pb.get(k); if (!arr) pb.set(k, (arr = [])); arr.push(p);
      }
      this._idx = { points: [...points.values()], pointBuckets: pb, B, rayAreas: [...rayAreas.values()], lines: [...lines.values()] };
      return this._idx;
    }
    pointsIn(b) {
      const idx = this.index(), out = [], B = idx.B;
      for (let a = Math.floor(b.s / B); a <= Math.floor(b.n / B); a++) {
        for (let c = Math.floor(b.w / B); c <= Math.floor(b.e / B); c++) {
          const arr = idx.pointBuckets.get(a + ':' + c);
          if (arr) for (const p of arr) if (bboxContains(b, p.lat, p.lon)) out.push(p);
        }
      }
      return out;
    }
    /** Area features (with categories already resolved) containing the point. */
    areasAt(lat, lon, catsOf) {
      const res = [];
      for (const a of this.index().rayAreas) {
        if (!bboxContains(a.bbox, lat, lon)) continue;
        if (!catsOf(a).length) continue;
        if (rayInside(a.segs, lat, lon)) res.push(a);
      }
      const t = this.tileAt(lat, lon);
      if (t) {
        for (const a of t.areas) {
          if (a.mode !== 'ref' || !catsOf(a).length) continue;
          if (refInsideTest(a, lat, lon)) res.push(a);
        }
        for (const c of t.covers) if (catsOf(c).length) res.push(c);
      }
      return res;
    }
  }

  // ---------------------------------------------------------------------------
  // Cell index: which decor categories each cell carries
  // ---------------------------------------------------------------------------
  function featureName(f) {
    const t = f.tags || {};
    return t.name || t['name:en'] || t.brand || t.operator || t['bridge:name'] || '';
  }

  /**
   * Build typed cells covering bbox for the given options.
   * Returns { grid, cells: Map(key → {key,lat,lon,corners,cats:[],src:[{cat,name,id}]}), lookup }
   */
  function buildCellIndex(store, bbox, opts) {
    opts = Object.assign({}, DEFAULT_OPTS, opts || {});
    const grid = getGrid(opts.grid);
    const typed = new Map();
    const catCache = new Map();
    const catsOf = (f, role) => {
      const ck = f.id + '|' + role;
      let r = catCache.get(ck);
      if (!r) {
        const la = f.lat != null ? f.lat : (f.bbox ? (f.bbox.s + f.bbox.n) / 2 : 0);
        const lo = f.lon != null ? f.lon : (f.bbox ? (f.bbox.w + f.bbox.e) / 2 : 0);
        r = catsFor(f.tags, f.et, role, opts, la, lo);
        catCache.set(ck, r);
      }
      return r;
    };
    const add = (key, cats, f) => {
      let c = typed.get(key);
      if (!c) {
        const g = grid.cell(key);
        c = { key, lat: g.lat, lon: g.lon, corners: g.corners, bbox: g.bbox, cats: [], src: [] };
        typed.set(key, c);
      }
      for (const id of cats) {
        if (!c.cats.includes(id)) c.cats.push(id);
        if (c.src.length < 40) c.src.push({ cat: id, name: featureName(f), id: f.id });
      }
    };
    const frame = expandBBox(bbox, grid.edge);
    // points
    for (const p of store.pointsIn(frame)) {
      const cats = catsOf(p, 'point');
      if (cats.length) add(grid.keyOf(p.lat, p.lon), cats, p);
    }
    // lines (bridges): sample along each segment
    if (opts.bridgeMode !== 'off') {
      const stepDeg = grid.step / M_PER_DEG_LAT;
      for (const l of store.index().lines) {
        if (!bboxOverlap(l.bbox, frame)) continue;
        const cats = catsOf(l, 'line');
        if (!cats.length) continue;
        const s = l.segs;
        for (let k = 0; k < s.length; k += 4) {
          const len = Math.hypot(s[k + 2] - s[k], s[k + 3] - s[k + 1]);
          const n = Math.max(1, Math.ceil(len / stepDeg));
          for (let q = 0; q <= n; q++) {
            const la = s[k] + ((s[k + 2] - s[k]) * q) / n, lo = s[k + 1] + ((s[k + 3] - s[k + 1]) * q) / n;
            if (bboxContains(frame, la, lo)) add(grid.keyOf(la, lo), cats, l);
          }
        }
      }
    }
    // areas: test every cell in the frame
    const areaCats = (a) => catsOf(a, 'area');
    const keys = cellsInBBox(grid, frame);
    for (const key of keys) {
      const g = grid.cell(key);
      const probes = opts.areaRule === 'overlap'
        ? [[g.lat, g.lon], ...g.corners, ...g.corners.map((p, i) => {
          const q = g.corners[(i + 1) % 4]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        })]
        : [[g.lat, g.lon]];
      const hit = new Map();
      for (const [la, lo] of probes) {
        for (const a of store.areasAt(la, lo, areaCats)) hit.set(a.id, a);
      }
      if (opts.areaRule === 'overlap') {
        // small polygons entirely inside the cell
        for (const a of store.index().rayAreas) {
          if (hit.has(a.id) || !bboxOverlap(a.bbox, g.bbox) || !areaCats(a).length) continue;
          if (grid.keyOf(a.segs[0], a.segs[1]) === key) hit.set(a.id, a);
        }
      }
      for (const a of hit.values()) add(key, areaCats(a), a);
    }
    // spatial lookup for detector queries
    const lookup = makeLookup(typed, (bbox.s + bbox.n) / 2, opts.radius);
    return { grid, opts, bbox, cells: typed, lookup };
  }

  function makeLookup(typed, lat0, radius) {
    const dLat = radius / M_PER_DEG_LAT, dLon = radius / mPerDegLon(lat0);
    const buckets = new Map();
    for (const c of typed.values()) {
      if (!c.cats.length) continue;
      const k = Math.floor(c.lat / dLat) + ':' + Math.floor(c.lon / dLon);
      let arr = buckets.get(k); if (!arr) buckets.set(k, (arr = [])); arr.push(c);
    }
    return {
      dLat, dLon,
      near(lat, lon) {
        const a = Math.floor(lat / dLat), b = Math.floor(lon / dLon), res = [];
        for (let i = a - 1; i <= a + 1; i++) for (let j = b - 1; j <= b + 1; j++) {
          const arr = buckets.get(i + ':' + j); if (arr) for (const c of arr) res.push(c);
        }
        return res;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Detector simulation
  // ---------------------------------------------------------------------------
  /** Predict the detector list at (lat, lon). */
  function detect(cellIndex, lat, lon) {
    const { radius, maxShown } = cellIndex.opts;
    const inRange = [];
    for (const c of cellIndex.lookup.near(lat, lon)) {
      const d = distM(lat, lon, c.lat, c.lon);
      if (d <= radius) inRange.push({ cell: c, d });
    }
    inRange.sort((a, b) => a.d - b.d);
    const order = [], counts = {};
    for (const { cell } of inRange) {
      for (const id of cell.cats) {
        counts[id] = (counts[id] || 0) + 1;
        if (!order.includes(id)) order.push(id);
      }
    }
    const shown = order.slice(0, maxShown);
    const hidden = order.slice(maxShown);
    return { inRange, shown, hidden, counts, roadside: shown.length === 0 };
  }

  /**
   * Isolation raster for a target category over bbox.
   * val[k]: -1 target not detectable; otherwise number of OTHER types shown.
   */
  function isolationGrid(cellIndex, bbox, target, maxSamples) {
    maxSamples = maxSamples || 90000;
    const { radius, maxShown } = cellIndex.opts;
    const midLat = (bbox.s + bbox.n) / 2;
    const wM = (bbox.e - bbox.w) * mPerDegLon(midLat), hM = (bbox.n - bbox.s) * M_PER_DEG_LAT;
    const step = Math.max(3, Math.sqrt((wM * hM) / maxSamples));
    const cols = Math.max(1, Math.ceil(wM / step)), rows = Math.max(1, Math.ceil(hM / step));
    const dLat = (bbox.n - bbox.s) / rows, dLon = (bbox.e - bbox.w) / cols;
    const val = new Int8Array(cols * rows), tcount = new Uint8Array(cols * rows);
    const r2 = radius * radius;
    const ky = M_PER_DEG_LAT, kx = mPerDegLon(midLat);
    for (let r = 0; r < rows; r++) {
      const lat = bbox.n - (r + 0.5) * dLat;   // row 0 = north
      for (let c = 0; c < cols; c++) {
        const lon = bbox.w + (c + 0.5) * dLon;
        const near = cellIndex.lookup.near(lat, lon);
        let list = null, union = 0, tc = 0, hasT = false;
        const seen = new Set();
        for (const cell of near) {
          const dy = (cell.lat - lat) * ky, dx = (cell.lon - lon) * kx;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          (list || (list = [])).push([d2, cell]);
          for (const id of cell.cats) {
            if (id === target) { tc++; hasT = true; }
            if (!seen.has(id)) { seen.add(id); union++; }
          }
        }
        const k = r * cols + c;
        tcount[k] = Math.min(255, tc);
        if (!hasT) { val[k] = -1; continue; }
        if (union <= maxShown) { val[k] = Math.min(127, union - 1); continue; }
        // more types than the detector shows: nearest-first cut-off
        list.sort((a, b) => a[0] - b[0]);
        const order = [];
        for (const [, cell] of list) for (const id of cell.cats) {
          if (!order.includes(id)) order.push(id);
        }
        const shown = order.slice(0, maxShown);
        val[k] = shown.includes(target) ? maxShown - 1 : -1;
      }
    }
    return { bbox, cols, rows, step, dLat, dLon, val, tcount, target };
  }

  /** Connected regions of samples matching pred, best (deepest) point of each. */
  function findRegions(ig, pred, limit) {
    const { cols, rows, val } = ig;
    const N = cols * rows;
    const inSet = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (pred(val[k])) inSet[k] = 1;
    // distance (in samples, chessboard) to the nearest sample NOT in the set
    const dist = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let k = 0; k < N; k++) {
      const r = (k / cols) | 0, c = k % cols;
      if (!inSet[k]) { dist[k] = 0; q[qt++] = k; } else if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
        dist[k] = 1; q[qt++] = k; // view edge: unknown beyond → treat as boundary
      }
    }
    while (qh < qt) {
      const k = q[qh++], r = (k / cols) | 0, c = k % cols;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const kk = rr * cols + cc;
        if (dist[kk] === -1) { dist[kk] = dist[k] + 1; q[qt++] = kk; }
      }
    }
    // components
    const comp = new Int32Array(N).fill(-1);
    const regions = [];
    for (let k0 = 0; k0 < N; k0++) {
      if (!inSet[k0] || comp[k0] !== -1) continue;
      const id = regions.length;
      let n = 0, best = k0, sumT = 0;
      const stack = [k0]; comp[k0] = id;
      while (stack.length) {
        const k = stack.pop(); n++; sumT += ig.tcount[k];
        if (dist[k] > dist[best] || (dist[k] === dist[best] && ig.tcount[k] > ig.tcount[best])) best = k;
        const r = (k / cols) | 0, c = k % cols;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const kk = rr * cols + cc;
          if (inSet[kk] && comp[kk] === -1) { comp[kk] = id; stack.push(kk); }
        }
      }
      const r = (best / cols) | 0, c = best % cols;
      regions.push({
        lat: ig.bbox.n - (r + 0.5) * ig.dLat,
        lon: ig.bbox.w + (c + 0.5) * ig.dLon,
        safe: Math.max(0, (dist[best] - 0.5) * ig.step),
        area: n * ig.step * ig.step,
        others: val[best],
        targetCells: ig.tcount[best],
        samples: n,
      });
    }
    regions.sort((a, b) => b.safe - a.safe || b.area - a.area);
    return limit ? regions.slice(0, limit) : regions;
  }

  /** Ranked spot list: pure spots first, then the fewest-overlap spots. */
  function rankSpots(cellIndex, ig, limit) {
    limit = limit || 12;
    const spots = [];
    const levels = [0, 1, 2, 3, 4, 5];
    for (const lv of levels) {
      if (spots.length >= limit) break;
      const regs = findRegions(ig, (v) => v === lv, limit - spots.length);
      for (const r of regs) {
        if (r.samples < 2) continue;
        const det = detect(cellIndex, r.lat, r.lon);
        spots.push(Object.assign(r, { level: lv, detector: det.shown, otherCats: det.shown.filter((x) => x !== ig.target) }));
      }
      if (lv === 0 && spots.length >= 3) break; // enough pure spots: don't pad with impure ones
    }
    return spots;
  }

  // ---------------------------------------------------------------------------
  // Calibration: compare logged detector readings with model variants
  // ---------------------------------------------------------------------------
  function modelVariants(base) {
    const grids = Object.keys(GRID_LABELS);
    const out = [];
    for (const grid of grids) for (const areaRule of ['center', 'overlap'])
      for (const cuisineMode of ['both', 'specific']) for (const bridgeMode of ['named', 'all', 'off']) {
        out.push(Object.assign({}, base, { grid, areaRule, cuisineMode, bridgeMode }));
      }
    return out;
  }
  function describeModel(o) {
    return `${GRID_LABELS[o.grid] || o.grid}; areas: ${o.areaRule === 'center' ? 'cell centre inside' : 'any overlap'}; ` +
      `cuisine: ${o.cuisineMode === 'both' ? 'also counts as Restaurant' : 'replaces Restaurant'}; bridges: ${o.bridgeMode}`;
  }
  function predictAt(store, lat, lon, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts);
    const g = getGrid(o.grid);
    const b = expandBBox({ s: lat, n: lat, w: lon, e: lon }, o.radius + g.edge);
    const idx = buildCellIndex(store, b, o);
    const d = detect(idx, lat, lon);
    return d.roadside ? ['roadside'] : d.shown;
  }
  function scoreReading(pred, obs) {
    const P = new Set(pred), O = new Set(obs);
    let inter = 0;
    for (const x of P) if (O.has(x)) inter++;
    const uni = new Set([...P, ...O]).size;
    return { jaccard: uni ? inter / uni : 1, exact: inter === P.size && inter === O.size, missing: [...O].filter((x) => !P.has(x)), extra: [...P].filter((x) => !O.has(x)) };
  }
  function evaluateModels(store, readings, variants) {
    const res = [];
    for (const v of variants) {
      let sum = 0, exact = 0;
      const details = [];
      for (const r of readings) {
        const pred = predictAt(store, r.lat, r.lon, v);
        const s = scoreReading(pred, r.observed);
        sum += s.jaccard; if (s.exact) exact++;
        details.push({ id: r.id, pred, missing: s.missing, extra: s.extra });
      }
      res.push({ opts: v, label: describeModel(v), score: readings.length ? sum / readings.length : 0, exact, n: readings.length, details });
    }
    res.sort((a, b) => b.score - a.score || b.exact - a.exact);
    return res;
  }

  const api = {
    ENGINE_VERSION, CATEGORIES, CAT, ROADSIDE, DEFAULT_OPTS, GRID_LABELS,
    distM, expandBBox, bboxContains, inJapan, catsFor, cuisineList,
    getGrid, cellsInBBox, latLngToFaceUV, faceUVToLatLng, uvToST, stToUV,
    rayInside, refInsideTest, segCross,
    TILE_DEG, tileKeyFor, tileInfo, tilesForBBox, buildQuery, parseTile,
    FeatureStore, buildCellIndex, detect, isolationGrid, findRegions, rankSpots,
    modelVariants, describeModel, predictAt, scoreReading, evaluateModels,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBEngine = api;
})(typeof self !== 'undefined' ? self : this);
