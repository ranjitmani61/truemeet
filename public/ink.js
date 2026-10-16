// Shared ink engine for screen-share annotation and the whiteboard.
// Strokes and pins are stored in normalised [0..1] coordinates of a content rect, so every viewer
// renders them in the same place regardless of window size or letterboxing. Strokes are drawn on a
// canvas; pins are real DOM buttons (numbers and notes as text nodes) so they stay clickable and
// accessible, and travel with their tile into a pop-out presenter window.
const FADE_MS = 1200; // laser trails fade after the pointer stops
const LASER_TAIL = 48; // laser keeps only its last 24 points: a short comet, not a drawing
const MAX_STROKES = 4000; // ponytail: hard cap per surface; add stroke merging if boards get huge
const MAX_PINS = 200;
const COLOR_RE = /^(#[0-9a-f]{6}|hsl\(\d{1,3} \d{1,3}% \d{1,3}%\))$/i;
const PID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_CARDS = 24;
const surfaces = new Set();
// Short random ids that work outside secure contexts too (randomUUID needs HTTPS).
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;

export function createSurface(canvas, rect, background, layer) {
  // rect(w, h) → {x, y, w, h} in CSS px, or null while the content has no size yet.
  // layer: element over the canvas that hosts pin buttons; onPin(pid, el) fires when one is clicked.
  const s = { canvas, rect, background, layer, strokes: new Map(), pins: new Map(), pinEls: new Map(), cards: new Map(), onPin: null, dirty: true, live: false };
  surfaces.add(s);
  return s;
}
export const dropSurface = (s) => surfaces.delete(s);
export const containRect = (media) => (w, h) => { // a <video>, or an <img> showing a rewound frame
  const vw = media.videoWidth || media.naturalWidth, vh = media.videoHeight || media.naturalHeight;
  if (!vw || !vh) return null;
  const k = Math.min(w / vw, h / vh);
  return { x: (w - vw * k) / 2, y: (h - vh * k) / 2, w: vw * k, h: vh * k };
};
export const fixedRect = (aw, ah) => (w, h) => {
  const k = Math.min(w / aw, h / ah);
  return { x: (w - aw * k) / 2, y: (h - ah * k) / 2, w: aw * k, h: ah * k };
};

// Apply an op from anyone (local or remote). Remote input is untrusted, so it is validated here.
export function apply(s, m, by) {
  if (m.op === 'pts') {
    const pts = Array.isArray(m.pts) ? m.pts.slice(0, 4000).filter(Number.isFinite).map(round) : [];
    if (pts.length < 2 || typeof m.sid !== 'string' || m.sid.length > 40) return;
    let st = s.strokes.get(m.sid);
    if (!st) {
      if (s.strokes.size >= MAX_STROKES || !['pen', 'laser'].includes(m.tool) || !COLOR_RE.test(m.color)) return;
      s.strokes.set(m.sid, (st = { by, tool: m.tool, color: m.color, pts: [] }));
    }
    if (st.by !== by) return; // nobody extends someone else's stroke
    st.pts.push(...pts.slice(0, pts.length & ~1));
    if (st.tool === 'laser' && st.pts.length > LASER_TAIL) st.pts.splice(0, st.pts.length - LASER_TAIL);
    st.at = performance.now();
  } else if (m.op === 'undo') {
    if (s.strokes.get(m.sid)?.by === by) s.strokes.delete(m.sid);
  } else if (m.op === 'clear') {
    for (const [k, st] of s.strokes) if (m.all || st.by === by) s.strokes.delete(k);
    if (m.all) { s.pins.clear(); s.cards.clear(); }
  } else if (m.op === 'card') { // snipped screen region on the whiteboard; drawn under the ink
    const box = [m.x, m.y, m.w, m.h];
    if (typeof m.cid !== 'string' || !PID_RE.test(m.cid) || s.cards.has(m.cid) || s.cards.size >= MAX_CARDS) return;
    if (typeof m.image !== 'string' || m.image.length > 200_000 || !IMAGE_RE.test(m.image) || !box.every(Number.isFinite)) return;
    const img = s.canvas.ownerDocument.createElement('img');
    img.onload = () => { s.dirty = true; };
    img.src = m.image;
    const [x, y, w, h] = box.map(round);
    s.cards.set(m.cid, { by, x, y, w, h, image: m.image, caption: String(m.caption ?? '').slice(0, 80), img });
  } else if (m.op === 'pin') {
    if (typeof m.pid !== 'string' || !PID_RE.test(m.pid) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const prev = s.pins.get(m.pid);
    if (!prev && s.pins.size >= MAX_PINS) return;
    s.pins.set(m.pid, {
      by: prev?.by ?? by,
      x: round(m.x), y: round(m.y),
      note: String(m.note ?? '').slice(0, 140),
      color: COLOR_RE.test(m.color) ? m.color : '#a78bfa',
      name: String(m.name ?? prev?.name ?? '').slice(0, 40),
      n: Number.isInteger(m.n) ? m.n : prev?.n ?? null, // null until the server's numbered echo arrives
      t: Number.isFinite(m.t) ? m.t : prev?.t ?? Date.now(),
      resolved: !!(m.resolved || prev?.resolved),
    });
  } else if (m.op === 'resolve') {
    const pin = s.pins.get(m.pid);
    if (pin) pin.resolved = true;
  } else if (m.op === 'sync' && Array.isArray(m.strokes)) {
    for (const st of m.strokes) if (st && !s.strokes.has(st.sid)) apply(s, { op: 'pts', ...st }, st.by);
  }
  s.dirty = true;
}

export const penStrokes = (s) => [...s.strokes].filter(([, st]) => st.tool === 'pen').map(([sid, st]) => ({ sid, by: st.by, tool: st.tool, color: st.color, pts: st.pts }));

function trace(ctx, p, r) {
  const X = (i) => r.x + p[i] * r.w, Y = (i) => r.y + p[i + 1] * r.h;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(0));
  if (p.length === 2) return ctx.lineTo(X(0) + 0.01, Y(0)); // a tap draws a dot
  for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 2)) / 2, (Y(i) + Y(i + 2)) / 2);
  ctx.lineTo(X(p.length - 2), Y(p.length - 2));
}

function render(ctx, s, r, now) {
  let live = false;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const [k, st] of s.strokes) {
    let alpha = 1;
    if (st.tool === 'laser') {
      const age = now - st.at;
      if (age > FADE_MS) { s.strokes.delete(k); continue; }
      alpha = 1 - age / FADE_MS;
      live = true;
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(2, r.w * (st.tool === 'laser' ? 0.005 : 0.003));
    ctx.shadowColor = st.color;
    ctx.shadowBlur = st.tool === 'laser' ? 14 : 0;
    trace(ctx, st.pts, r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  return live;
}

function placePins(s, r) {
  if (!s.layer) return;
  for (const [pid, el] of s.pinEls) {
    if (!r || !s.pins.get(pid) || s.pins.get(pid).resolved) { el.remove(); s.pinEls.delete(pid); }
  }
  if (!r) return;
  for (const [pid, pin] of s.pins) {
    if (pin.resolved) continue;
    let el = s.pinEls.get(pid);
    if (!el) {
      el = s.layer.ownerDocument.createElement('button');
      el.type = 'button';
      el.className = 'pin-dot';
      el.append(s.layer.ownerDocument.createElement('b'), s.layer.ownerDocument.createElement('span'));
      el.addEventListener('click', (e) => { e.stopPropagation(); s.onPin?.(pid, el); });
      s.layer.append(el);
      s.pinEls.set(pid, el);
    }
    el.firstChild.textContent = pin.n ?? '…';
    el.lastChild.textContent = pin.note || `Pin by ${pin.name}`;
    el.setAttribute('aria-label', `Pin ${pin.n ?? ''} by ${pin.name}${pin.note ? `: ${pin.note}` : ''}`);
    el.style.setProperty('--c', pin.color);
    el.style.left = `${r.x + pin.x * r.w}px`;
    el.style.top = `${r.y + pin.y * r.h}px`;
  }
}

function drawCards(ctx, s, r) {
  for (const c of s.cards.values()) {
    if (!c.img.complete || !c.img.naturalWidth) continue;
    const x = r.x + c.x * r.w, y = r.y + c.y * r.h, w = c.w * r.w, h = c.h * r.h;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, .55)';
    ctx.shadowBlur = 18;
    ctx.drawImage(c.img, x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255, 255, 255, .28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (!c.caption) continue;
    ctx.fillStyle = 'rgba(205, 196, 255, .9)';
    ctx.font = `500 ${Math.max(10, Math.round(r.w * 0.009))}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(c.caption, x, y + h + 4, w);
  }
}

// Paint a beamed overlay ({strokes, pins} in normalised coordinates) over a frame on any canvas.
// Everything goes through apply(), so a received overlay gets the same validation as live ink.
export function paintOverlay(ctx, { strokes = [], pins = [] } = {}, r) {
  const tmp = { strokes: new Map(), pins: new Map(), cards: new Map(), canvas: ctx.canvas };
  strokes.forEach((st, i) => apply(tmp, { op: 'pts', sid: `b${i}`, tool: st.tool, color: st.color, pts: st.pts }, 'beam'));
  pins.forEach((pin, i) => apply(tmp, { op: 'pin', pid: `p${i}`, ...pin }, 'beam'));
  for (const st of tmp.strokes.values()) st.at = performance.now(); // laser trails show at full strength in a still
  render(ctx, tmp, r, performance.now());
  drawPins(ctx, tmp, r);
}
export const boardCards = (s) => [...s.cards].map(([cid, c]) => ({ cid, x: c.x, y: c.y, w: c.w, h: c.h, image: c.image, caption: c.caption }));

function drawPins(ctx, s, r) { // for PNG export, where DOM pins don't exist
  ctx.textBaseline = 'middle';
  for (const pin of s.pins.values()) {
    if (pin.resolved) continue;
    const x = r.x + pin.x * r.w, y = r.y + pin.y * r.h;
    ctx.fillStyle = pin.color;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0d16';
    ctx.font = '700 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(pin.n ?? '•'), x, y + 1);
    if (!pin.note) continue;
    ctx.font = '500 18px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f2f4fa';
    ctx.fillText(pin.note.slice(0, 80), x + 28, y);
  }
}

const rectKey = (r) => (r ? `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}` : '');

function draw(s, now) {
  const c = s.canvas, dpr = c.ownerDocument.defaultView.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const r = w && h ? s.rect(w, h) : null;
  s.rk = rectKey(r);
  placePins(s, r);
  if (!r) return false;
  s.background?.(ctx, r);
  drawCards(ctx, s, r);
  return render(ctx, s, r, now);
}

export function exportPng(s, background, w = 1920, h = 1080) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d'), r = { x: 0, y: 0, w, h };
  background?.(ctx, r);
  drawCards(ctx, s, r);
  render(ctx, s, r, performance.now());
  drawPins(ctx, s, r);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Pointer input → local apply + batched network ops (~25/s) so drawing feels instant but stays cheap.
export function bindPointer(s, { tool, color, me, emit, onStroke, onPinDrop, onSnip }) {
  let cur = null, pending = [], timer = 0, snip = null;
  const flush = () => {
    timer = 0;
    if (cur && pending.length) emit({ op: 'pts', sid: cur.sid, tool: cur.tool, color: cur.color, pts: pending });
    pending = [];
  };
  const at = (e) => {
    const b = s.canvas.getBoundingClientRect(), r = s.rect(b.width, b.height);
    return r && [round((e.clientX - b.left - r.x) / r.w), round((e.clientY - b.top - r.y) / r.h)];
  };
  const add = (e) => {
    const b = s.canvas.getBoundingClientRect(), r = s.rect(b.width, b.height);
    if (!r) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const x = round((ev.clientX - b.left - r.x) / r.w), y = round((ev.clientY - b.top - r.y) / r.h);
      if (cur.last && Math.hypot(x - cur.last[0], y - cur.last[1]) < 0.0015) continue;
      cur.last = [x, y];
      pending.push(x, y);
      apply(s, { op: 'pts', sid: cur.sid, tool: cur.tool, color: cur.color, pts: [x, y] }, me());
    }
    timer ||= setTimeout(flush, 40);
  };
  const end = () => {
    if (!cur) return;
    clearTimeout(timer);
    flush();
    onStroke?.(cur);
    cur = null;
  };
  s.canvas.addEventListener('pointerdown', (e) => {
    const t = tool();
    if (!t || e.button > 0) return;
    e.preventDefault();
    if (t === 'pin') { const p = at(e); if (p) onPinDrop?.(p[0], p[1]); return; }
    if (t === 'snip') { // drag a rectangle over the content; released, it becomes a whiteboard card
      const p = at(e);
      if (!p || !s.layer) return;
      s.canvas.setPointerCapture(e.pointerId);
      const box = s.layer.ownerDocument.createElement('div');
      box.className = 'snip-rect';
      s.layer.append(box);
      snip = { from: p, to: p, box };
      return;
    }
    s.canvas.setPointerCapture(e.pointerId);
    cur = { sid: newId(), tool: t, color: color() };
    add(e);
  });
  const drawSnip = () => {
    const b = s.canvas.getBoundingClientRect(), r = s.rect(b.width, b.height);
    if (!r) return;
    const [x0, y0] = snip.from, [x1, y1] = snip.to;
    Object.assign(snip.box.style, {
      left: `${r.x + Math.min(x0, x1) * r.w}px`, top: `${r.y + Math.min(y0, y1) * r.h}px`,
      width: `${Math.abs(x1 - x0) * r.w}px`, height: `${Math.abs(y1 - y0) * r.h}px`,
    });
  };
  s.canvas.addEventListener('pointermove', (e) => {
    if (snip) { snip.to = at(e) ?? snip.to; drawSnip(); } else if (cur) add(e);
  });
  const endSnip = (cancel) => {
    if (!snip) return false;
    const { from: [x0, y0], to: [x1, y1], box } = snip;
    box.remove();
    snip = null;
    if (!cancel && Math.abs(x1 - x0) >= 0.02 && Math.abs(y1 - y0) >= 0.02) onSnip?.({ x0, y0, x1, y1 });
    return true;
  };
  s.canvas.addEventListener('pointerup', () => endSnip(false));
  s.canvas.addEventListener('pointercancel', () => endSnip(true));
  s.canvas.addEventListener('pointerup', end);
  s.canvas.addEventListener('pointercancel', end);
}

// One render loop for every surface; redraws only what changed (or is fading).
(function loop() {
  const now = performance.now();
  for (const s of surfaces) {
    if (!s.canvas.isConnected) continue;
    const c = s.canvas, dpr = c.ownerDocument.defaultView.devicePixelRatio || 1;
    if (c.width !== Math.round(c.clientWidth * dpr) || c.height !== Math.round(c.clientHeight * dpr)) s.dirty = true;
    // Content can move without the canvas resizing (video metadata arrives, a shared window is resized).
    else if (!s.dirty && (s.strokes.size || s.pins.size) && rectKey(s.rect(c.clientWidth, c.clientHeight)) !== s.rk) s.dirty = true;
    if (s.dirty || s.live) { s.live = draw(s, now); s.dirty = false; }
  }
  // Hidden tabs pause rAF; keep drawing (e.g. into a pop-out presenter window) on a timer instead.
  if (document.hidden) setTimeout(loop, 33); else requestAnimationFrame(loop);
})();
