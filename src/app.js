/* Pikmin Bloom Decor Finder — app/UI */
(function () {
  'use strict';
  const E = window.PBEngine;
  const $ = (s) => document.querySelector(s);
  const html = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const APP_VERSION = '1.0.0';
  const LS_KEY = 'pbdecor.v1';
  const CACHE_V = 'c1';
  const MIN_LOAD_ZOOM = 14.5;
  const MAX_VIEW_M = 3200;
  const DEFAULT_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const BASEMAPS = {
    carto: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: ['a', 'b', 'c', 'd'], attr: '© OpenStreetMap contributors · © CARTO', label: 'Clean (CARTO Voyager)' },
    osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: ['a'], attr: '© OpenStreetMap contributors', label: 'OpenStreetMap standard' },
  };
  const LEVEL_COLORS = ['#16a34a', '#eab308', '#f97316', '#ef4444'];

  // --------------------------------------------------------------------------
  // State + persistence
  // --------------------------------------------------------------------------
  const saved = load();
  const state = {
    target: saved.target || null,
    opts: Object.assign({}, E.DEFAULT_OPTS, saved.opts || {}),
    settings: Object.assign({
      basemap: 'carto', date: '', endpoint: 'auto', customEndpoint: '', ttlDays: 30,
      showCells: true, showHeat: true, heatOpacity: 0.5,
    }, saved.settings || {}),
    view: saved.view || { lat: 35.6812, lon: 139.7671, zoom: 16 },
    readings: Array.isArray(saved.readings) ? saved.readings : [],
    store: new E.FeatureStore(),
    index: null, ig: null, spots: [], heat: null,
    probe: null, probeDet: null, me: null, live: false,
    cal: { lat: null, lon: null, src: null, sel: new Set(), note: '' },
    calResults: null, isolatable: null, failedTiles: new Set(),
    tab: 'spots',
  };
  function load() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        target: state.target, opts: state.opts, settings: state.settings,
        view: { lat: map.lat, lon: map.lon, zoom: map.zoom }, readings: state.readings,
      }));
    } catch (e) { /* storage unavailable: fine */ }
  }

  // --------------------------------------------------------------------------
  // Tile cache (IndexedDB with in-memory fallback)
  // --------------------------------------------------------------------------
  const cache = {
    mem: new Map(), db: null, tried: false,
    async open() {
      if (this.tried) return this.db; this.tried = true;
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('pbdecor', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('tiles');
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      } catch (e) { this.db = null; }
      return this.db;
    },
    key(k) { return CACHE_V + '|' + (state.settings.date || 'live') + '|' + k; },
    async get(k) {
      const key = this.key(k);
      if (this.mem.has(key)) return this.mem.get(key);
      const db = await this.open(); if (!db) return null;
      try {
        return await new Promise((res) => {
          const r = db.transaction('tiles').objectStore('tiles').get(key);
          r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
        });
      } catch (e) { return null; }
    },
    async set(k, v) {
      const key = this.key(k); this.mem.set(key, v);
      const db = await this.open(); if (!db) return;
      try { db.transaction('tiles', 'readwrite').objectStore('tiles').put(v, key); } catch (e) { /* quota etc. */ }
    },
    async clear() {
      this.mem.clear();
      const db = await this.open(); if (!db) return;
      try { db.transaction('tiles', 'readwrite').objectStore('tiles').clear(); } catch (e) { /* ignore */ }
    },
  };

  // --------------------------------------------------------------------------
  // Overpass with endpoint fallback, query-variant fallback, concurrency limit
  // --------------------------------------------------------------------------
  class QueryError extends Error {}
  function endpoints() {
    const list = DEFAULT_ENDPOINTS.slice();
    const custom = (state.settings.customEndpoint || '').trim();
    if (custom) list.unshift(custom);
    let pref = null; try { pref = localStorage.getItem('pbdecor.ep'); } catch (e) { /* */ }
    if (state.settings.endpoint !== 'auto') return [state.settings.endpoint === 'custom' ? custom : state.settings.endpoint, ...list].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    if (pref && list.includes(pref)) list.splice(list.indexOf(pref), 1), list.unshift(pref);
    return list;
  }
  async function overpass(query) {
    let lastErr = null;
    for (const ep of endpoints()) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 80000);
      try {
        const res = await fetch(ep, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (res.status === 400) throw new QueryError((await res.text()).slice(0, 400));
        if (!res.ok) { lastErr = new Error(ep.split('/')[2] + ' HTTP ' + res.status); continue; }
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory|too busy/i.test(json.remark)) { lastErr = new Error(json.remark); continue; }
        try { localStorage.setItem('pbdecor.ep', ep); } catch (e) { /* */ }
        return json;
      } catch (e) {
        if (e instanceof QueryError) throw e;
        lastErr = e.name === 'AbortError' ? new Error(ep.split('/')[2] + ' timed out') : e;
      } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('No Overpass server reachable');
  }
  async function fetchTile(key) {
    let qerr = null;
    for (const variant of ['full', 'safe', 'minimal']) {
      const built = E.buildQuery(key, { variant, date: state.settings.date });
      try { return E.parseTile(await overpass(built.query), built); } catch (e) {
        if (e instanceof QueryError) { qerr = e; console.warn('Query variant', variant, 'rejected:', e.message); continue; }
        throw e;
      }
    }
    throw qerr;
  }
  const inflight = new Map();
  let active = 0; const waiters = [];
  async function slot() { if (active < 2) { active++; return; } await new Promise((r) => waiters.push(r)); active++; }
  function release() { active--; const w = waiters.shift(); if (w) w(); }
  function getTile(key) {
    if (state.store.has(key)) return Promise.resolve(true);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const c = await cache.get(key);
      const ttl = state.settings.ttlDays * 864e5;
      if (c && c.fetched && Date.now() - c.fetched < ttl) { state.store.addTile(c); return true; }
      await slot();
      try {
        let tile, err;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { tile = await fetchTile(key); break; } catch (e) { err = e; if (e instanceof QueryError) break; await new Promise((r) => setTimeout(r, 2500)); }
        }
        if (!tile) {
          if (c) { state.store.addTile(c); return true; } // stale cache beats nothing
          throw err;
        }
        state.store.addTile(tile); state.failedTiles.delete(key); cache.set(key, tile);
        return true;
      } finally { release(); }
    })();
    inflight.set(key, p);
    p.catch(() => state.failedTiles.add(key)).finally(() => inflight.delete(key));
    return p;
  }
  async function ensureTiles(keys, onProgress) {
    let done = 0;
    const total = keys.length;
    const errors = [];
    await Promise.all(keys.map((k) => getTile(k).catch((e) => errors.push(e)).finally(() => { done++; onProgress && onProgress(done, total); })));
    return errors;
  }

  // --------------------------------------------------------------------------
  // Map
  // --------------------------------------------------------------------------
  const bm = BASEMAPS[state.settings.basemap] || BASEMAPS.carto;
  const map = new window.SlippyMap($('#map'), { lat: state.view.lat, lon: state.view.lon, zoom: state.view.zoom, tileUrl: bm.url, subdomains: bm.sub, maxZoom: 20.5 });
  const attr = document.createElement('div');
  attr.style.cssText = 'position:fixed;right:62px;z-index:4;font-size:10px;background:rgba(255,255,255,.8);padding:1px 5px;border-radius:4px;color:#333';
  document.body.appendChild(attr);
  function placeAttr() { attr.textContent = (BASEMAPS[state.settings.basemap] || BASEMAPS.carto).attr; attr.style.bottom = `calc(${getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')} + 2px)`; if (innerWidth >= 900) attr.style.bottom = '2px'; }

  function sheetPx() { return innerWidth >= 900 ? 0 : sheetFrac * innerHeight; }
  /** Animate so (lat, lon) sits in the middle of the map area not covered by the sheet. */
  function frame(lat, lon, zoom) {
    const z = zoom == null ? map.zoom : zoom;
    const visibleCy = (map.h - sheetPx()) / 2;
    const [px, py] = map.project(lat, lon, z);
    const [clat, clon] = map.unproject(px, py + (map.h / 2 - visibleCy), z);
    map.animateTo(clat, clon, z);
  }

  function viewBBox() {
    const b = map.getBounds();
    const midLat = (b.s + b.n) / 2;
    const wM = E.distM(midLat, b.w, midLat, b.e), hM = E.distM(b.s, b.w, b.n, b.w);
    if (wM <= MAX_VIEW_M && hM <= MAX_VIEW_M) return b;
    const c = { s: map.lat, n: map.lat, w: map.lon, e: map.lon };
    return E.expandBBox(c, MAX_VIEW_M / 2);
  }

  // ---- layers ----
  function poly(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([la, lo], i) => { const [x, y] = map.toScreen(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  }
  function circle(ctx, lat, lon, rM) {
    const [x, y] = map.toScreen(lat, lon);
    ctx.beginPath(); ctx.arc(x, y, Math.max(1, rM / map.metersPerPixel(lat)), 0, Math.PI * 2);
  }
  map.layers.push(function heatLayer(ctx) {
    if (!state.settings.showHeat || !state.heat || !state.ig) return;
    const b = state.ig.bbox;
    const [x0, y0] = map.toScreen(b.n, b.w), [x1, y1] = map.toScreen(b.s, b.e);
    ctx.globalAlpha = state.settings.heatOpacity;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(state.heat, x0, y0, x1 - x0, y1 - y0);
  });
  map.layers.push(function cellLayer(ctx) {
    if (!state.settings.showCells || !state.index || map.zoom < 14.5) return;
    const vb = map.getBounds();
    const t = state.target;
    const cellPx = state.index.grid.edge / map.metersPerPixel();
    ctx.lineWidth = 1;
    for (const c of state.index.cells.values()) {
      if (c.bbox.n < vb.s || c.bbox.s > vb.n || c.bbox.e < vb.w || c.bbox.w > vb.e) continue;
      const isT = t && c.cats.includes(t);
      const h = E.CAT[c.cats[0]].hue;
      poly(ctx, c.corners);
      ctx.fillStyle = isT ? 'rgba(22,163,74,.38)' : (t ? 'rgba(100,116,139,.16)' : `hsla(${h},75%,55%,.22)`);
      ctx.strokeStyle = isT ? '#15803d' : (t ? 'rgba(71,85,105,.55)' : `hsla(${h},70%,35%,.7)`);
      ctx.fill(); ctx.stroke();
    }
    if (cellPx >= 20) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = Math.min(18, cellPx / 3.2);
      ctx.font = `${fs}px system-ui, "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji", sans-serif`;
      for (const c of state.index.cells.values()) {
        if (c.bbox.n < vb.s || c.bbox.s > vb.n || c.bbox.e < vb.w || c.bbox.w > vb.e) continue;
        const [x, y] = map.toScreen(c.lat, c.lon);
        const ic = c.cats.slice(0, 3).map((id) => E.CAT[id].icon).join('') + (c.cats.length > 3 ? '+' : '');
        ctx.globalAlpha = t && !c.cats.includes(t) ? 0.7 : 1;
        ctx.fillText(ic, x, y);
      }
      ctx.globalAlpha = 1;
    }
  });
  map.layers.push(function spotLayer(ctx) {
    if (!state.target || !state.spots.length) return;
    state.spots.forEach((s, i) => {
      const col = LEVEL_COLORS[Math.min(3, s.level)];
      if (s.safe > 3) {
        circle(ctx, s.lat, s.lon, s.safe);
        ctx.strokeStyle = col; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      }
      const [x, y] = map.toScreen(s.lat, s.lon);
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = s.level === 1 ? '#422006' : '#fff';
      ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    });
  });
  map.layers.push(function probeLayer(ctx) {
    const p = state.probe; if (!p) return;
    const r = state.opts.radius;
    circle(ctx, p.lat, p.lon, r);
    ctx.fillStyle = 'rgba(37,99,235,.07)'; ctx.fill();
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]);
    if (state.probeDet) {
      for (const { cell } of state.probeDet.inRange) {
        poly(ctx, cell.corners); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.2; ctx.stroke();
        const [x, y] = map.toScreen(cell.lat, cell.lon);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#2563eb'; ctx.fill();
      }
    }
    const [x, y] = map.toScreen(p.lat, p.lon);
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#2563eb'; ctx.fill();
  });
  map.layers.push(function meLayer(ctx) {
    const m = state.me; if (!m) return;
    if (m.acc) { circle(ctx, m.lat, m.lon, m.acc); ctx.fillStyle = 'rgba(14,165,233,.12)'; ctx.fill(); }
    const [x, y] = map.toScreen(m.lat, m.lon);
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#0ea5e9'; ctx.fill();
  });

  // --------------------------------------------------------------------------
  // Analysis pipeline
  // --------------------------------------------------------------------------
  let analyzeToken = 0, lastIndexKey = '';
  function setStatus(msg, cls) {
    const el = $('#status');
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.className = 'pill ' + (cls || ''); el.innerHTML = msg;
  }
  async function analyze() {
    persist();
    const token = ++analyzeToken;
    if (map.zoom < MIN_LOAD_ZOOM) {
      setStatus('Zoom in to load decor data');
      renderLegend();
      return;
    }
    const vb = viewBBox();
    const grid = E.getGrid(state.opts.grid);
    const need = E.tilesForBBox(E.expandBBox(vb, state.opts.radius + grid.edge + 40));
    const missing = need.filter((k) => !state.store.has(k));
    if (missing.length) setStatus(`Loading decor data… 0/${missing.length}`, 'busy');
    const errors = await ensureTiles(missing, (d, t) => { if (token === analyzeToken) setStatus(`Loading decor data… ${d}/${t}`, 'busy'); });
    if (token !== analyzeToken) return;
    const failed = need.filter((k) => !state.store.has(k));
    setStatus('Analysing…', 'busy');
    await new Promise((r) => setTimeout(r, 0));
    if (token !== analyzeToken) return;
    const key = [state.store.version, JSON.stringify(state.opts), vb.s.toFixed(5), vb.w.toFixed(5), vb.n.toFixed(5), vb.e.toFixed(5)].join('|');
    if (key !== lastIndexKey) {
      state.index = E.buildCellIndex(state.store, E.expandBBox(vb, state.opts.radius), state.opts);
      state.index.view = vb;
      state.isolatable = null;
      lastIndexKey = key;
      runTarget();
    }
    refreshProbe();
    const nTarget = state.target ? [...state.index.cells.values()].filter((c) => c.cats.includes(state.target)).length : 0;
    if (failed.length) {
      const msg = errors[0] ? html(errors[0].message || errors[0]) : 'server busy';
      setStatus(`⚠️ ${failed.length} of ${need.length} map areas failed (${msg}). <button class="btn sm" id="retry">Retry</button>`, 'warn');
      const b = $('#retry'); if (b) b.onclick = () => { lastIndexKey = ''; analyze(); };
    } else if (state.target) {
      const pure = state.spots.filter((s) => s.level === 0).length;
      setStatus(`${E.CAT[state.target].icon} ${nTarget} cell${nTarget === 1 ? '' : 's'} · ${pure} pure spot${pure === 1 ? '' : 's'}`);
    } else setStatus(`${state.index.cells.size} decor cells in view`);
    renderAll();
    map.redraw();
  }
  function runTarget() {
    state.ig = null; state.spots = []; state.heat = null;
    if (!state.target || !state.index) return;
    const samples = Math.min(120000, Math.max(30000, map.w * map.h / 6));
    state.ig = E.isolationGrid(state.index, state.index.view, state.target, samples);
    state.spots = E.rankSpots(state.index, state.ig, 10);
    state.heat = heatCanvas(state.ig);
  }
  function heatCanvas(ig) {
    const c = document.createElement('canvas');
    c.width = ig.cols; c.height = ig.rows;
    const cx = c.getContext('2d'), img = cx.createImageData(ig.cols, ig.rows);
    const cols = [[22, 163, 74], [234, 179, 8], [249, 115, 22], [239, 68, 68]];
    for (let k = 0; k < ig.val.length; k++) {
      const v = ig.val[k]; if (v < 0) continue;
      const [r, g, b] = cols[Math.min(3, v)];
      img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = v === 0 ? 255 : 190;
    }
    cx.putImageData(img, 0, 0);
    return c;
  }
  let moveTimer = 0;
  map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(analyze, 350); });

  // detector at the probe point
  async function refreshProbe() {
    const p = state.probe;
    if (!p) { state.probeDet = null; return; }
    const idx = state.index;
    const inner = idx && E.expandBBox(idx.bbox, -state.opts.radius);
    if (idx && inner.s < inner.n && E.bboxContains(inner, p.lat, p.lon)) {
      state.probeDet = E.detect(idx, p.lat, p.lon);
    } else {
      const grid = E.getGrid(state.opts.grid);
      const b = E.expandBBox({ s: p.lat, n: p.lat, w: p.lon, e: p.lon }, state.opts.radius + grid.edge);
      await ensureTiles(E.tilesForBBox(E.expandBBox(b, 40)));
      const local = E.buildCellIndex(state.store, b, state.opts);
      state.probeDet = E.detect(local, p.lat, p.lon);
    }
  }
  async function setProbe(lat, lon, openTab) {
    state.probe = { lat, lon };
    await refreshProbe();
    if (openTab) showTab('detector');
    renderDetector(); renderLegend(); map.redraw();
  }
  map.on('click', (e) => {
    if (state.tab === 'calibrate') {
      state.cal.lat = e.lat; state.cal.lon = e.lon; state.cal.src = 'map';
      setProbe(e.lat, e.lon, false).then(renderCalibrate);
      return;
    }
    setProbe(e.lat, e.lon, true);
  });

  // --------------------------------------------------------------------------
  // UI rendering
  // --------------------------------------------------------------------------
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms || 2600);
  }
  function catLabel(id) { return id === 'roadside' ? E.ROADSIDE.icon + ' Roadside' : `${E.CAT[id].icon} ${E.CAT[id].name}`; }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'; }
  function refPoint() { return state.me || { lat: map.lat, lon: map.lon }; }
  function dirLink(lat, lon) { return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=walking`; }

  function renderAll() { renderPickLabel(); renderSpots(); renderDetector(); renderLegend(); if (state.tab === 'calibrate') renderCalibrate(); }
  function renderPickLabel() {
    $('#pickLabel').textContent = state.target ? E.CAT[state.target].name : 'Choose a decor type';
    $('#pick .ico').textContent = state.target ? E.CAT[state.target].icon : '🎯';
  }
  function renderLegend() {
    const el = $('#legend');
    if (state.target && state.settings.showHeat && state.ig) {
      el.innerHTML = `<span><i style="background:${LEVEL_COLORS[0]}"></i>Only ${html(E.CAT[state.target].name)}</span>` +
        `<span><i style="background:${LEVEL_COLORS[1]}"></i>+1 other</span><span><i style="background:${LEVEL_COLORS[2]}"></i>+2</span><span><i style="background:${LEVEL_COLORS[3]}"></i>+3 or more</span>`;
      el.hidden = false;
    } else if (state.probe) {
      el.innerHTML = '<span><i style="background:#2563eb"></i>Detector range · cells whose centre (dot) is inside count</span>';
      el.hidden = false;
    } else el.hidden = true;
  }

  function renderSpots() {
    const el = $('#p-spots');
    if (!state.target) {
      el.innerHTML = `<h3>Find a spot for one decor type</h3>
        <p class="muted">Tap <b>🎯 Choose a decor type</b> at the top. The map turns <b style="color:${LEVEL_COLORS[0]}">green</b> wherever that type is the <i>only</i> one the detector should find, so its seedling is guaranteed to be that decor.</p>
        ${isolatableHtml()}`;
      bindIsolatable(el);
      return;
    }
    const c = E.CAT[state.target];
    if (map.zoom < MIN_LOAD_ZOOM) { el.innerHTML = `<p class="muted">Zoom in to search for ${html(c.name)} spots.</p>`; return; }
    if (!state.index) { el.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const nCells = [...state.index.cells.values()].filter((x) => x.cats.includes(state.target)).length;
    const ref = refPoint();
    let out = `<div class="row" style="justify-content:space-between"><h3>${c.icon} ${html(c.name)}</h3><span class="muted small">${nCells} cell${nCells === 1 ? '' : 's'} in view</span></div>`;
    if (!nCells) {
      out += `<p class="muted">No ${html(c.name)} locations in OpenStreetMap in this view. Pan or zoom out a little (data loads up to ~3 km across).</p>${isolatableHtml()}`;
      el.innerHTML = out; bindIsolatable(el); return;
    }
    if (!state.spots.length) out += '<p class="muted">The target shows up here, but always alongside many other types.</p>';
    const pureCount = state.spots.filter((s) => s.level === 0).length;
    if (!pureCount && state.spots.length) out += `<p class="muted">No pure spot in this view. These have the fewest other types. Try panning to nearby areas.</p>`;
    state.spots.forEach((s, i) => {
      const d = E.distM(ref.lat, ref.lon, s.lat, s.lon);
      const others = s.otherCats.map((id) => E.CAT[id].icon).join(' ');
      out += `<div class="card ${s.level === 0 ? 'pure' : ''}">
        <div class="spot-h"><span class="num l${Math.min(3, s.level)}">${i + 1}</span>
          <span>${s.level === 0 ? `Only ${c.icon} ${html(c.name)}` : `${c.icon} + ${s.level} other${s.level > 1 ? 's' : ''}: <span class="icons">${others}</span>`}</span></div>
        <div class="muted small" style="margin:4px 0 8px">
          ${s.level === 0 ? 'Guaranteed decor if the map data matches the game.' : `Your guaranteed seedling is one of ${s.level + 1} types.`}
          Safe zone ±${Math.round(s.safe)} m · ${fmtDist(d)} away · ${s.targetCells} ${html(c.name)} cell${s.targetCells === 1 ? '' : 's'} in range</div>
        <div class="row"><button class="btn sm" data-go="${i}">Show</button>
          <a class="btn sm" href="${dirLink(s.lat, s.lon)}" target="_blank" rel="noopener">Walk there ↗</a>
          <button class="btn sm" data-copy="${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}">Copy coords</button></div></div>`;
    });
    out += `<p class="muted small">Safe zone = how far you can drift (GPS error) and still be in the same zone. Prefer spots with ±15 m or more.</p>`;
    el.innerHTML = out;
    el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => {
      const s = state.spots[+b.dataset.go];
      if (innerWidth < 900) setSheet(0.3);
      frame(s.lat, s.lon, Math.max(map.zoom, 17));
      setProbe(s.lat, s.lon, false);
    });
    el.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyText(b.dataset.copy));
  }
  function isolatableHtml() {
    if (!state.index || map.zoom < MIN_LOAD_ZOOM) return '';
    if (!state.isolatable) {
      const present = new Map();
      for (const c of state.index.cells.values()) for (const id of c.cats) present.set(id, (present.get(id) || 0) + 1);
      const list = [];
      for (const [id, n] of present) {
        const ig = E.isolationGrid(state.index, state.index.view, id, 5000);
        let pure = 0; for (const v of ig.val) if (v === 0) pure++;
        list.push({ id, n, pureM2: pure * ig.step * ig.step });
      }
      list.sort((a, b) => b.pureM2 - a.pureM2 || b.n - a.n);
      state.isolatable = list;
    }
    if (!state.isolatable.length) return '<p class="muted">No decor locations in this view.</p>';
    return `<h3 style="margin-top:14px">In this view</h3><div class="chips">` + state.isolatable.map((x) =>
      `<button class="chip ${x.pureM2 > 0 ? 'target' : ''}" data-t="${x.id}" title="${x.n} cells">${E.CAT[x.id].icon} ${html(E.CAT[x.id].name)}${x.pureM2 > 0 ? ' ★' : ''}</button>`).join('') +
      `</div><p class="muted small">★ = has at least one spot where it is the only type.</p>`;
  }
  function bindIsolatable(el) { el.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => setTarget(b.dataset.t)); }

  function renderDetector() {
    const el = $('#p-detector');
    const p = state.probe, d = state.probeDet;
    if (!p) {
      el.innerHTML = `<h3>Detector preview</h3><p class="muted">Tap anywhere on the map to see what the detector should show there. Turn on 📡 to follow your GPS while walking.</p>`;
      return;
    }
    if (!d) { el.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const t = state.target;
    let out = `<div class="row" style="justify-content:space-between"><h3>Detector here</h3>
      <span class="muted small">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${state.live ? ' · live' : ''}</span></div>`;
    if (t) {
      const only = d.shown.length === 1 && d.shown[0] === t;
      out += only ? `<p><span class="badge ok">Only ${E.CAT[t].icon} ${html(E.CAT[t].name)} — guaranteed!</span></p>`
        : d.shown.includes(t) ? `<p><span class="badge no">${E.CAT[t].icon} plus ${d.shown.length - 1} other type${d.shown.length > 2 ? 's' : ''}</span></p>`
          : `<p><span class="badge no">${E.CAT[t].icon} ${html(E.CAT[t].name)} not in range</span></p>`;
    }
    out += '<div class="detlist">';
    if (d.roadside) out += `<div class="dt"><span>${E.ROADSIDE.icon}</span><span>Roadside</span></div>`;
    d.shown.forEach((id) => { out += `<div class="dt ${id === t ? 't' : ''}"><span>${E.CAT[id].icon}</span><span>${html(E.CAT[id].name)}</span></div>`; });
    d.hidden.forEach((id) => { out += `<div class="dt hid" title="Beyond the ${state.opts.maxShown}-icon limit"><span>${E.CAT[id].icon}</span><span>${html(E.CAT[id].name)}</span></div>`; });
    out += '</div>';
    if (d.hidden.length) out += `<p class="muted small">Faded icons are further away than the ${state.opts.maxShown} nearest types, so they probably won't show.</p>`;
    if (d.inRange.length) {
      out += `<details><summary>Why? ${d.inRange.length} cell${d.inRange.length === 1 ? '' : 's'} in range</summary><table><tr><th>Dist.</th><th>Decor · source</th></tr>`;
      for (const { cell, d: dist } of d.inRange) {
        const seen = new Set();
        const src = cell.src.filter((s) => { const k = s.cat + s.name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6)
          .map((s) => `${E.CAT[s.cat].icon} ${html(s.name || E.CAT[s.cat].name)} <a class="small" href="https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[s.id[0]]}/${s.id.slice(1)}" target="_blank" rel="noopener">osm</a>`).join('<br>');
        out += `<tr><td>${Math.round(dist)} m</td><td>${src}</td></tr>`;
      }
      out += '</table></details>';
    }
    out += `<div class="row" style="margin-top:10px"><button class="btn sm" id="logHere">Log a real detector reading here</button>
      <button class="btn sm" id="clearProbe">Clear</button></div>`;
    el.innerHTML = out;
    $('#logHere').onclick = () => { state.cal.lat = p.lat; state.cal.lon = p.lon; state.cal.src = state.live ? 'gps' : 'map'; showTab('calibrate'); };
    $('#clearProbe').onclick = () => { state.probe = null; state.probeDet = null; renderDetector(); renderLegend(); map.redraw(); };
  }

  // ---- calibration ----
  function renderCalibrate() {
    const el = $('#p-calibrate');
    const c = state.cal;
    const all = [...E.CATEGORIES.map((x) => x.id), 'roadside'];
    let out = `<h3>Log a real detector reading</h3>
      <p class="muted small">Stand still, open the detector and wait for the icons. Then tap the map where you are (or use GPS), tick exactly the icons the game showed, and save. A few readings in varied places let the tool test which cell model matches the game.</p>
      <div class="row" style="margin-bottom:8px"><button class="btn sm" id="calGps">📍 Use my GPS</button>
      <span class="muted small">${c.lat != null ? `Location: ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)} (${c.src === 'gps' ? 'GPS' : 'map tap'})` : 'Tap the map to set the location'}</span></div>
      <input id="calFilter" placeholder="Filter icons…" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px">
      <div class="chips" id="calChips">${all.map((id) => `<button class="chip ${c.sel.has(id) ? 'on' : ''}" data-id="${id}">${html(catLabel(id))}</button>`).join('')}</div>
      <input id="calNote" placeholder="Note (optional), e.g. 'icons appeared after 3 s'" value="${html(c.note)}" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-top:8px">
      <div class="row" style="margin-top:8px"><button class="btn primary" id="calSave" ${c.lat == null || !c.sel.size ? 'disabled' : ''}>Save reading</button>
      <span class="muted small">${c.sel.size} selected</span></div>`;
    out += `<h3 style="margin-top:16px">Readings (${state.readings.length})</h3>`;
    if (state.readings.length) {
      out += '<table>' + state.readings.slice().reverse().map((r) => `<tr><td class="small">${new Date(r.t).toLocaleDateString()}<br>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</td><td class="icons">${r.observed.map((id) => id === 'roadside' ? E.ROADSIDE.icon : (E.CAT[id] ? E.CAT[id].icon : '?')).join(' ')}</td><td><button class="btn sm" data-show="${r.id}">Show</button> <button class="btn sm" data-del="${r.id}">✕</button></td></tr>`).join('') + '</table>';
      out += `<div class="row" style="margin-top:10px"><button class="btn primary" id="calTest">Test cell models against my readings</button></div>`;
    }
    if (state.calResults) out += calResultsHtml();
    out += `<details><summary>Export / import readings</summary>
      <p class="muted small">Export to back up your readings or send them to whoever is tuning the tool.</p>
      <textarea id="calExport" readonly>${html(exportJson())}</textarea>
      <div class="row"><button class="btn sm" id="calCopy">Copy</button><a class="btn sm" id="calDl" download="pikmin-decor-readings.json">Download</a></div>
      <p class="muted small" style="margin-top:10px">Import (paste exported JSON):</p>
      <textarea id="calImport" placeholder='{"readings":[…]}'></textarea>
      <button class="btn sm" id="calImportBtn">Import</button></details>`;
    el.innerHTML = out;
    const filt = $('#calFilter');
    filt.oninput = () => { const q = filt.value.toLowerCase(); el.querySelectorAll('#calChips .chip').forEach((b) => { b.style.display = b.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
    el.querySelectorAll('#calChips .chip').forEach((b) => b.onclick = () => {
      const id = b.dataset.id;
      if (c.sel.has(id)) c.sel.delete(id); else {
        if (id === 'roadside') c.sel.clear(); else c.sel.delete('roadside');
        c.sel.add(id);
      }
      c.note = $('#calNote').value; renderCalibrate();
    });
    $('#calNote').oninput = (e) => { c.note = e.target.value; };
    $('#calGps').onclick = () => locate((pos) => { c.lat = pos.lat; c.lon = pos.lon; c.src = 'gps'; c.acc = pos.acc; setProbe(pos.lat, pos.lon, false); frame(pos.lat, pos.lon, Math.max(map.zoom, 17)); renderCalibrate(); });
    $('#calSave').onclick = () => {
      state.readings.push({ id: Date.now(), t: new Date().toISOString(), lat: +c.lat.toFixed(7), lon: +c.lon.toFixed(7), src: c.src, acc: c.acc || null, observed: [...c.sel], note: c.note || '' });
      c.sel = new Set(); c.note = ''; state.calResults = null; persist(); toast('Reading saved'); renderCalibrate();
    };
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { state.readings = state.readings.filter((r) => String(r.id) !== b.dataset.del); state.calResults = null; persist(); renderCalibrate(); });
    el.querySelectorAll('[data-show]').forEach((b) => b.onclick = () => { const r = state.readings.find((x) => String(x.id) === b.dataset.show); frame(r.lat, r.lon, 17.5); setProbe(r.lat, r.lon, false); });
    const t = $('#calTest'); if (t) t.onclick = testModels;
    $('#calCopy').onclick = () => copyText($('#calExport').value);
    try { $('#calDl').href = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' })); } catch (e) { /* */ }
    $('#calImportBtn').onclick = () => {
      try {
        const data = JSON.parse($('#calImport').value);
        const arr = Array.isArray(data) ? data : data.readings;
        let added = 0;
        for (const r of arr || []) {
          if (typeof r.lat !== 'number' || !Array.isArray(r.observed)) continue;
          if (!r.id) r.id = Date.now() + added;
          if (state.readings.some((x) => x.id === r.id)) continue;
          state.readings.push(r); added++;
        }
        persist(); state.calResults = null; toast(`Imported ${added} reading${added === 1 ? '' : 's'}`); renderCalibrate();
      } catch (e) { toast('Could not read that JSON'); }
    };
    el.querySelectorAll('[data-use]').forEach((b) => b.onclick = () => {
      const r = state.calResults.list[+b.dataset.use];
      Object.assign(state.opts, { grid: r.opts.grid, areaRule: r.opts.areaRule, cuisineMode: r.opts.cuisineMode, bridgeMode: r.opts.bridgeMode });
      toast('Model applied'); lastIndexKey = ''; state.calResults = null; renderSettings(); renderCalibrate(); analyze();
    });
  }
  function exportJson() {
    return JSON.stringify({ app: 'pikmin-decor-finder', version: APP_VERSION, exported: new Date().toISOString(), model: state.opts, osmDate: state.settings.date || 'live', readings: state.readings }, null, 1);
  }
  async function testModels() {
    const btn = $('#calTest'); btn.disabled = true; btn.textContent = 'Loading map data…';
    const keys = new Set();
    for (const r of state.readings) {
      const b = E.expandBBox({ s: r.lat, n: r.lat, w: r.lon, e: r.lon }, state.opts.radius + 200);
      E.tilesForBBox(b).forEach((k) => keys.add(k));
    }
    const errs = await ensureTiles([...keys], (d, t) => { btn.textContent = `Loading map data… ${d}/${t}`; });
    btn.textContent = 'Testing models…';
    await new Promise((r) => setTimeout(r, 30));
    const list = E.evaluateModels(state.store, state.readings, E.modelVariants(state.opts));
    const curKey = JSON.stringify([state.opts.grid, state.opts.areaRule, state.opts.cuisineMode, state.opts.bridgeMode]);
    const current = list.find((r) => JSON.stringify([r.opts.grid, r.opts.areaRule, r.opts.cuisineMode, r.opts.bridgeMode]) === curKey);
    state.calResults = { list, current, errs: errs.length };
    renderCalibrate();
  }
  function calResultsHtml() {
    const { list, current, errs } = state.calResults;
    const top = list.slice(0, 8);
    let out = `<h3 style="margin-top:14px">Model fit</h3>
      <p class="muted small">Score = average overlap between predicted and observed icons (100% = identical). Exact = readings matched perfectly.${errs ? ` ⚠️ ${errs} map area(s) failed to load.` : ''}</p>
      <table><tr><th>Score</th><th>Exact</th><th>Model</th><th></th></tr>`;
    top.forEach((r, i) => {
      out += `<tr><td><b>${Math.round(r.score * 100)}%</b></td><td>${r.exact}/${r.n}</td><td class="small">${html(r.label)}</td><td><button class="btn sm" data-use="${i}">Use</button></td></tr>`;
    });
    out += '</table>';
    if (current) {
      out += `<p class="small">Current model: <b>${Math.round(current.score * 100)}%</b> (${current.exact}/${current.n} exact)</p>`;
      const bad = current.details.filter((d) => d.missing.length || d.extra.length);
      if (bad.length) {
        out += `<details><summary>Mismatches with the current model (${bad.length})</summary><table>`;
        for (const d of bad) {
          const r = state.readings.find((x) => x.id === d.id);
          out += `<tr><td class="small">${r ? r.lat.toFixed(4) + ', ' + r.lon.toFixed(4) : ''}</td><td class="small">${d.missing.length ? 'Game showed, tool missed: ' + d.missing.map(catLabel).join(', ') + '<br>' : ''}${d.extra.length ? 'Tool predicted, game didn\'t: ' + d.extra.map(catLabel).join(', ') : ''}</td></tr>`;
        }
        out += '</table><p class="muted small">"Game showed, tool missed" often means the game has a place (from Foursquare or older OSM data) that today\'s OSM lacks. "Tool predicted" can mean the place was added to OSM after the game\'s last map update.</p></details>';
      }
    }
    return out;
  }

  // ---- settings ----
  function renderSettings() {
    const el = $('#p-settings');
    const o = state.opts, s = state.settings;
    const opt = (v, label, cur) => `<option value="${html(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${html(label)}</option>`;
    el.innerHTML = `<h3>Cell model</h3>
      <div class="kv">
        <label for="sGrid">Cell grid</label><select id="sGrid">${Object.entries(E.GRID_LABELS).map(([k, v]) => opt(k, v, o.grid)).join('')}</select>
        <label for="sArea">Parks, water…</label><select id="sArea">${opt('center', 'Count a cell if its centre is inside', o.areaRule)}${opt('overlap', 'Count a cell if any part overlaps', o.areaRule)}</select>
        <label for="sCuis">Cuisine places</label><select id="sCuis">${opt('both', 'Also count as Restaurant/Burger', o.cuisineMode)}${opt('specific', 'Cuisine decor only', o.cuisineMode)}</select>
        <label for="sBridge">Bridges</label><select id="sBridge">${opt('named', 'Named bridges only', o.bridgeMode)}${opt('all', 'All bridge=yes ways', o.bridgeMode)}${opt('off', 'Ignore bridges', o.bridgeMode)}</select>
        <label for="sRad">Detector range (m)</label><input id="sRad" type="number" min="20" max="300" step="5" value="${o.radius}">
        <label for="sMax">Max icons shown</label><input id="sMax" type="number" min="1" max="12" value="${o.maxShown}">
      </div>
      <p class="muted small">Defaults come from Pikipedia (100 m range, cell centre must be in range). S2 level 17 is the best guess so far: about 6 of its cells fit in the 100 m circle, matching the 6–7 icon limit. Use Calibrate to check.</p>
      <h3 style="margin-top:14px">Data</h3>
      <div class="kv">
        <label for="sDate">OSM data as of</label><input id="sDate" type="date" value="${html(s.date)}">
        <label for="sEp">Overpass server</label><select id="sEp">${opt('auto', 'Automatic (fastest that works)', s.endpoint)}${DEFAULT_ENDPOINTS.map((u) => opt(u, u.split('/')[2], s.endpoint)).join('')}${opt('custom', 'Custom…', s.endpoint)}</select>
        <label for="sCustom">Custom URL</label><input id="sCustom" placeholder="https://…/api/interpreter" value="${html(s.customEndpoint)}">
        <label for="sTtl">Keep data (days)</label><input id="sTtl" type="number" min="1" max="365" value="${s.ttlDays}">
      </div>
      <p class="muted small">Leave the date empty to use today's OSM. The game refreshed its map in October 2026, so recent OSM edits may not be in the game yet. Setting a date (e.g. 2026-09-01) asks Overpass for the map as it was then. Those queries are slower, and big polygons may be less exact.</p>
      <div class="row"><button class="btn sm" id="sClear">Clear downloaded data</button></div>
      <h3 style="margin-top:14px">Display</h3>
      <div class="kv">
        <label for="sBase">Base map</label><select id="sBase">${Object.entries(BASEMAPS).map(([k, v]) => opt(k, v.label, s.basemap)).join('')}</select>
        <label for="sOp">Heatmap opacity</label><input id="sOp" type="range" min="0.15" max="0.9" step="0.05" value="${s.heatOpacity}">
      </div>
      <p class="muted small" style="margin-top:14px">v${APP_VERSION} · engine ${E.ENGINE_VERSION}</p>`;
    const on = (id, fn) => { $(id).onchange = fn; };
    const remodel = () => { lastIndexKey = ''; persist(); analyze(); };
    on('#sGrid', (e) => { o.grid = e.target.value; remodel(); });
    on('#sArea', (e) => { o.areaRule = e.target.value; remodel(); });
    on('#sCuis', (e) => { o.cuisineMode = e.target.value; remodel(); });
    on('#sBridge', (e) => { o.bridgeMode = e.target.value; remodel(); });
    on('#sRad', (e) => { o.radius = Math.max(20, Math.min(300, +e.target.value || 100)); remodel(); });
    on('#sMax', (e) => { o.maxShown = Math.max(1, Math.min(12, +e.target.value || 6)); remodel(); });
    on('#sDate', (e) => { s.date = e.target.value; state.store.clear(); remodel(); });
    on('#sEp', (e) => { s.endpoint = e.target.value; persist(); });
    on('#sCustom', (e) => { s.customEndpoint = e.target.value.trim(); persist(); });
    on('#sTtl', (e) => { s.ttlDays = Math.max(1, +e.target.value || 30); persist(); });
    on('#sBase', (e) => { s.basemap = e.target.value; const b = BASEMAPS[s.basemap]; map.setTileUrl(b.url, b.sub); placeAttr(); persist(); });
    $('#sOp').oninput = (e) => { s.heatOpacity = +e.target.value; map.redraw(); persist(); };
    $('#sClear').onclick = async () => { await cache.clear(); state.store.clear(); toast('Downloaded data cleared'); remodel(); };
  }

  function renderHelp() {
    $('#p-help').innerHTML = `<h3>How it works</h3>
      <p class="small">The game decides a seedling's decor from the map <b>cell</b> it was found in. The detector looks at every cell whose <b>centre</b> is within <b>100 m</b> of you and shows the decor types in those cells. One seedling is always one of the shown types. So if only one type is in range, that seedling is guaranteed to be that type.</p>
      <p class="small">This tool downloads OpenStreetMap places for the area (one combined query per ~1 km tile, cached on your device). It works out each cell's decor types, then tests every point on the map to see which types the detector would list there.</p>
      <h3>Colours</h3>
      <p class="small"><b style="color:${LEVEL_COLORS[0]}">Green</b>: only your decor type in range. <b style="color:#a16207">Yellow</b>/<b style="color:${LEVEL_COLORS[2]}">orange</b>/<b style="color:${LEVEL_COLORS[3]}">red</b>: 1/2/3+ other types too. Uncoloured: your type is out of range. Cells with your type are outlined green; other decor cells are grey.</p>
      <h3>Tips in the game</h3>
      <ul class="small">
        <li>The detector's icon list stays fixed until you move <b>25 m</b> from where it last scanned. Open the detector only once you're standing in the green zone. If the icons look stale, walk 25 m away and come back.</li>
        <li>Check the icons the game shows before using the detector. If only your type appears, you're set.</li>
        <li>Choose spots with a big safe zone so GPS drift doesn't push you out.</li>
      </ul>
      <h3>Limits</h3>
      <ul class="small">
        <li>The game also uses Foursquare and maybe other sources, so some decor places aren't in OSM. The game also updates its map copy only occasionally (most recently October 2026).</li>
        <li>The cell grid and the polygon rules aren't published. Use <b>Calibrate</b> to log real detector readings and test which model matches.</li>
        <li>Weather and event decor don't depend on location and aren't covered.</li>
      </ul>
      <p class="muted small">Data © OpenStreetMap contributors (ODbL), via the Overpass API. Tag mapping from Pikipedia's Decor Pikmin page. Unofficial fan tool; not affiliated with Niantic or Nintendo.</p>`;
  }

  // ---- picker ----
  function openPicker() {
    $('#picker').classList.add('on');
    const s = $('#pickSearch'); s.value = ''; renderPicker(''); setTimeout(() => s.focus(), 50);
  }
  function renderPicker(q) {
    const counts = new Map();
    if (state.index) for (const c of state.index.cells.values()) for (const id of c.cats) counts.set(id, (counts.get(id) || 0) + 1);
    q = q.toLowerCase();
    const items = E.CATEGORIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.tags.some(([k, v]) => (k + '=' + v).includes(q)) || c.cuisine.some((x) => x.includes(q)))
      .slice().sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.index - b.index);
    $('#pickList').innerHTML = (state.target ? `<button class="pi" data-id=""><span class="ico">🗺️</span><span>Explore all (no target)</span></button>` : '') +
      items.map((c) => `<button class="pi ${c.id === state.target ? 'on' : ''}" data-id="${c.id}"><span class="ico">${c.icon}</span><span>${html(c.name)}<br><span class="muted small">${html([...c.tags.map((t) => t.join('=')), ...(c.cuisine.length ? ['cuisine=' + c.cuisine.join('/')] : [])].join(', '))}</span></span>
        <span class="cnt">${counts.get(c.id) ? `<b>${counts.get(c.id)}</b> in view` : ''}</span></button>`).join('');
    $('#pickList').querySelectorAll('.pi').forEach((b) => b.onclick = () => { $('#picker').classList.remove('on'); setTarget(b.dataset.id || null); });
  }
  function setTarget(id) {
    state.target = id;
    runTarget(); persist(); renderAll(); map.redraw(); showTab('spots');
    if (map.zoom < MIN_LOAD_ZOOM) toast('Zoom in to search');
    analyze();
  }

  // ---- tabs + sheet ----
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'p-' + name));
    if (name === 'calibrate') renderCalibrate();
    if (name === 'settings') renderSettings();
    if (innerWidth < 900 && sheetFrac < 0.3) setSheet(0.42);
  }
  let sheetFrac = 0.42;
  function setSheet(f) {
    sheetFrac = Math.max(0.12, Math.min(0.88, f));
    document.documentElement.style.setProperty('--sheet-h', (sheetFrac * 100).toFixed(1) + 'vh');
    placeAttr();
  }
  (function bindGrab() {
    const g = $('#grab'); let start = null;
    g.addEventListener('pointerdown', (e) => { g.setPointerCapture(e.pointerId); start = { y: e.clientY, f: sheetFrac, moved: false }; });
    g.addEventListener('pointermove', (e) => { if (!start) return; const dy = e.clientY - start.y; if (Math.abs(dy) > 4) start.moved = true; setSheet(start.f - dy / innerHeight); });
    g.addEventListener('pointerup', () => { if (start && !start.moved) setSheet(sheetFrac > 0.3 ? 0.14 : 0.42); start = null; });
  })();

  // ---- geolocation ----
  function locate(cb) {
    if (!navigator.geolocation) { toast('Location is not available in this browser'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      state.me = pos; cb(pos); map.redraw();
    }, (err) => toast('Location error: ' + err.message), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  }
  let watchId = null;
  function toggleLive() {
    state.live = !state.live;
    $('#btnLive').classList.toggle('on', state.live);
    if (!state.live) { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; toast('Live detector off'); return; }
    if (!navigator.geolocation) { toast('Location is not available'); state.live = false; $('#btnLive').classList.remove('on'); return; }
    toast('Live detector on: following your GPS');
    let first = true;
    watchId = navigator.geolocation.watchPosition((p) => {
      state.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      const sx = map.toScreen(state.me.lat, state.me.lon);
      if (first || sx[0] < map.w * 0.2 || sx[0] > map.w * 0.8 || sx[1] < map.h * 0.15 || sx[1] > map.h * 0.6) {
        map.setView(state.me.lat, state.me.lon, first ? Math.max(map.zoom, 17) : null);
        first = false;
      }
      setProbe(state.me.lat, state.me.lon, false).then(() => {
        const d = state.probeDet;
        if (d && state.target) {
          const only = d.shown.length === 1 && d.shown[0] === state.target;
          setStatus(only ? `✅ Here: only ${E.CAT[state.target].icon} ${html(E.CAT[state.target].name)}` : `Here: ${d.roadside ? E.ROADSIDE.icon : d.shown.map((id) => E.CAT[id].icon).join(' ')}`);
        }
      });
    }, (err) => toast('Location error: ' + err.message), { enableHighAccuracy: true, maximumAge: 2000 });
  }

  function copyText(t) {
    const done = () => toast('Copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed: select and copy manually'); }
      ta.remove();
    }
  }

  // --------------------------------------------------------------------------
  // Wire up
  // --------------------------------------------------------------------------
  $('#pick').onclick = openPicker;
  $('#pickClose').onclick = () => $('#picker').classList.remove('on');
  $('#picker').onclick = (e) => { if (e.target.id === 'picker') $('#picker').classList.remove('on'); };
  $('#pickSearch').oninput = (e) => renderPicker(e.target.value);
  document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  $('#btnLocate').onclick = () => locate((pos) => { frame(pos.lat, pos.lon, Math.max(map.zoom, 16.5)); });
  $('#btnLive').onclick = toggleLive;
  $('#btnCells').classList.toggle('on', state.settings.showCells);
  $('#btnHeat').classList.toggle('on', state.settings.showHeat);
  $('#btnCells').onclick = () => { state.settings.showCells = !state.settings.showCells; $('#btnCells').classList.toggle('on', state.settings.showCells); persist(); map.redraw(); };
  $('#btnHeat').onclick = () => { state.settings.showHeat = !state.settings.showHeat; $('#btnHeat').classList.toggle('on', state.settings.showHeat); persist(); renderLegend(); map.redraw(); };
  addEventListener('resize', placeAttr);

  setSheet(innerWidth < 900 ? 0.42 : 0.42);
  renderHelp(); renderSettings(); renderAll();
  if (!saved.view) toast('Tap ◎ to jump to your location', 4000);
  analyze();
  window.PBApp = { state, map, analyze, setTarget, setProbe };
})();
