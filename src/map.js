/* Tiny dependency-free slippy map (canvas). Pan, wheel/pinch/double-tap zoom,
 * raster tiles with parent-tile fallback, and overlay draw callbacks. */
(function (root) {
  'use strict';
  const TS = 256;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class SlippyMap {
    constructor(el, o) {
      this.el = el;
      this.lat = o.lat; this.lon = o.lon; this.zoom = o.zoom;
      this.minZoom = o.minZoom || 3; this.maxZoom = o.maxZoom || 20; this.maxNative = o.maxNative || 19;
      this.source = null;
      this.layers = []; this.handlers = {};
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block';
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.pointers = new Map();
      this._bind();
      this.resize();
      if (root.ResizeObserver) new ResizeObserver(() => this.resize()).observe(el);
      else root.addEventListener('resize', () => this.resize());
    }
    on(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }
    emit(t, e) { (this.handlers[t] || []).forEach((fn) => fn(e)); }

    // ---- projection -------------------------------------------------------
    worldSize(z) { return TS * Math.pow(2, z == null ? this.zoom : z); }
    project(lat, lon, z) {
      const s = this.worldSize(z), sin = Math.sin(clamp(lat, -85.0511, 85.0511) * Math.PI / 180);
      return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
    }
    unproject(x, y, z) {
      const s = this.worldSize(z);
      const lon = (x / s) * 360 - 180;
      const n = Math.PI - (2 * Math.PI * y) / s;
      return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon];
    }
    toScreen(lat, lon) {
      const [cx, cy] = this.project(this.lat, this.lon), [x, y] = this.project(lat, lon);
      return [x - cx + this.w / 2, y - cy + this.h / 2];
    }
    toLatLng(sx, sy) {
      const [cx, cy] = this.project(this.lat, this.lon);
      return this.unproject(cx + sx - this.w / 2, cy + sy - this.h / 2);
    }
    metersPerPixel(lat) { return (156543.03392 * Math.cos((lat == null ? this.lat : lat) * Math.PI / 180)) / Math.pow(2, this.zoom); }
    getBounds() {
      const [n, w] = this.toLatLng(0, 0), [s, e] = this.toLatLng(this.w, this.h);
      return { s, w, n, e };
    }
    setView(lat, lon, zoom, silent) {
      this.lat = clamp(lat, -85, 85); this.lon = ((lon + 540) % 360) - 180;
      if (zoom != null) this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
      this.redraw(); if (!silent) this._moveEnd();
    }
    zoomAround(sx, sy, newZoom) {
      newZoom = clamp(newZoom, this.minZoom, this.maxZoom);
      const [lat, lon] = this.toLatLng(sx, sy);
      this.zoom = newZoom;
      const [px, py] = this.project(lat, lon);
      const [clat, clon] = this.unproject(px - (sx - this.w / 2), py - (sy - this.h / 2));
      this.lat = clamp(clat, -85, 85); this.lon = clon;
      this.redraw();
    }
    animateTo(lat, lon, zoom) {
      const a = { lat: this.lat, lon: this.lon, z: this.zoom }, b = { lat, lon, z: zoom == null ? this.zoom : zoom };
      const t0 = performance.now(), dur = 350;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.lat = a.lat + (b.lat - a.lat) * e; this.lon = a.lon + (b.lon - a.lon) * e; this.zoom = a.z + (b.z - a.z) * e;
        this.redraw();
        if (k < 1) requestAnimationFrame(step); else this._moveEnd();
      };
      requestAnimationFrame(step);
    }

    // ---- events ----------------------------------------------------------
    _moveEnd() { clearTimeout(this._meT); this._meT = setTimeout(() => this.emit('moveend', this), 120); }
    _bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (this.pointers.size === 1) {
          this.drag = { x: e.offsetX, y: e.offsetY, c: this.project(this.lat, this.lon), moved: 0, t: performance.now() };
        } else if (this.pointers.size === 2) {
          const [p, q] = [...this.pointers.values()];
          this.pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), z: this.zoom };
          if (this.drag) this.drag.moved = 99;
        }
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (this.pointers.size === 2 && this.pinch) {
          const [p, q] = [...this.pointers.values()];
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          this.zoomAround((p.x + q.x) / 2, (p.y + q.y) / 2, this.pinch.z + Math.log2(d / this.pinch.d));
          this.pinch = { d, z: this.zoom };
        } else if (this.drag && this.pointers.size === 1) {
          const dx = e.offsetX - this.drag.x, dy = e.offsetY - this.drag.y;
          this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
          if (this.drag.moved > 4) {
            const [lat, lon] = this.unproject(this.drag.c[0] - dx, this.drag.c[1] - dy);
            this.lat = clamp(lat, -85, 85); this.lon = lon; this.redraw();
          }
        }
      });
      const up = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        if (this.pointers.size === 0 && this.drag) {
          const d = this.drag; this.drag = null;
          if (d.moved <= 4 && performance.now() - d.t < 600) {
            const now = performance.now();
            if (this._lastTap && now - this._lastTap.t < 300 && Math.hypot(this._lastTap.x - e.offsetX, this._lastTap.y - e.offsetY) < 25) {
              clearTimeout(this._tapT); this._lastTap = null;
              this.zoomAround(e.offsetX, e.offsetY, Math.round(this.zoom) + 1); this._moveEnd();
            } else {
              this._lastTap = { t: now, x: e.offsetX, y: e.offsetY };
              const [lat, lon] = this.toLatLng(e.offsetX, e.offsetY);
              this._tapT = setTimeout(() => this.emit('click', { lat, lon }), 260);
            }
          } else this._moveEnd();
        } else if (this.pointers.size === 0) this._moveEnd();
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022);
        this.zoomAround(e.offsetX, e.offsetY, this.zoom + clamp(dz, -1, 1));
        this._moveEnd();
      }, { passive: false });
    }
    resize() {
      const r = this.el.getBoundingClientRect();
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.dpr = Math.min(3, root.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
      this.redraw();
    }

    // ---- tiles + render ---------------------------------------------------
    setSource(src) { this.source = src; this.maxNative = src.maxNative; this.redraw(); }
    _tile(z, x, y, load) {
      const n = Math.pow(2, z);
      if (!this.source || y < 0 || y >= n) return null;
      return this.source.get(z, ((x % n) + n) % n, y, load, this.dpr);
    }
    redraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
    }
    render() {
      const ctx = this.ctx, dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#f2efe9'; ctx.fillRect(0, 0, this.w, this.h);
      const tz = clamp(Math.round(this.zoom), 0, this.maxNative);
      const scale = Math.pow(2, this.zoom - tz), size = TS * scale;
      const [cx, cy] = this.project(this.lat, this.lon, tz);
      const ox = this.w / 2 - cx * scale, oy = this.h / 2 - cy * scale;
      const x0 = Math.floor(-ox / size), x1 = Math.floor((this.w - ox) / size);
      const y0 = Math.max(0, Math.floor(-oy / size)), y1 = Math.min(Math.pow(2, tz) - 1, Math.floor((this.h - oy) / size));
      ctx.imageSmoothingEnabled = true;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = Math.round(ox + x * size), py = Math.round(oy + y * size), ps = Math.ceil(size) + 1;
        const t = this._tile(tz, x, y, true);
        if (t && t.ok) { ctx.drawImage(t.img, px, py, ps, ps); continue; }
        for (let up = 1; up <= 4 && tz - up >= 0; up++) { // parent fallback
          const f = Math.pow(2, up), pt = this._tile(tz - up, Math.floor(x / f), Math.floor(y / f), false);
          if (pt && pt.ok) {
            const iw = pt.img.width / f, sx = (((x % f) + f) % f) * iw, sy = (y % f) * iw;
            ctx.drawImage(pt.img, sx, sy, iw, iw, px, py, ps, ps); break;
          }
        }
      }
      for (const l of this.layers) { ctx.save(); try { l(ctx, this); } catch (e) { console.error(e); } ctx.restore(); }
    }
  }
  root.SlippyMap = SlippyMap;
})(typeof self !== 'undefined' ? self : this);
