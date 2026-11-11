/* Pikmin Bloom Decor Finder — engine (pure logic, no DOM).
 * Works in the browser (window.PBEngine) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const ENGINE_VERSION = '2.2.0';
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
        id, label: GRID_LABELS[id] || id, edge, step: edge * 0.12,
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
  function segsBBox(segs) {
    let s = 90, n = -90, w = 180, e = -180;
    for (let k = 0; k < segs.length; k += 2) {
      const la = segs[k], lo = segs[k + 1];
      if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
    }
    return { s, w, n, e };
  }

  // ---------------------------------------------------------------------------
  // Web-Mercator tile maths (OpenFreeMap serves z0–14; analysis uses z14)
  // ---------------------------------------------------------------------------
  const DATA_Z = 14;
  function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
  function latToTileY(lat, z) {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z));
  }
  function tileXToLon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
  function tileYToLat(y, z) { const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z); return Math.atan(Math.sinh(n)) / DEG; }
  function tileKeyFor(lat, lon) { return lonToTileX(lon, DATA_Z) + '/' + latToTileY(lat, DATA_Z); }
  function tileInfo(key) {
    const [x, y] = key.split('/').map(Number);
    const bbox = { s: tileYToLat(y + 1, DATA_Z), n: tileYToLat(y, DATA_Z), w: tileXToLon(x, DATA_Z), e: tileXToLon(x + 1, DATA_Z) };
    return { key, x, y, z: DATA_Z, bbox, center: [(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2] };
  }
  function tilesForBBox(b) {
    const keys = [];
    const x0 = lonToTileX(b.w, DATA_Z), x1 = lonToTileX(b.e, DATA_Z);
    const y0 = latToTileY(b.n, DATA_Z), y1 = latToTileY(b.s, DATA_Z);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(x + '/' + y);
    return keys;
  }

  // ---------------------------------------------------------------------------
  // Mapbox Vector Tile (protobuf) decoder — just what we need, no dependencies
  // ---------------------------------------------------------------------------
  const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  class Pbf {
    constructor(u8) { this.b = u8; this.p = 0; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
    varint() {
      let val = 0, mul = 1, byte;
      do { byte = this.b[this.p++]; val += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
      return val;
    }
    svarint() { const n = this.varint(); return n % 2 === 1 ? -(n + 1) / 2 : n / 2; }
    string(len) { const s = utf8.decode(this.b.subarray(this.p, this.p + len)); this.p += len; return s; }
    skip(wt) {
      if (wt === 0) this.varint();
      else if (wt === 1) this.p += 8;
      else if (wt === 2) { const l = this.varint(); this.p += l; }
      else if (wt === 5) this.p += 4;
      else throw new Error('Bad wire type ' + wt);
    }
  }
  function decodeValue(pbf, end) {
    let v = null;
    while (pbf.p < end) {
      const tag = pbf.varint(), f = tag >> 3, wt = tag & 7;
      if (f === 1) v = pbf.string(pbf.varint());
      else if (f === 2) { v = pbf.dv.getFloat32(pbf.p, true); pbf.p += 4; }
      else if (f === 3) { v = pbf.dv.getFloat64(pbf.p, true); pbf.p += 8; }
      else if (f === 4 || f === 5) v = pbf.varint();
      else if (f === 6) v = pbf.svarint();
      else if (f === 7) v = !!pbf.varint();
      else pbf.skip(wt);
    }
    return v;
  }
  /** Decode an MVT tile → { layerName: { extent, features: [{type, tags, parts}] } }.
   *  parts: arrays of [x, y] in tile units; polygon rings are closed. */
  function decodeMVT(u8) {
    const pbf = new Pbf(u8), layers = {};
    while (pbf.p < u8.length) {
      const tag = pbf.varint(), f = tag >> 3, wt = tag & 7;
      if (f !== 3 || wt !== 2) { pbf.skip(wt); continue; }
      const end = pbf.varint() + pbf.p;
      let name = '', extent = 4096;
      const keys = [], values = [], raw = [];
      while (pbf.p < end) {
        const t2 = pbf.varint(), f2 = t2 >> 3, w2 = t2 & 7;
        if (f2 === 1) name = pbf.string(pbf.varint());
        else if (f2 === 2) { const l = pbf.varint(); raw.push([pbf.p, pbf.p + l]); pbf.p += l; }
        else if (f2 === 3) keys.push(pbf.string(pbf.varint()));
        else if (f2 === 4) { const l = pbf.varint(); values.push(decodeValue(pbf, pbf.p + l)); }
        else if (f2 === 5) extent = pbf.varint();
        else pbf.skip(w2);
      }
      const features = [];
      for (const [s, e] of raw) {
        pbf.p = s;
        const feat = { type: 0, tags: {}, parts: [] };
        let geom = null;
        while (pbf.p < e) {
          const t3 = pbf.varint(), f3 = t3 >> 3, w3 = t3 & 7;
          if (f3 === 2) {
            const fe = pbf.varint() + pbf.p;
            while (pbf.p < fe) { const k = pbf.varint(), v = pbf.varint(); feat.tags[keys[k]] = values[v]; }
          } else if (f3 === 3) feat.type = pbf.varint();
          else if (f3 === 4) {
            const ge = pbf.varint() + pbf.p; geom = [];
            while (pbf.p < ge) geom.push(pbf.varint());
          } else pbf.skip(w3);
        }
        if (geom) feat.parts = decodeGeom(geom);
        features.push(feat);
      }
      pbf.p = end;
      layers[name] = { extent, features };
    }
    return layers;
  }
  function decodeGeom(g) {
    const parts = [];
    let x = 0, y = 0, cur = null, i = 0;
    const zz = (n) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
    while (i < g.length) {
      const ci = g[i++], cmd = ci & 7, count = Math.floor(ci / 8);
      if (cmd === 1) {
        for (let c = 0; c < count; c++) { x += zz(g[i++]); y += zz(g[i++]); cur = [[x, y]]; parts.push(cur); }
      } else if (cmd === 2) {
        for (let c = 0; c < count; c++) { x += zz(g[i++]); y += zz(g[i++]); if (cur) cur.push([x, y]); }
      } else if (cmd === 7) {
        if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
      } else break;
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // OpenMapTiles schema → OSM-like tags, so the same decor table applies
  // ---------------------------------------------------------------------------
  const POI_KEY = {};
  for (const c of CATEGORIES) for (const [k, v] of c.tags) if (!POI_KEY[v]) POI_KEY[v] = k;
  const STATION_SUB = new Set(['station', 'subway', 'light_rail', 'monorail']);
  const WATER_CLASSES = new Set(['lake', 'river', 'pond']);
  const LANDCOVER_TAGS = { forest: ['landuse', 'forest'], wood: ['natural', 'wood'], park: ['leisure', 'park'], beach: ['natural', 'beach'] };
  const LANDUSE_TAGS = { stadium: ['leisure', 'stadium'], university: ['amenity', 'university'], college: ['amenity', 'college'], zoo: ['tourism', 'zoo'], theme_park: ['tourism', 'theme_park'] };

  function poiTags(t) {
    const tags = { name: t.name || t['name:latin'] || t.name_en || '', _src: 'poi:' + t.class + '/' + t.subclass };
    const cls = t.class, sub = t.subclass;
    if (cls === 'place_of_worship') tags.amenity = 'place_of_worship';
    else if (cls === 'railway' && STATION_SUB.has(sub)) tags.railway = 'station';
    else if (sub === 'bus_stop') tags.highway = 'bus_stop';
    else if (sub && POI_KEY[sub]) tags[POI_KEY[sub]] = sub;
    else return null;
    return tags;
  }

  /** Convert a decoded z14 tile into the compact record the analysis uses. */
  function vtileToRecord(layers, x, y) {
    const t = tileInfo(x + '/' + y);
    const rec = { key: t.key, x, y, bbox: t.bbox, center: t.center, points: [], areas: [], lines: [], topup: null };
    const n = Math.pow(2, DATA_Z);
    const toLL = (ext, px, py) => {
      const lon = ((x + px / ext) / n) * 360 - 180;
      const m = Math.PI - (2 * Math.PI * (y + py / ext)) / n;
      return [Math.atan(Math.sinh(m)) / DEG, lon];
    };
    let seq = 0;
    const addPoint = (ext, f, tags, layer) => {
      for (const part of f.parts) for (const [px, py] of part) {
        if (px < 0 || py < 0 || px >= ext || py >= ext) continue; // buffer copy: owned by neighbour tile
        const [lat, lon] = toLL(ext, px, py);
        rec.points.push({ id: `${layer}:${t.key}:${seq++}`, et: 'node', lat, lon, tags });
      }
    };
    const addArea = (ext, f, tags, layer) => {
      const segs = [];
      for (const ring of f.parts) {
        const ll = ring.map(([px, py]) => toLL(ext, px, py));
        for (let k = 1; k < ll.length; k++) segs.push(ll[k - 1][0], ll[k - 1][1], ll[k][0], ll[k][1]);
        const a = ll[0], b = ll[ll.length - 1];
        if (ll.length > 2 && (a[0] !== b[0] || a[1] !== b[1])) segs.push(b[0], b[1], a[0], a[1]);
      }
      if (segs.length >= 12) rec.areas.push({ id: `${layer}:${t.key}:${seq++}`, et: 'way', tags, segs, bbox: segsBBox(segs) });
    };
    const addLine = (ext, f, tags, layer) => {
      const segs = [];
      for (const line of f.parts) {
        const ll = line.map(([px, py]) => toLL(ext, px, py));
        for (let k = 1; k < ll.length; k++) segs.push(ll[k - 1][0], ll[k - 1][1], ll[k][0], ll[k][1]);
      }
      if (segs.length) rec.lines.push({ id: `${layer}:${t.key}:${seq++}`, et: 'way', tags, segs, bbox: segsBBox(segs) });
    };
    const L = (name) => (layers[name] ? layers[name] : { extent: 4096, features: [] });

    let ly = L('poi');
    for (const f of ly.features) { const tags = poiTags(f.tags); if (tags) addPoint(ly.extent, f, tags, 'poi'); }
    ly = L('mountain_peak');
    for (const f of ly.features) if (f.tags.class === 'peak' || f.tags.class === 'volcano') addPoint(ly.extent, f, { natural: 'peak', name: f.tags.name || '', _src: 'mountain_peak' }, 'peak');
    ly = L('landcover');
    for (const f of ly.features) {
      const m = LANDCOVER_TAGS[f.tags.subclass];
      if (m && f.type === 3) addArea(ly.extent, f, { [m[0]]: m[1], _src: 'landcover:' + f.tags.subclass }, 'landcover');
    }
    ly = L('landuse');
    for (const f of ly.features) {
      const m = LANDUSE_TAGS[f.tags.class];
      if (m && f.type === 3) addArea(ly.extent, f, { [m[0]]: m[1], _src: 'landuse:' + f.tags.class }, 'landuse');
    }
    ly = L('water');
    for (const f of ly.features) {
      if (f.type === 3 && WATER_CLASSES.has(f.tags.class)) addArea(ly.extent, f, { natural: 'water', water: f.tags.class, _src: 'water:' + f.tags.class }, 'water');
    }
    ly = L('aeroway');
    for (const f of ly.features) if (f.type === 3 && f.tags.class === 'aerodrome') addArea(ly.extent, f, { aeroway: 'aerodrome', _src: 'aeroway' }, 'aeroway');
    ly = L('transportation');
    for (const f of ly.features) if (f.type === 2 && f.tags.brunnel === 'bridge') addLine(ly.extent, f, { bridge: 'yes', highway: f.tags.class || '', _src: 'transportation' }, 'bridge');
    ly = L('transportation_name');
    for (const f of ly.features) if (f.type === 2 && f.tags.brunnel === 'bridge' && f.tags.name) addLine(ly.extent, f, { bridge: 'yes', name: f.tags.name, _src: 'transportation_name' }, 'bridgename');
    return rec;
  }

  // ---------------------------------------------------------------------------
  // Top-up from Overpass for tags OpenMapTiles drops: cuisine=*, and
  // shop=appliance / pastry / craft (checked against openmaptiles/layers/poi/mapping.yaml).
  // ---------------------------------------------------------------------------
  const CUISINE_VALUES = [...new Set(CATEGORIES.flatMap((c) => c.cuisine))];
  const TOPUP_SHOPS = ['appliance', 'pastry', 'craft'];
  const TOPUP_CATS = new Set(CATEGORIES.filter((c) => c.cuisine.length || c.tags.some(([k, v]) => k === 'shop' && TOPUP_SHOPS.includes(v))).map((c) => c.id));
  function topupQuery(tileKey) {
    const b = tileInfo(tileKey).bbox;
    const bb = [b.s, b.w, b.n, b.e].map((v) => v.toFixed(6)).join(',');
    return `[out:json][timeout:25];(nwr["cuisine"~"${CUISINE_VALUES.join('|')}"](${bb});nwr["shop"~"^(${TOPUP_SHOPS.join('|')})$"](${bb}););out tags center qt;`;
  }
  /** Keep only the tags OpenMapTiles lacks, so top-up points never double-count. */
  function topupTags(t) {
    const out = { _src: 'overpass top-up' };
    if (t.name) out.name = t.name;
    if (t.cuisine) out.cuisine = t.cuisine;
    if (t.amenity === 'restaurant' || t.amenity === 'fast_food') out._amenity = t.amenity;
    if (TOPUP_SHOPS.includes(t.shop)) out.shop = t.shop;
    return out;
  }
  function elementsToPoints(json, prefix) {
    if (!json || !Array.isArray(json.elements)) throw new Error('Unexpected Overpass response');
    if (json.remark && /error/i.test(json.remark)) throw new Error('Overpass: ' + json.remark);
    const out = [];
    for (const el of json.elements) {
      const lat = el.lat != null ? el.lat : el.center && el.center.lat;
      const lon = el.lon != null ? el.lon : el.center && el.center.lon;
      if (lat == null) continue;
      out.push({ id: prefix + el.type[0] + el.id, et: 'node', lat, lon, tags: el.tags || {} });
    }
    return out;
  }
  function parseTopup(json, tileKey) {
    const b = tileInfo(tileKey).bbox;
    return elementsToPoints(json, 'tu:').filter((p) => bboxContains(b, p.lat, p.lon))
      .map((p) => Object.assign(p, { tags: topupTags(p.tags), topup: true }));
  }
  // Back-compat names used by older tests/UI
  const cuisineQuery = topupQuery, parseCuisine = parseTopup;

  /** One Overpass query listing every place of a point decor type around a spot. */
  function candidateQuery(target, lat, lon, radiusM) {
    const c = CAT[target];
    if (!c || c.kind !== 'point') return null;
    const around = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})`;
    const parts = c.tags.map(([k, v]) => `nwr["${k}"="${v}"]${around};`);
    if (c.cuisine.length) parts.push(`nwr["cuisine"~"${c.cuisine.join('|')}"]${around};`);
    return `[out:json][timeout:25];(${parts.join('')});out tags center qt;`;
  }
  /** Candidate places for the target (sorted nearest first). Places whose tag
   *  OpenMapTiles lacks are returned with topup:true so they can be added to the store. */
  function parseCandidates(json, target, lat, lon, opts) {
    opts = Object.assign({}, DEFAULT_OPTS, opts || {});
    const out = [];
    for (const p of elementsToPoints(json, 'cand:')) {
      if (!catsFor(p.tags, 'node', 'point', opts, p.lat, p.lon).includes(target)) continue;
      const tt = topupTags(p.tags);
      const viaTopup = catsFor(tt, 'node', 'point', opts, p.lat, p.lon).includes(target);
      out.push({ lat: p.lat, lon: p.lon, name: p.tags.name || '', d: distM(lat, lon, p.lat, p.lon),
        topupPoint: viaTopup ? { id: 'tu:' + p.id.slice(5), et: 'node', lat: p.lat, lon: p.lon, tags: tt, topup: true } : null });
    }
    return out.sort((a, b) => a.d - b.d);
  }
  /** Target places in an already-loaded/converted tile record (for the tile-scan fallback). */
  function tileCandidates(rec, target, opts) {
    opts = Object.assign({}, DEFAULT_OPTS, opts || {});
    const out = [];
    for (const p of rec.points) if (catsFor(p.tags, p.et, 'point', opts, p.lat, p.lon).includes(target)) out.push({ lat: p.lat, lon: p.lon, name: p.tags.name || '' });
    for (const a of rec.areas) {
      if (!catsFor(a.tags, a.et, 'area', opts, (a.bbox.s + a.bbox.n) / 2, (a.bbox.w + a.bbox.e) / 2).includes(target)) continue;
      out.push({ lat: (a.bbox.s + a.bbox.n) / 2, lon: (a.bbox.w + a.bbox.e) / 2, bbox: a.bbox, name: a.tags.name || '' });
    }
    for (const l of rec.lines) {
      if (!catsFor(l.tags, l.et, 'line', opts, l.segs[0], l.segs[1]).includes(target)) continue;
      out.push({ lat: l.segs[0], lon: l.segs[1], name: l.tags.name || '' });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Feature store: holds converted z14 tiles. Areas are tile-local (vector
  // tiles clip polygons per tile), so an inside-test uses the point's own tile.
  // ---------------------------------------------------------------------------
  class FeatureStore {
    constructor() { this.tiles = new Map(); this.extra = new Map(); this.version = 0; this._idx = null; }
    addTile(tile) { this.tiles.delete(tile.key); this.tiles.set(tile.key, tile); this.version++; this._idx = null; }
    setTopup(key, points) { const t = this.tiles.get(key); if (t) { t.topup = points; this.version++; this._idx = null; } }
    setCuisine(key, points) { this.setTopup(key, points); }
    /** Extra top-up points not tied to a tile (from deep-search candidate queries). */
    addExtra(points) { let n = 0; for (const p of points) if (!this.extra.has(p.id)) { this.extra.set(p.id, p); n++; } if (n) { this.version++; this._idx = null; } }
    has(key) { return this.tiles.has(key); }
    hasTopup(key) { const t = this.tiles.get(key); return !!(t && t.topup); }
    hasCuisine(key) { return this.hasTopup(key); }
    clear() { this.tiles.clear(); this.extra.clear(); this.version++; this._idx = null; }
    /** Drop least-recently-added tiles beyond max, never dropping keys in keep. */
    prune(max, keep) {
      if (this.tiles.size <= max) return;
      for (const k of [...this.tiles.keys()]) {
        if (this.tiles.size <= max) break;
        if (!keep || !keep.has(k)) this.tiles.delete(k);
      }
      this.version++; this._idx = null;
    }
    tileAt(lat, lon) { return this.tiles.get(tileKeyFor(lat, lon)); }
    index() {
      if (this._idx) return this._idx;
      const points = [], lines = [];
      const seenTopup = new Set();
      for (const t of this.tiles.values()) if (t.topup) for (const p of t.topup) seenTopup.add(p.id);
      for (const p of this.extra.values()) if (!seenTopup.has(p.id)) points.push(p);
      for (const t of this.tiles.values()) {
        for (const p of t.points) points.push(p);
        if (t.topup) for (const p of t.topup) points.push(p);
        for (const l of t.lines) lines.push(l);
      }
      const B = 0.002, pb = new Map();
      for (const p of points) {
        const k = Math.floor(p.lat / B) + ':' + Math.floor(p.lon / B);
        let arr = pb.get(k); if (!arr) pb.set(k, (arr = [])); arr.push(p);
      }
      this._idx = { points, pointBuckets: pb, B, lines };
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
    /** Area features containing the point (tested against the point's own tile). */
    areasAt(lat, lon, catsOf) {
      const t = this.tileAt(lat, lon), res = [];
      if (!t) return res;
      for (const a of t.areas) {
        if (!bboxContains(a.bbox, lat, lon) || !catsOf(a).length) continue;
        if (rayInside(a.segs, lat, lon)) res.push(a);
      }
      return res;
    }
    /** Area features in the tile(s) overlapping a bbox (for small-polygon checks). */
    areasNear(b) {
      const res = [];
      for (const k of tilesForBBox(b)) { const t = this.tiles.get(k); if (t) for (const a of t.areas) if (bboxOverlap(a.bbox, b)) res.push(a); }
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
    // points (cuisine top-up points only contribute cuisine decor)
    const pts = store.pointsIn(frame);
    const cuisinePts = pts.filter((p) => p.topup && p.tags.cuisine);
    const suppressed = new Set();
    if (opts.cuisineMode === 'specific' && cuisinePts.length) {
      // the vector-tile copy of a cuisine place loses its generic Restaurant/Burger decor
      for (const p of pts) {
        if (p.topup || !(p.tags.amenity === 'restaurant' || p.tags.amenity === 'fast_food')) continue;
        for (const q of cuisinePts) {
          if (distM(p.lat, p.lon, q.lat, q.lon) < 40 && (!p.tags.name || !q.tags.name || p.tags.name === q.tags.name) && catsOf(q, 'point').length) { suppressed.add(p.id); break; }
        }
      }
    }
    for (const p of pts) {
      let cats = catsOf(p, 'point');
      if (p.topup) cats = cats.filter((id) => TOPUP_CATS.has(id));
      if (suppressed.has(p.id)) cats = cats.filter((id) => !CAT[id].generic);
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
        for (const a of store.areasNear(g.bbox)) {
          if (hit.has(a.id) || !areaCats(a).length) continue;
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

  /** Chessboard distance (in samples) from each in-set sample to the nearest
   *  sample outside the set; the raster edge counts as outside (unknown). */
  function distanceTransform(ig, inSet) {
    const { cols, rows } = ig;
    const N = cols * rows;
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
    return dist;
  }

  /** Connected regions of samples matching pred, best (deepest) point of each. */
  function findRegions(ig, pred, limit) {
    const { cols, rows, val } = ig;
    const N = cols * rows;
    const inSet = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (pred(val[k])) inSet[k] = 1;
    const dist = distanceTransform(ig, inSet);
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

  /**
   * Closest point to (lat, lon) where the target shows with exactly `level`
   * other types and you can drift at least minSafe metres without leaving the zone.
   */
  function nearestSpot(ig, lat, lon, level, minSafe) {
    const { cols, rows, val } = ig;
    const N = cols * rows, inSet = new Uint8Array(N);
    let any = false;
    for (let k = 0; k < N; k++) if (val[k] === level) { inSet[k] = 1; any = true; }
    if (!any) return null;
    const dist = distanceTransform(ig, inSet);
    const need = Math.max(1, Math.ceil((minSafe || 0) / ig.step + 0.5));
    let best = -1, bestD = Infinity;
    for (let k = 0; k < N; k++) {
      if (!inSet[k] || dist[k] < need) continue;
      const r = (k / cols) | 0, c = k % cols;
      const d = distM(lat, lon, ig.bbox.n - (r + 0.5) * ig.dLat, ig.bbox.w + (c + 0.5) * ig.dLon);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) return null;
    const r = (best / cols) | 0, c = best % cols;
    return {
      lat: ig.bbox.n - (r + 0.5) * ig.dLat, lon: ig.bbox.w + (c + 0.5) * ig.dLon,
      distance: bestD, safe: Math.max(0, (dist[best] - 0.5) * ig.step), level, targetCells: ig.tcount[best],
    };
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
    rayInside, segCross,
    DATA_Z, tileKeyFor, tileInfo, tilesForBBox, lonToTileX, latToTileY, tileXToLon, tileYToLat,
    decodeMVT, vtileToRecord, poiTags, cuisineQuery, parseCuisine, CUISINE_VALUES,
    TOPUP_SHOPS, TOPUP_CATS, topupQuery, parseTopup, topupTags, candidateQuery, parseCandidates, tileCandidates,
    FeatureStore, buildCellIndex, detect, isolationGrid, findRegions, rankSpots, nearestSpot, distanceTransform,
    modelVariants, describeModel, predictAt, scoreReading, evaluateModels,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBEngine = api;
})(typeof self !== 'undefined' ? self : this);
