// Living Anchors + the pixel physics behind "Proposed move".
// Pure parts (block matching, docking, Coons-patch fill, tether geometry) are unit-tested in
// tracker.test.js; readLuma() at the bottom needs a browser canvas.
//
// A pin on a shared screen carries a 16×16 grayscale template of what it points at, captured by
// its author at the moment of the click. Every participant then tracks that template on the
// frames they actually see (zero-mean normalised cross-correlation: immune to the brightness and
// contrast shifts a video codec introduces), so the pin is pixel-locked to their own video, with
// no extra network traffic. If the feature disappears the pin docks at the nearest edge as
// "off-screen"; a coarse-to-fine scan of the whole frame re-locks it when it comes back.

export const TRACK = {
  width: 320, // analysis frame width; the height follows the video's aspect ratio
  patch: 16, // template side in analysis pixels (64 px of a 1280-wide screen)
  radius: 12, // local search ± px per tick: follows ~580 px/s of a 1280-wide screen at 12 Hz
  lock: 0.8, // ZNCC needed to acquire (or re-acquire) the feature
  lose: 0.6, // once locked, below this the feature counts as occluded (hysteresis)
  margin: 0.08, // a whole-frame re-lock must beat the next-best distinct spot by this much
  minStd: 8, // templates flatter than this (luma std-dev) can't be tracked: the pin stays put
  hz: 12,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// RGBA → 8-bit luma (BT.601 weights in fixed point).
export function luminance(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

// Integer top-left of the template for a pin at normalised (x, y): centred, clamped into the frame.
// Everyone derives it from the pin's own coordinates, so the template's offset never has to travel.
const origin = (x, y, W, H, P) => [clamp(Math.round(x * W - P / 2), 0, W - P), clamp(Math.round(y * H - P / 2), 0, H - P)];

// The template a new pin carries: P×P luma bytes around (x, y), or null if there is nothing to track.
export function capture(frame, x, y, P = TRACK.patch) {
  const { data, width: W, height: H } = frame;
  if (W < P || H < P) return null;
  const [l, t] = origin(x, y, W, H, P), tpl = new Uint8Array(P * P);
  for (let j = 0; j < P; j++) tpl.set(data.subarray((t + j) * W + l, (t + j) * W + l + P), j * P);
  return zeroMean(tpl).std < TRACK.minStd ? null : tpl;
}

function zeroMean(tpl) {
  let sum = 0;
  for (const v of tpl) sum += v;
  const mean = sum / tpl.length, z = new Float32Array(tpl.length);
  let ss = 0;
  for (let i = 0; i < tpl.length; i++) { z[i] = tpl[i] - mean; ss += z[i] * z[i]; }
  return { z, norm: Math.sqrt(ss), std: Math.sqrt(ss / tpl.length) };
}

// 2×2 box downsample, for the coarse whole-frame scan.
function halve(data, W, H) {
  const w = W >> 1, h = H >> 1, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * W + 2 * x;
      out[y * w + x] = (data[i] + data[i + 1] + data[i + W] + data[i + W + 1] + 2) >> 2;
    }
  }
  return { data: out, width: w, height: h };
}

// Zero-mean normalised cross-correlation of the template against the window at (left, top).
// Σ z = 0, so Σ I·z already equals Σ (I − mean)·z.
function zncc(d, W, z, norm, P, left, top) {
  let s = 0, s2 = 0, sz = 0;
  for (let j = 0, k = 0; j < P; j++) {
    for (let i = (top + j) * W + left, end = i + P; i < end; i++, k++) { const v = d[i]; s += v; s2 += v * v; sz += v * z[k]; }
  }
  const varI = s2 - (s * s) / (P * P);
  return varI < 1e-6 || norm < 1e-6 ? 0 : sz / (Math.sqrt(varI) * norm);
}

// Vertex of the parabola through three scores around a peak: sub-pixel precision, at most ±0.5.
const vertex = (a, b, c) => { const d = a - 2 * b + c; return d < 0 ? clamp((0.5 * (a - c)) / d, -0.5, 0.5) : 0; };

// Best match within a (2r+1)² window of integer top-lefts around (cl, ct).
function search(d, W, H, m, cl, ct, r) {
  const x0 = clamp(cl - r, 0, W - m.P), x1 = clamp(cl + r, 0, W - m.P), y0 = clamp(ct - r, 0, H - m.P), y1 = clamp(ct + r, 0, H - m.P);
  const gw = x1 - x0 + 1, scores = new Float32Array(gw * (y1 - y0 + 1));
  let best = -2, bx = x0, by = y0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const s = (scores[(y - y0) * gw + x - x0] = zncc(d, W, m.z, m.norm, m.P, x, y));
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  const at = (x, y) => scores[(y - y0) * gw + x - x0];
  const sx = bx > x0 && bx < x1 ? vertex(at(bx - 1, by), best, at(bx + 1, by)) : 0;
  const sy = by > y0 && by < y1 ? vertex(at(bx, by - 1), best, at(bx, by + 1)) : 0;
  return { score: best, left: bx + sx, top: by + sy };
}

// The template at half resolution, once per sampling phase: the frame is halved on even pixel
// pairs, but the feature may sit at an odd offset, and sharp screen detail (text, icon edges)
// decorrelates under a half-pixel shift. Phase (px, py) matches a full-res top-left of 2X − px.
function coarse(a) {
  const P = a.P, n = (P >> 1) - 1;
  return [0, 1].flatMap((py) => [0, 1].map((px) => {
    const crop = new Uint8Array(4 * n * n);
    for (let j = 0; j < 2 * n; j++) crop.set(a.tpl.subarray((py + j) * P + px, (py + j) * P + px + 2 * n), j * 2 * n);
    return { ...zeroMean(halve(crop, 2 * n, 2 * n).data), P: n, px, py };
  }));
}

// Coarse-to-fine scan of the whole frame. Returns null when nothing matches well enough, or when
// the best spot isn't clearly better than the next-best distinct one (e.g. a repeated icon):
// staying "off-screen" is better than confidently re-locking onto the wrong copy.
function scan(f, a) {
  const half = (f.half ??= halve(f.data, f.width, f.height)), phases = (a.coarse ??= coarse(a));
  const W = half.width, n = phases[0].P, cols = W - n + 1, rows = half.height - n + 1;
  if (cols < 1 || rows < 1) return null;
  const scores = new Float32Array(cols * rows).fill(-1), phase = new Uint8Array(cols * rows);
  phases.forEach((h, k) => {
    if (h.norm < 1e-6) return;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const s = zncc(half.data, W, h.z, h.norm, n, x, y), i = y * cols + x;
      if (s > scores[i]) { scores[i] = s; phase[i] = k; }
    }
  });
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const bx = best % cols, by = Math.floor(best / cols), keep = n >> 1;
  let second = -1;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if ((Math.abs(x - bx) > keep || Math.abs(y - by) > keep) && scores[y * cols + x] > second) second = scores[y * cols + x];
  if (scores[best] - second < TRACK.margin) return null;
  const { px, py } = phases[phase[best]];
  const m = search(f.data, f.width, f.height, a, 2 * bx - px, 2 * by - py, 2);
  return m.score >= TRACK.lock ? m : null;
}

// A tracked anchor for a pin dropped at normalised (x, y) with the given template bytes.
// state: 'seeking' (not yet acquired) → 'locked' ⇄ 'occluded'; 'static' if the template is flat.
export function createAnchor(tpl, x, y) {
  const P = Math.round(Math.sqrt(tpl.length)), stats = zeroMean(tpl);
  return { tpl, P, z: stats.z, norm: stats.norm, x0: x, y0: y, x, y, score: 0, state: stats.std < TRACK.minStd ? 'static' : 'seeking', off: null, tick: 0 };
}

// Advance an anchor by one luma frame {data, width, height}; returns it (x, y normalised).
export function track(a, f) {
  const { data, width: W, height: H } = f, P = a.P;
  if (a.state === 'static' || W < P || H < P) return a;
  if (!a.off) { const [l, t] = origin(a.x0, a.y0, W, H, P); a.off = [a.x0 * W - l, a.y0 * H - t]; }
  const settle = (m) => Object.assign(a, { x: clamp((m.left + a.off[0]) / W, 0, 1), y: clamp((m.top + a.off[1]) / H, 0, 1), score: m.score, state: 'locked' });
  if (a.state !== 'occluded') {
    const m = search(data, W, H, a, Math.round(a.x * W - a.off[0]), Math.round(a.y * H - a.off[1]), TRACK.radius);
    if (m.score >= (a.state === 'locked' ? TRACK.lose : TRACK.lock)) return settle(m);
    Object.assign(a, { state: 'occluded', score: m.score, tick: 0 });
  }
  if (a.tick++ % (a.tick > 36 ? 12 : 3)) return a; // whole-frame scans: ~4 Hz while just lost, ~1 Hz after 3 s
  const m = scan(f, a);
  return m ? settle(m) : a;
}

// Where an off-screen pin waits: on the frame edge nearest its last known position, as an
// "Off-screen" pill centred on that edge, inset clear of the tile's corner controls.
export const DOCK = { edge: 0.03, top: 0.12, bottom: 0.95, span: 0.12 };
export function dock(x, y) {
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const edge = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
  return {
    edge,
    x: edge === 'left' ? DOCK.edge : edge === 'right' ? 1 - DOCK.edge : clamp(x, DOCK.span, 1 - DOCK.span),
    y: edge === 'top' ? DOCK.top : edge === 'bottom' ? DOCK.bottom : clamp(y, DOCK.top, DOCK.bottom),
  };
}

// ---------- Proposed move: background plate + tether ----------
// The one-pixel ring just outside an integer rect {x, y, w, h} of an RGBA frame (W×H), as RGB
// triples: top and bottom include the corners (w + 2 each), left and right don't (h each).
// Reads past the frame border clamp to the nearest pixel inside it.
export function ring(rgba, W, H, { x, y, w, h }) {
  const px = (cx, cy) => { const i = (clamp(cy, 0, H - 1) * W + clamp(cx, 0, W - 1)) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  const top = [], bottom = [], left = [], right = [];
  for (let i = -1; i <= w; i++) { top.push(px(x + i, y - 1)); bottom.push(px(x + i, y + h)); }
  for (let j = 0; j < h; j++) { left.push(px(x - 1, y + j)); right.push(px(x + w, y + j)); }
  return { top, bottom, left, right };
}

// Coons-patch fill (transfinite interpolation) of a w×h hole from its ring: matches every edge
// pixel exactly and reproduces any solid or linear-gradient background exactly — what screen UIs
// are made of — so a lifted region leaves a plausible "nothing was here" behind. RGBA out.
export function coonsFill({ top, bottom, left, right }, w, h) {
  const out = new Uint8ClampedArray(w * h * 4), c00 = top[0], c10 = top[w + 1], c01 = bottom[0], c11 = bottom[w + 1];
  for (let j = 0; j < h; j++) {
    const v = (j + 1) / (h + 1);
    for (let i = 0; i < w; i++) {
      const u = (i + 1) / (w + 1), o = (j * w + i) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (1 - v) * top[i + 1][c] + v * bottom[i + 1][c] + (1 - u) * left[j][c] + u * right[j][c]
          - ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c]);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// Validated, clamped patch box (normalised): the region keeps its size and both its old and new
// place lie fully inside the frame. Null if malformed or too small to see.
export function patchBox(m) {
  const v = [m?.sx, m?.sy, m?.sw, m?.sh, m?.tx, m?.ty];
  if (!v.every(Number.isFinite)) return null;
  const sw = clamp(v[2], 0, 1), sh = clamp(v[3], 0, 1);
  if (sw < 0.02 || sh < 0.02) return null;
  return { sx: clamp(v[0], 0, 1 - sw), sy: clamp(v[1], 0, 1 - sh), sw, sh, tx: clamp(v[4], 0, 1 - sw), ty: clamp(v[5], 0, 1 - sh) };
}

// The arrow from the region's old place to its proposed one, edge to edge (any rect units).
// Null when the two places overlap: the move is then obvious without one.
export function tether(S, T) {
  if (S.x < T.x + T.w && T.x < S.x + S.w && S.y < T.y + T.h && T.y < S.y + S.h) return null;
  const a = { x: S.x + S.w / 2, y: S.y + S.h / 2 }, b = { x: T.x + T.w / 2, y: T.y + T.h / 2 };
  // Fraction of the way from p to q where the segment crosses the border of rect R (centred on p).
  const exit = (p, q, R) => Math.min(...[[q.x - p.x, R.w / 2], [q.y - p.y, R.h / 2]].map(([d, half]) => (d ? half / Math.abs(d) : Infinity)));
  const s = exit(a, b, S), e = 1 - exit(b, a, T);
  return { x0: a.x + (b.x - a.x) * s, y0: a.y + (b.y - a.y) * s, x1: a.x + (b.x - a.x) * e, y1: a.y + (b.y - a.y) * e };
}

// ---------- Browser helper ----------
const pads = new Map(); // one scratch canvas per analysis size
// Luma of any image source (<video>, <img>, ImageBitmap) resampled to exactly w×h.
export function readLuma(src, w, h) {
  let pad = pads.get(`${w}x${h}`);
  if (!pad) {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    pads.set(`${w}x${h}`, (pad = c.getContext('2d', { willReadFrequently: true })));
  }
  pad.imageSmoothingQuality = 'high';
  pad.drawImage(src, 0, 0, w, h);
  return { data: luminance(pad.getImageData(0, 0, w, h).data, w, h), width: w, height: h };
}
