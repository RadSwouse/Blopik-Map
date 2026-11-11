/* OpenFreeMap vector tiles: fetching (shared by analysis + base map) and a
 * small canvas renderer for the base map. */
(function (root) {
  'use strict';
  const E = root.PBEngine;

  class VectorTiles {
    constructor(tilejsonUrl) {
      this.tilejsonUrl = tilejsonUrl;
      this.template = null; this.version = '';
      this.data = new Map(); this.order = []; this.inflight = new Map();
      this.maxData = 14;
    }
    async init() {
      if (this.template) return;
      if (!this._init) {
        this._init = (async () => {
          const res = await fetch(this.tilejsonUrl);
          if (!res.ok) throw new Error('OpenFreeMap index HTTP ' + res.status);
          const tj = await res.json();
          this.template = (tj.tiles && tj.tiles[0]) || '';
          if (!this.template) throw new Error('OpenFreeMap index has no tile URL');
          this.maxData = tj.maxzoom || 14;
          const m = this.template.match(/\/(\d{4})(\d{2})(\d{2})_/);
          this.version = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
        })();
        this._init.catch(() => { this._init = null; });
      }
      return this._init;
    }
    peek(z, x, y) { return this.data.get(z + '/' + x + '/' + y); }
    /** Decoded tile (layers object) or null for an empty tile. */
    async get(z, x, y) {
      const k = z + '/' + x + '/' + y;
      if (this.data.has(k)) return this.data.get(k);
      if (this.inflight.has(k)) return this.inflight.get(k);
      const p = (async () => {
        await this.init();
        const url = this.template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
            let res;
            try { res = await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(timer); }
            if (res.status === 204 || res.status === 404) { this._put(k, null); return null; }
            if (!res.ok) throw new Error('tile HTTP ' + res.status);
            let u8 = new Uint8Array(await res.arrayBuffer());
            if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) u8 = await gunzip(u8);
            const layers = u8.length ? E.decodeMVT(u8) : null;
            this._put(k, layers);
            return layers;
          } catch (e) {
            lastErr = e.name === 'AbortError' ? new Error('tile download timed out') : e;
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          }
        }
        throw lastErr;
      })();
      this.inflight.set(k, p);
      p.finally(() => this.inflight.delete(k)).catch(() => {});
      return p;
    }
    _put(k, v) {
      this.data.set(k, v); this.order.push(k);
      while (this.order.length > 80) this.data.delete(this.order.shift());
    }
  }
  async function gunzip(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser cannot unzip tiles');
    const ab = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new Uint8Array(ab);
  }

  // ---- base map renderer -----------------------------------------------------
  const LANDCOVER = { wood: '#add19e', grass: '#cdebb0', sand: '#f5e9c6', farmland: '#eef0d5', wetland: '#d6e8d1', ice: '#ddecec', rock: '#e6e2dc' };
  const LANDUSE = {
    commercial: '#f2dad9', retail: '#f2dad9', industrial: '#ebdbe8', cemetery: '#c8dcc8', military: '#f3d9d4', hospital: '#fbecec',
    school: '#f7f1d5', university: '#f7f1d5', college: '#f7f1d5', kindergarten: '#f7f1d5', stadium: '#c9eecd', pitch: '#bfe6c4',
    playground: '#d5f2df', zoo: '#e3f2d6', theme_park: '#efe0f2', railway: '#ebe5e0',
  };
  const ROADS = {
    motorway: ['#e892a2', 6], trunk: ['#f9b29c', 5.5], primary: ['#fcd6a4', 5], secondary: ['#f7fabf', 4.5],
    tertiary: ['#ffffff', 4], minor: ['#ffffff', 3.2], service: ['#ffffff', 2], track: ['#c9b38e', 1.4], path: ['#f6a08e', 1.2],
    raceway: ['#ffc0cb', 2], busway: ['#ffffff', 3],
  };
  const PLACE_MAXZ = { city: 15, town: 15, village: 16, suburb: 16, quarter: 17, neighbourhood: 17, hamlet: 17 };

  function bboxOf(f) {
    if (f._bb) return f._bb;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const part of f.parts) for (const [x, y] of part) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    return (f._bb = [a, b, c, d]);
  }

  /** Render display tile z/x/y from its data tile into a canvas of size px. */
  function renderTile(layers, z, x, y, dz, px) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = px;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2efe9'; ctx.fillRect(0, 0, px, px);
    if (!layers) return cv;
    const k = Math.pow(2, z - dz);
    const sx = (x % k) * 256, sy = (y % k) * 256; // offset of this display tile inside the data tile (display px)
    const scaleDisp = px / 256;
    const prep = (L) => {
      const f = (256 * k * scaleDisp) / L.extent;
      ctx.setTransform(f, 0, 0, f, -sx * scaleDisp, -sy * scaleDisp);
      // visible window in tile units (+ margin)
      const u = L.extent / (256 * k), m = 40 * u;
      return { f, win: [sx * u - m, sy * u - m, (sx + 256) * u + m, (sy + 256) * u + m] };
    };
    const vis = (feat, win) => { const b = bboxOf(feat); return !(b[2] < win[0] || b[0] > win[2] || b[3] < win[1] || b[1] > win[3]); };
    const path = (feat, close) => {
      ctx.beginPath();
      for (const part of feat.parts) {
        part.forEach(([px2, py2], i) => (i ? ctx.lineTo(px2, py2) : ctx.moveTo(px2, py2)));
        if (close) ctx.closePath();
      }
    };
    const fillLayer = (name, colorOf) => {
      const L = layers[name]; if (!L) return;
      const { win } = prep(L);
      for (const ft of L.features) {
        if (ft.type !== 3 || !vis(ft, win)) continue;
        const col = colorOf(ft.tags); if (!col) continue;
        ctx.fillStyle = col; path(ft, true); ctx.fill('evenodd');
      }
    };
    fillLayer('landuse', (t) => LANDUSE[t.class]);
    fillLayer('landcover', (t) => (t.subclass === 'park' || t.subclass === 'garden' ? '#c8facc' : LANDCOVER[t.class]));
    fillLayer('park', () => 'rgba(200,250,204,.45)');
    fillLayer('aeroway', (t) => (t.class === 'aerodrome' ? '#e9e7e2' : (t.class === 'runway' || t.class === 'taxiway' ? '#bbbbcc' : '#dadae0')));
    fillLayer('water', (t) => (t.class === 'swimming_pool' ? '#aad3df' : '#aad3df'));
    // waterways
    let L = layers.waterway;
    if (L) {
      const { f, win } = prep(L);
      ctx.strokeStyle = '#aad3df'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const ft of L.features) {
        if (ft.type !== 2 || !vis(ft, win)) continue;
        const w = ft.tags.class === 'river' ? 3 : ft.tags.class === 'canal' ? 2.5 : 1.2;
        ctx.lineWidth = (w * Math.min(2, Math.pow(2, (z - 15) / 2)) * scaleDisp) / f;
        path(ft, false); ctx.stroke();
      }
    }
    if (z >= 15) {
      L = layers.building;
      if (L) {
        const { f, win } = prep(L);
        ctx.fillStyle = '#d9d0c9'; ctx.strokeStyle = '#c4b6ab'; ctx.lineWidth = (0.6 * scaleDisp) / f;
        for (const ft of L.features) { if (ft.type === 3 && vis(ft, win)) { path(ft, true); ctx.fill('evenodd'); if (z >= 17) ctx.stroke(); } }
      }
    }
    // roads: casing pass then fill pass
    L = layers.transportation;
    if (L) {
      const { f, win } = prep(L);
      const zf = Math.pow(2, (z - 16) * 0.75);
      const items = [];
      for (const ft of L.features) {
        if (ft.type !== 2 || !vis(ft, win)) continue;
        const cls = ft.tags.class;
        if (cls === 'rail' || cls === 'transit') { items.push([ft, 'rail']); continue; }
        if (ROADS[cls]) items.push([ft, cls]);
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [ft, cls] of items) {
        if (cls === 'rail' || cls === 'path' || cls === 'track') continue;
        const w = Math.max(0.8, ROADS[cls][1] * zf);
        ctx.strokeStyle = cls === 'minor' || cls === 'service' || cls === 'tertiary' ? '#c8c2ba' : 'rgba(0,0,0,.22)';
        ctx.lineWidth = ((w + 1.6) * scaleDisp) / f; path(ft, false); ctx.stroke();
      }
      for (const [ft, cls] of items) {
        if (cls === 'rail') {
          ctx.setLineDash([(6 * scaleDisp) / f, (4 * scaleDisp) / f]); ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = (1.5 * scaleDisp) / f;
          path(ft, false); ctx.stroke(); ctx.setLineDash([]); continue;
        }
        const [col, base] = ROADS[cls];
        const w = cls === 'path' || cls === 'track' ? base : Math.max(0.8, base * zf);
        if (cls === 'path') ctx.setLineDash([(3 * scaleDisp) / f, (2 * scaleDisp) / f]);
        ctx.strokeStyle = col; ctx.lineWidth = (w * scaleDisp) / f; path(ft, false); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // labels: places when zoomed out, street names when zoomed in
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    L = layers.place;
    if (L) {
      for (const ft of L.features) {
        const maxz = PLACE_MAXZ[ft.tags.class]; if (!maxz || z > maxz || !ft.tags.name) continue;
        const [qx, qy] = ft.parts[0][0];
        const X = ((qx / L.extent) * 256 * k - sx) * scaleDisp, Y = ((qy / L.extent) * 256 * k - sy) * scaleDisp;
        if (X < 0 || Y < 0 || X > px || Y > px) continue;
        const big = ft.tags.class === 'city' || ft.tags.class === 'town';
        ctx.font = `${big ? 600 : 500} ${(big ? 13 : 11) * scaleDisp}px system-ui, sans-serif`;
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 3 * scaleDisp; ctx.strokeText(ft.tags.name, X, Y);
        ctx.fillStyle = '#333'; ctx.fillText(ft.tags.name, X, Y);
      }
    }
    L = layers.transportation_name;
    if (L && z >= 16) {
      ctx.font = `${10.5 * scaleDisp}px system-ui, sans-serif`;
      const placed = [];
      for (const ft of L.features) {
        if (ft.type !== 2 || !ft.tags.name) continue;
        for (const part of ft.parts) {
          // label the longest segment of each line, rotated along it
          let best = null, bl = 0;
          for (let i = 1; i < part.length; i++) {
            const a = part[i - 1], b = part[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (l > bl) { bl = l; best = [a, b]; }
          }
          if (!best) continue;
          const toPx = ([qx, qy]) => [((qx / L.extent) * 256 * k - sx) * scaleDisp, ((qy / L.extent) * 256 * k - sy) * scaleDisp];
          const A = toPx(best[0]), B = toPx(best[1]);
          const cx = (A[0] + B[0]) / 2, cy = (A[1] + B[1]) / 2, len = Math.hypot(B[0] - A[0], B[1] - A[1]);
          const tw = ctx.measureText(ft.tags.name).width;
          if (len < tw + 10 || cx < 0 || cy < 0 || cx > px || cy > px) continue;
          if (placed.some(([x2, y2]) => Math.hypot(x2 - cx, y2 - cy) < 60 * scaleDisp)) continue;
          placed.push([cx, cy]);
          let ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
          if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
          ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 3 * scaleDisp; ctx.strokeText(ft.tags.name, 0, 0);
          ctx.fillStyle = '#555'; ctx.fillText(ft.tags.name, 0, 0); ctx.restore();
        }
      }
    }
    return cv;
  }

  /** Tile source for SlippyMap that draws OpenFreeMap data. */
  function vectorSource(vt, onReady) {
    const cache = new Map(), order = [];
    return {
      maxNative: 20,
      get(z, x, y, load, dpr) {
        const key = z + '/' + x + '/' + y;
        const hit = cache.get(key);
        if (hit) return hit;
        if (!load) return null;
        const dz = Math.min(z, vt.maxData), k = Math.pow(2, z - dz);
        const dx = Math.floor(x / k), dy = Math.floor(y / k);
        const rec = { ok: false, img: null };
        cache.set(key, rec); order.push(key);
        while (order.length > 300) cache.delete(order.shift());
        vt.get(dz, dx, dy).then((layers) => {
          rec.img = renderTile(layers, z, x, y, dz, Math.round(256 * Math.min(2, dpr || 1)));
          rec.ok = true; onReady();
        }).catch(() => { rec.err = true; cache.delete(key); });
        return rec;
      },
    };
  }
  function rasterSource(url, subs, onReady) {
    const cache = new Map(), order = [];
    return {
      maxNative: 19,
      get(z, x, y, load, dpr) {
        const key = z + '/' + x + '/' + y;
        let t = cache.get(key);
        if (t || !load) return t || null;
        const img = new Image();
        t = { img, ok: false };
        img.onload = () => { t.ok = true; onReady(); };
        img.onerror = () => { t.err = true; };
        img.src = url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', subs[(x + y) % subs.length]).replace('{r}', dpr > 1.5 ? '@2x' : '');
        cache.set(key, t); order.push(key);
        while (order.length > 400) cache.delete(order.shift());
        return t;
      },
    };
  }

  root.PBVector = { VectorTiles, vectorSource, rasterSource, renderTile };
})(typeof self !== 'undefined' ? self : this);
