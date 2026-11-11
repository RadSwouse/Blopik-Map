/* Pikmin Bloom Decor Finder — app/UI */
(function () {
  'use strict';
  const E = window.PBEngine;
  const $ = (s) => document.querySelector(s);
  const html = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const APP_VERSION = '2.1.0';
  // Official decor icons (Pikipedia), inlined by build.py; emoji is the fallback
  const ICONS = window.PB_ICONS || {};
  const ICON_IMG = {};
  for (const [id, src] of Object.entries(ICONS)) { const im = new Image(); im.src = src; ICON_IMG[id] = im; }
  function emojiOf(id) { return id === 'roadside' ? E.ROADSIDE.icon : (E.CAT[id] ? E.CAT[id].icon : '?'); }
  function ic(id) {
    const src = ICONS[id];
    return src ? `<img class="di" src="${src}" alt="${emojiOf(id)}" onerror="this.replaceWith(this.alt)">` : emojiOf(id);
  }
  const LS_KEY = 'pbdecor.v1';
  const MIN_LOAD_ZOOM = 14.5;
  const MAX_VIEW_M = 3200;
  const BASEMAPS = {
    openfreemap: { attr: '© OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors', label: 'OpenFreeMap (drawn from the decor data)' },
    osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: ['a'], attr: '© OpenStreetMap contributors', label: 'OpenStreetMap standard tiles' },
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
      basemap: 'openfreemap', cuisine: 'auto',
      showCells: true, showHeat: true, heatOpacity: 0.5,
    }, saved.settings || {}),
    view: saved.view || { lat: 35.6812, lon: 139.7671, zoom: 16 },
    nearest: null,
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
  // Map data: OpenFreeMap vector tiles (fast, cached by a CDN, no limits)
  // --------------------------------------------------------------------------
  const vt = new window.PBVector.VectorTiles('https://tiles.openfreemap.org/planet');
  const tileJobs = new Map();
  function getTile(key) {
    if (state.store.has(key)) return Promise.resolve(true);
    if (tileJobs.has(key)) return tileJobs.get(key);
    const [x, y] = key.split('/').map(Number);
    const p = vt.get(E.DATA_Z, x, y).then((layers) => {
      state.store.addTile(E.vtileToRecord(layers || {}, x, y));
      state.failedTiles.delete(key);
      return true;
    });
    tileJobs.set(key, p);
    p.catch(() => state.failedTiles.add(key)).finally(() => tileJobs.delete(key));
    return p;
  }
  async function ensureTiles(keys, onProgress) {
    let done = 0;
    const errors = [];
    await Promise.all(keys.map((k) => getTile(k).catch((e) => errors.push(e)).finally(() => { done++; onProgress && onProgress(done, keys.length); })));
    return errors;
  }

  // --------------------------------------------------------------------------
  // Cuisine top-up from Overpass — polite: one request at a time, 30 s+ pause
  // after any "busy" answer, give up after 3 failures (user can retry).
  // --------------------------------------------------------------------------
  const CUISINE_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  const cuisineQ = { queue: [], running: false, cooldownUntil: 0, failures: 0, epIndex: 0, lastError: '', stopped: false };
  function needCuisine() {
    const m = state.settings.cuisine;
    if (m === 'never') return false;
    return m === 'always' || !!(state.target && E.CAT[state.target].cuisine.length);
  }
  function queueCuisine(keys) {
    for (const k of keys) if (state.store.has(k) && !state.store.hasCuisine(k) && !cuisineQ.queue.includes(k)) cuisineQ.queue.push(k);
    runCuisine();
  }
  async function runCuisine() {
    if (cuisineQ.running || cuisineQ.stopped) return;
    cuisineQ.running = true;
    try {
      while (cuisineQ.queue.length) {
        const wait = cuisineQ.cooldownUntil - Date.now();
        if (wait > 0) { renderStatus(); await new Promise((r) => setTimeout(r, Math.min(wait, 1000))); continue; }
        const key = cuisineQ.queue[0];
        if (state.store.hasCuisine(key)) { cuisineQ.queue.shift(); continue; }
        const ep = CUISINE_ENDPOINTS[cuisineQ.epIndex % CUISINE_ENDPOINTS.length];
        renderStatus();
        try {
          const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 40000);
          let res;
          try {
            res = await fetch(ep, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(E.cuisineQuery(key)) });
          } finally { clearTimeout(timer); }
          if (!res.ok) throw new Error(ep.split('/')[2] + ' answered HTTP ' + res.status);
          const pts = E.parseCuisine(await res.json(), key);
          state.store.setCuisine(key, pts);
          cuisineQ.queue.shift(); cuisineQ.failures = 0; cuisineQ.lastError = '';
          scheduleAnalyze();
          await new Promise((r) => setTimeout(r, 1500)); // spacing between requests
        } catch (e) {
          cuisineQ.failures++; cuisineQ.epIndex++;
          cuisineQ.lastError = e.name === 'AbortError' ? 'request timed out' : (e.message || String(e));
          cuisineQ.cooldownUntil = Date.now() + 30000 * cuisineQ.failures;
          if (cuisineQ.failures >= 3) { cuisineQ.stopped = true; cuisineQ.queue = []; break; }
        }
      }
    } finally { cuisineQ.running = false; renderStatus(); renderSpots(); }
  }
  function retryCuisine() { cuisineQ.stopped = false; cuisineQ.failures = 0; cuisineQ.cooldownUntil = 0; lastIndexKey = ''; analyze(); }

  // --------------------------------------------------------------------------
  // Map
  // --------------------------------------------------------------------------
  if (!BASEMAPS[state.settings.basemap]) state.settings.basemap = 'openfreemap';
  const map = new window.SlippyMap($('#map'), { lat: state.view.lat, lon: state.view.lon, zoom: state.view.zoom, maxZoom: 20.5 });
  function applyBasemap() {
    const b = state.settings.basemap;
    map.setSource(b === 'osm' ? window.PBVector.rasterSource(BASEMAPS.osm.url, BASEMAPS.osm.sub, () => map.redraw()) : window.PBVector.vectorSource(vt, () => map.redraw()));
  }
  applyBasemap();
  const attr = document.createElement('div');
  attr.style.cssText = 'position:fixed;right:62px;z-index:4;font-size:10px;background:rgba(255,255,255,.8);padding:1px 5px;border-radius:4px;color:#333;white-space:nowrap;max-width:calc(100% - 70px);overflow:hidden;text-overflow:ellipsis';
  document.body.appendChild(attr);
  function placeAttr() {
    const full = (BASEMAPS[state.settings.basemap] || BASEMAPS.openfreemap).attr;
    attr.textContent = innerWidth < 600 ? full.replace(' · © OpenMapTiles', '').replace('OpenStreetMap contributors', 'OSM contributors') : full;
    $('#legend').style.marginBottom = innerWidth < 900 ? '14px' : ''; attr.style.bottom = `calc(${getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')} + 2px)`; if (innerWidth >= 900) attr.style.bottom = '2px'; }

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
      const sz = Math.max(12, Math.min(22, cellPx / 3.4));
      ctx.font = `${sz * 0.85}px system-ui, "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji", sans-serif`;
      for (const c of state.index.cells.values()) {
        if (c.bbox.n < vb.s || c.bbox.s > vb.n || c.bbox.e < vb.w || c.bbox.w > vb.e) continue;
        const [x, y] = map.toScreen(c.lat, c.lon);
        const ids = c.cats.slice(0, 3);
        const gap = sz + 3, x0 = x - ((ids.length - 1) * gap) / 2;
        ids.forEach((id, i) => {
          const cx = x0 + i * gap, isT = id === t;
          ctx.globalAlpha = t && !isT ? 0.75 : 1;
          ctx.beginPath(); ctx.arc(cx, y, sz / 2 + 2.5, 0, Math.PI * 2);
          ctx.fillStyle = isT ? '#dcfce7' : '#fff'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = isT ? '#15803d' : 'rgba(71,85,105,.6)'; ctx.stroke();
          const im = ICON_IMG[id];
          if (im && im.complete && im.naturalWidth) ctx.drawImage(im, cx - sz * 0.38, y - sz * 0.38, sz * 0.76, sz * 0.76);
          else { ctx.fillStyle = '#111'; ctx.fillText(emojiOf(id), cx, y + 1); }
        });
        if (c.cats.length > 3) {
          ctx.globalAlpha = 1; ctx.fillStyle = '#334155'; ctx.font = `bold ${sz * 0.6}px system-ui, sans-serif`;
          ctx.fillText('+' + (c.cats.length - 3), x0 + 3 * gap - 4, y);
          ctx.font = `${sz * 0.85}px system-ui, sans-serif`;
        }
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
  const statusState = { main: '', cls: '', failed: 0, need: 0, err: '' };
  function renderStatus() {
    let msg = statusState.main, cls = statusState.cls;
    if (statusState.failed) {
      msg = `⚠️ ${statusState.failed} of ${statusState.need} map squares failed (${html(statusState.err || 'network')}). <button class="btn sm" id="retry">Retry</button>`;
      cls = 'warn';
    }
    if (needCuisine() && msg && !statusState.failed) {
      const left = cuisineQ.queue.length;
      if (cuisineQ.stopped) { msg += ` · <span title="${html(cuisineQ.lastError)}">cuisine lookup failed</span> <button class="btn sm" id="retryCu">Retry</button>`; cls = 'warn'; }
      else if (left) {
        const wait = Math.ceil((cuisineQ.cooldownUntil - Date.now()) / 1000);
        msg += wait > 0 ? ` · cuisine server busy, retry in ${wait}s` : ` · loading cuisine data (${left} left)`;
        cls = 'busy';
      }
    }
    setStatus(msg, cls);
    const b = $('#retry'); if (b) b.onclick = () => { lastIndexKey = ''; analyze(); };
    const c = $('#retryCu'); if (c) c.onclick = retryCuisine;
  }
  let schedT = 0;
  function scheduleAnalyze() { clearTimeout(schedT); schedT = setTimeout(analyze, 250); }
  async function analyze() {
    persist();
    const token = ++analyzeToken;
    if (map.zoom < MIN_LOAD_ZOOM) {
      statusState.main = 'Zoom in to load decor data'; statusState.cls = ''; statusState.failed = 0;
      renderStatus(); renderLegend();
      return;
    }
    const vb = viewBBox();
    const grid = E.getGrid(state.opts.grid);
    const need = E.tilesForBBox(E.expandBBox(vb, state.opts.radius + grid.edge + 40));
    const missing = need.filter((k) => !state.store.has(k));
    if (missing.length) { statusState.main = `Loading map data… 0/${missing.length}`; statusState.cls = 'busy'; statusState.failed = 0; renderStatus(); }
    const errors = await ensureTiles(missing, (d, t) => { if (token === analyzeToken) { statusState.main = `Loading map data… ${d}/${t}`; renderStatus(); } });
    if (token !== analyzeToken) return;
    const failed = need.filter((k) => !state.store.has(k));
    if (needCuisine()) queueCuisine(need);
    const key = [state.store.version, JSON.stringify(state.opts), vb.s.toFixed(5), vb.w.toFixed(5), vb.n.toFixed(5), vb.e.toFixed(5)].join('|');
    if (key !== lastIndexKey) {
      statusState.main = 'Analysing…'; statusState.cls = 'busy'; renderStatus();
      await new Promise((r) => setTimeout(r, 0));
      if (token !== analyzeToken) return;
      state.index = E.buildCellIndex(state.store, E.expandBBox(vb, state.opts.radius), state.opts);
      state.index.view = vb;
      state.isolatable = null;
      lastIndexKey = key;
      runTarget();
    }
    await refreshProbe();
    const nTarget = state.target ? [...state.index.cells.values()].filter((c) => c.cats.includes(state.target)).length : 0;
    statusState.failed = failed.length; statusState.need = need.length;
    statusState.err = errors[0] ? (errors[0].message || String(errors[0])) : '';
    statusState.cls = '';
    if (state.target) {
      const pure = state.spots.filter((x) => x.level === 0).length;
      statusState.main = `${ic(state.target)} ${nTarget} cell${nTarget === 1 ? '' : 's'} · ${pure} pure spot${pure === 1 ? '' : 's'}`;
    } else statusState.main = `${state.index.cells.size} decor cells in view`;
    renderStatus();
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
  function catLabel(id) { return id === 'roadside' ? ic('roadside') + ' Roadside' : `${ic(id)} ${html(E.CAT[id].name)}`; }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'; }
  function refPoint() { return state.me || { lat: map.lat, lon: map.lon }; }
  function dirLink(lat, lon) { return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=walking`; }

  function renderAll() { renderPickLabel(); renderSpots(); renderDetector(); renderLegend(); if (state.tab === 'calibrate') renderCalibrate(); }
  function renderPickLabel() {
    $('#pickLabel').textContent = state.target ? E.CAT[state.target].name : 'Choose a decor type';
    $('#pick .ico').innerHTML = state.target ? ic(state.target) : '🎯';
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
    let out = `<div class="row" style="justify-content:space-between"><h3>${ic(c.id)} ${html(c.name)}</h3><span class="muted small">${nCells} cell${nCells === 1 ? '' : 's'} in view</span></div>`;
    out += nearestHtml();
    const cuisinePending = c.cuisine.length && state.settings.cuisine !== 'never' && (cuisineQ.queue.length || cuisineQ.running);
    if (!nCells && cuisinePending) {
      out += `<p class="muted">⏳ Loading cuisine data from the Overpass server. This can take a while when it's busy.</p>`;
      el.innerHTML = out; bindNearest(el); return;
    }
    if (!nCells && c.cuisine.length && (cuisineQ.stopped || state.settings.cuisine === 'never')) {
      out += `<p class="muted">Cuisine data isn't available right now (${state.settings.cuisine === 'never' ? 'turned off in Settings' : 'the Overpass server is busy'}). Restaurants still count as 🍽️ Restaurant.</p>`;
      el.innerHTML = out; bindNearest(el); return;
    }
    if (!nCells) {
      out += `<p class="muted">No ${html(c.name)} locations in OpenStreetMap in this view. Try <b>📍 Find nearest</b>, or pan the map.</p>${isolatableHtml()}`;
      el.innerHTML = out; bindIsolatable(el); bindNearest(el); return;
    }
    if (!state.spots.length) out += '<p class="muted">The target shows up here, but always alongside many other types.</p>';
    const pureCount = state.spots.filter((s) => s.level === 0).length;
    if (!pureCount && state.spots.length) out += `<p class="muted">No pure spot in this view. These have the fewest other types. Try panning to nearby areas.</p>`;
    state.spots.forEach((s, i) => {
      const d = E.distM(ref.lat, ref.lon, s.lat, s.lon);
      const others = s.otherCats.map((id) => ic(id)).join(' ');
      out += `<div class="card ${s.level === 0 ? 'pure' : ''}">
        <div class="spot-h"><span class="num l${Math.min(3, s.level)}">${i + 1}</span>
          <span>${s.level === 0 ? `Only ${ic(c.id)} ${html(c.name)}` : `${ic(c.id)} + ${s.level} other${s.level > 1 ? 's' : ''}: <span class="icons">${others}</span>`}</span></div>
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
    bindNearest(el);
  }

  // ---- find nearest ----
  let nearestToken = 0;
  function nearestHtml() {
    const n = state.nearest, c = E.CAT[state.target];
    let out = `<div class="row" style="margin:2px 0 8px"><button class="btn primary sm" id="findNearest" ${n && n.busy ? 'disabled' : ''}>📍 Find nearest</button>
      <span class="muted small">${state.me ? 'from your location' : 'from the map centre (tap ◎ to use GPS)'}</span></div>`;
    if (!n) return out;
    if (n.busy) return out + `<div class="card"><span class="muted small">⏳ ${html(n.msg)}</span></div>`;
    if (n.error) return out + `<div class="card"><span class="small">⚠️ ${html(n.error)}</span></div>`;
    const sp = n.spot;
    if (!sp) return out + `<div class="card"><span class="small">No spot with ${ic(c.id)} ${html(c.name)} found within ${fmtDist(n.radius)}.</span></div>`;
    const others = sp.level === 0 ? '' : ` (+${sp.level} other type${sp.level > 1 ? 's' : ''})`;
    return out + `<div class="card ${sp.level === 0 ? 'pure' : ''}"><div class="spot-h"><span class="num l${Math.min(3, sp.level)}">📍</span>
      <span>${sp.level === 0 ? `Nearest spot with only ${ic(c.id)}` : `No pure spot within ${fmtDist(n.radius)}. Nearest with fewest others${others}`}</span></div>
      <div class="muted small" style="margin:4px 0 8px">${fmtDist(sp.distance)} away · safe zone ±${Math.round(sp.safe)} m</div>
      <div class="row"><button class="btn sm" id="nearShow">Show</button><a class="btn sm" href="${dirLink(sp.lat, sp.lon)}" target="_blank" rel="noopener">Walk there ↗</a></div></div>`;
  }
  function bindNearest(el) {
    const b = el.querySelector('#findNearest'); if (b) b.onclick = findNearest;
    const s2 = el.querySelector('#nearShow'); if (s2) s2.onclick = () => showNearest();
  }
  function showNearest() {
    const sp = state.nearest && state.nearest.spot; if (!sp) return;
    if (innerWidth < 900) setSheet(0.3);
    frame(sp.lat, sp.lon, Math.max(map.zoom, 16.5));
    setProbe(sp.lat, sp.lon, false);
  }
  async function findNearest() {
    const t = state.target; if (!t) return;
    const token = ++nearestToken;
    const origin = refPoint();
    const grid = E.getGrid(state.opts.grid);
    const isCuisine = E.CAT[t].cuisine.length > 0;
    const set = (o) => { if (token === nearestToken) { state.nearest = o; renderSpots(); } };
    let fallback = null, R = 0;
    try {
      for (R of [500, 1000, 2000, 3000]) {
        set({ busy: true, msg: `Searching within ${fmtDist(R)}…` });
        const area = E.expandBBox({ s: origin.lat, n: origin.lat, w: origin.lon, e: origin.lon }, R);
        const keys = E.tilesForBBox(E.expandBBox(area, state.opts.radius + grid.edge + 40));
        const errs = await ensureTiles(keys, (d, n) => set({ busy: true, msg: `Searching within ${fmtDist(R)}… map data ${d}/${n}` }));
        if (token !== nearestToken) return;
        if (errs.length) throw new Error(`Couldn't load part of the map (${errs[0].message || errs[0]})`);
        if (isCuisine && state.settings.cuisine !== 'never') {
          queueCuisine(keys);
          while (keys.some((k) => !state.store.hasCuisine(k)) && !cuisineQ.stopped) {
            const left = keys.filter((k) => !state.store.hasCuisine(k)).length;
            set({ busy: true, msg: `Searching within ${fmtDist(R)}… cuisine data ${keys.length - left}/${keys.length} (the cuisine server is slow)` });
            await new Promise((r) => setTimeout(r, 1000));
            if (token !== nearestToken) return;
          }
          if (cuisineQ.stopped) throw new Error('The cuisine server is too busy right now. Try again in a few minutes.');
        }
        await new Promise((r) => setTimeout(r, 20));
        const idx = E.buildCellIndex(state.store, E.expandBBox(area, state.opts.radius), state.opts);
        await new Promise((r) => setTimeout(r, 0));
        const ig = E.isolationGrid(idx, area, t, 150000);
        const pure = E.nearestSpot(ig, origin.lat, origin.lon, 0, 8);
        if (pure && (pure.distance <= R || R === 3000)) { set({ spot: pure, radius: R }); showNearest(); return; }
        if (!fallback) {
          for (const lv of [1, 2, 3]) {
            const f = E.nearestSpot(ig, origin.lat, origin.lon, lv, 8);
            if (f && f.distance <= R) { fallback = f; break; }
          }
        }
      }
      set({ spot: fallback, radius: R });
      if (fallback) showNearest();
    } catch (e) {
      set({ error: e.message || String(e) });
    }
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
      `<button class="chip ${x.pureM2 > 0 ? 'target' : ''}" data-t="${x.id}" title="${x.n} cells">${ic(x.id)} ${html(E.CAT[x.id].name)}${x.pureM2 > 0 ? ' ★' : ''}</button>`).join('') +
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
      out += only ? `<p><span class="badge ok">Only ${ic(t)} ${html(E.CAT[t].name)} — guaranteed!</span></p>`
        : d.shown.includes(t) ? `<p><span class="badge no">${ic(t)} plus ${d.shown.length - 1} other type${d.shown.length > 2 ? 's' : ''}</span></p>`
          : `<p><span class="badge no">${ic(t)} ${html(E.CAT[t].name)} not in range</span></p>`;
    }
    out += '<div class="detlist">';
    if (d.roadside) out += `<div class="dt"><span>${ic('roadside')}</span><span>Roadside</span></div>`;
    d.shown.forEach((id) => { out += `<div class="dt ${id === t ? 't' : ''}"><span>${ic(id)}</span><span>${html(E.CAT[id].name)}</span></div>`; });
    d.hidden.forEach((id) => { out += `<div class="dt hid" title="Beyond the ${state.opts.maxShown}-icon limit"><span>${ic(id)}</span><span>${html(E.CAT[id].name)}</span></div>`; });
    out += '</div>';
    if (d.hidden.length) out += `<p class="muted small">Faded icons are further away than the ${state.opts.maxShown} nearest types, so they probably won't show.</p>`;
    if (d.inRange.length) {
      out += `<details><summary>Why? ${d.inRange.length} cell${d.inRange.length === 1 ? '' : 's'} in range</summary><table><tr><th>Dist.</th><th>Decor · source</th></tr>`;
      for (const { cell, d: dist } of d.inRange) {
        const seen = new Set();
        const src = cell.src.filter((s) => { const k = s.cat + s.name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6)
          .map((s) => `${ic(s.cat)} ${html(s.name || E.CAT[s.cat].name)} <a class="small" href="https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[s.id[0]]}/${s.id.slice(1)}" target="_blank" rel="noopener">osm</a>`).join('<br>');
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
      <div class="chips" id="calChips">${all.map((id) => `<button class="chip ${c.sel.has(id) ? 'on' : ''}" data-id="${id}">${catLabel(id)}</button>`).join('')}</div>
      <input id="calNote" placeholder="Note (optional), e.g. 'icons appeared after 3 s'" value="${html(c.note)}" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-top:8px">
      <div class="row" style="margin-top:8px"><button class="btn primary" id="calSave" ${c.lat == null || !c.sel.size ? 'disabled' : ''}>Save reading</button>
      <span class="muted small">${c.sel.size} selected</span></div>`;
    out += `<h3 style="margin-top:16px">Readings (${state.readings.length})</h3>`;
    if (state.readings.length) {
      out += '<table>' + state.readings.slice().reverse().map((r) => `<tr><td class="small">${new Date(r.t).toLocaleDateString()}<br>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</td><td class="icons">${r.observed.map((id) => (id === 'roadside' || E.CAT[id] ? ic(id) : '?')).join(' ')}</td><td><button class="btn sm" data-show="${r.id}">Show</button> <button class="btn sm" data-del="${r.id}">✕</button></td></tr>`).join('') + '</table>';
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
    return JSON.stringify({ app: 'pikmin-decor-finder', version: APP_VERSION, exported: new Date().toISOString(), model: state.opts, mapData: 'OpenFreeMap ' + (vt.version || '?'), readings: state.readings }, null, 1);
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
      <p class="small">Places, parks and water come from <b>OpenFreeMap</b> (OpenStreetMap data${vt.version ? `, extract of <b>${html(vt.version)}</b>` : ''}, refreshed weekly). The game refreshed its own map in October 2026, so places added to OSM since then can show here but not in the game.</p>
      <div class="kv">
        <label for="sCuisine">Cuisine lookups</label><select id="sCuisine">${opt('auto', 'Only when a cuisine decor is chosen', s.cuisine)}${opt('always', 'Always (more accurate overlaps, slower)', s.cuisine)}${opt('never', 'Never', s.cuisine)}</select>
      </div>
      <p class="muted small">OpenFreeMap doesn't say which cuisine a restaurant serves. Sushi, Italian, Ramen, Curry, Mexican and Korean come from a small extra lookup on the public Overpass server, which is often busy. The app sends one request at a time and waits at least 30 s after a busy answer.</p>
      <div class="row"><button class="btn sm" id="sClear">Reload map data</button></div>
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
    on('#sCuisine', (e) => { s.cuisine = e.target.value; retryCuisine(); });
    on('#sBase', (e) => { s.basemap = e.target.value; applyBasemap(); placeAttr(); persist(); });
    $('#sOp').oninput = (e) => { s.heatOpacity = +e.target.value; map.redraw(); persist(); };
    $('#sClear').onclick = () => { state.store.clear(); vt.data.clear(); vt.order = []; applyBasemap(); toast('Reloading map data'); remodel(); };
  }

  function renderHelp() {
    $('#p-help').innerHTML = `<h3>How it works</h3>
      <p class="small">The game decides a seedling's decor from the map <b>cell</b> it was found in. The detector looks at every cell whose <b>centre</b> is within <b>100 m</b> of you and shows the decor types in those cells. One seedling is always one of the shown types. So if only one type is in range, that seedling is guaranteed to be that type.</p>
      <p class="small">This tool loads OpenStreetMap data for the area from OpenFreeMap's ready-made map files (fast, no limits). It works out each cell's decor types, then tests every point on the map to see which types the detector would list there. <b>📍 Find nearest</b> searches outward from you (up to 3 km) for the closest spot where only your chosen type shows.</p>
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
        <li>Cuisine decor (Sushi, Italian, Ramen, Curry, Mexican, Korean) needs an extra lookup on the busy public Overpass server, so it can be slow or unavailable.</li>
        <li>Waterside covers lakes, ponds and rivers. The sea isn't counted, which may not match the game.</li>
        <li>The cell grid and the polygon rules aren't published. Use <b>Calibrate</b> to log real detector readings and test which model matches.</li>
        <li>Weather and event decor don't depend on location and aren't covered.</li>
      </ul>
      <p class="muted small">Data © OpenStreetMap contributors (ODbL), served by OpenFreeMap (OpenMapTiles schema); cuisine lookups via the Overpass API. Tag mapping from Pikipedia's Decor Pikmin page. Unofficial fan tool; not affiliated with Niantic or Nintendo.</p>`;
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
      items.map((c) => `<button class="pi ${c.id === state.target ? 'on' : ''}" data-id="${c.id}"><span class="ico">${ic(c.id)}</span><span>${html(c.name)}<br><span class="muted small">${html([...c.tags.map((t) => t.join('=')), ...(c.cuisine.length ? ['cuisine=' + c.cuisine.join('/') + ' (extra lookup, can be slow)'] : [])].join(', '))}</span></span>
        <span class="cnt">${counts.get(c.id) ? `<b>${counts.get(c.id)}</b> in view` : ''}</span></button>`).join('');
    $('#pickList').querySelectorAll('.pi').forEach((b) => b.onclick = () => { $('#picker').classList.remove('on'); setTarget(b.dataset.id || null); });
  }
  function setTarget(id) {
    state.target = id;
    state.nearest = null; nearestToken++;
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
          statusState.main = only ? `✅ Here: only ${ic(state.target)} ${html(E.CAT[state.target].name)}` : `Here: ${d.roadside ? ic('roadside') : d.shown.map((id) => ic(id)).join(' ')}`;
          renderStatus();
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
