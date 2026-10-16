// Screen Time Machine + region snip.
// Pure parts (ring buffer, frame geometry) are unit-tested in timemachine.test.js; the capture
// helpers at the bottom need a browser (canvas + <video>/<img>) and are exercised end to end.

export const RING = { capacity: 60, intervalMs: 2000 }; // 2 minutes of history at one frame / 2 s
export const MAX_IMAGE_CHARS = 190_000; // data-URL budget per beamed frame or snip (server allows 200 000)

// Fixed-capacity history of frames, oldest first. push() returns the frame it evicted, if any.
export function createRing(capacity = RING.capacity) {
  const items = [];
  return {
    get size() { return items.length; },
    push(frame) { items.push(frame); return items.length > capacity ? items.shift() : null; },
    at(i) { return items[i] ?? null; },
    indexOf(frame) { return items.indexOf(frame); },
    latest() { return items.at(-1) ?? null; },
    due(now, intervalMs = RING.intervalMs) { const last = items.at(-1); return !last || now - last.t >= intervalMs; },
    clear() { return items.splice(0); },
  };
}

export function agoLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `-${s}s` : `-${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const unit = (v) => Math.min(1, Math.max(0, v));
// Rectangle spanned by two normalised points (any drag direction), clamped to the content area.
export function normRect(x0, y0, x1, y1) {
  const x = unit(Math.min(x0, x1)), y = unit(Math.min(y0, y1));
  return { x, y, w: unit(Math.max(x0, x1)) - x, h: unit(Math.max(y0, y1)) - y };
}
// Normalised rect → integer source pixels of a frame, at least 1×1 and never outside it.
export function sourceRect(r, sw, sh) {
  const sx = Math.min(sw - 1, Math.floor(r.x * sw)), sy = Math.min(sh - 1, Math.floor(r.y * sh));
  return { sx, sy, w: Math.max(1, Math.min(sw - sx, Math.round(r.w * sw))), h: Math.max(1, Math.min(sh - sy, Math.round(r.h * sh))) };
}
export function fitWithin(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
// Where the n-th snip lands on the 16:9 whiteboard: a 3×3 grid of cells (cascading after nine),
// sized to keep the snip's own aspect ratio (aspect = width / height in pixels).
export function cardSlot(n, aspect) {
  const cell = 0.3, col = n % 3, row = Math.floor(n / 3) % 3, layer = Math.floor(n / 9);
  let w = cell, h = (w / aspect) * (16 / 9);
  if (h > cell) { h = cell; w = (h * aspect * 9) / 16; }
  const x = 0.025 + col * 0.325 + (cell - w) / 2 + layer * 0.012;
  const y = 0.05 + row * 0.31 + (cell - h) / 2 + layer * 0.012;
  return { x: unit(x), y: unit(y), w, h };
}

// ---------- Browser helpers ----------
const mediaSize = (src) => ({ w: src.videoWidth || src.naturalWidth || 0, h: src.videoHeight || src.naturalHeight || 0 });

// One downscaled JPEG snapshot of a <video>/<img>, for the local rewind buffer.
export async function captureFrame(src, maxSide = 960, quality = 0.72) {
  const { w, h } = mediaSize(src);
  if (!w || !h) return null;
  const size = fitWithin(w, h, maxSide);
  const canvas = Object.assign(src.ownerDocument.createElement('canvas'), { width: size.w, height: size.h });
  canvas.getContext('2d').drawImage(src, 0, 0, size.w, size.h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob && { blob, w: size.w, h: size.h };
}

// Crop a normalised region of a <video>/<img> at source resolution into a JPEG data URL that fits
// the relay budget (shrinking quality, then size, until it does).
export function cropToDataUrl(src, rect = { x: 0, y: 0, w: 1, h: 1 }, maxSide = 960) {
  const { w, h } = mediaSize(src);
  if (!w || !h) return null;
  const s = sourceRect(rect, w, h);
  for (let side = maxSide; side >= 240; side = Math.round(side * 0.75)) {
    const out = fitWithin(s.w, s.h, side);
    const canvas = Object.assign(src.ownerDocument.createElement('canvas'), { width: out.w, height: out.h });
    canvas.getContext('2d').drawImage(src, s.sx, s.sy, s.w, s.h, 0, 0, out.w, out.h);
    for (const q of [0.82, 0.7, 0.58]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= MAX_IMAGE_CHARS) return { url, w: out.w, h: out.h };
    }
  }
  return null;
}
