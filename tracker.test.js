import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK, capture, coonsFill, createAnchor, dock, patchBox, ring, tether, track } from './public/tracker.js';

const W = TRACK.width, H = 180;
const rng = (seed) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
// Smooth "screen" background: value noise on an 8-px lattice, bilinearly interpolated.
const BG = (() => {
  const r = rng(7), gw = W / 8 + 2, lattice = Array.from({ length: gw * (H / 8 + 2) }, () => 80 + r() * 90), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x / 8, gy = y / 8, i = Math.floor(gx), j = Math.floor(gy), u = gx - i, v = gy - j, at = (a, b) => lattice[b * gw + a];
      out[y * W + x] = (1 - v) * ((1 - u) * at(i, j) + u * at(i + 1, j)) + v * ((1 - u) * at(i, j + 1) + u * at(i + 1, j + 1));
    }
  }
  return out;
})();
const FEATURE = (() => { const r = rng(42); return Uint8Array.from({ length: 18 * 18 }, () => r() * 255); })(); // a distinctive 18×18 icon
// A frame with the feature's top-left at each given point, plus optional per-pixel noise.
function frame(spots = [], noise = 0, seed = 1) {
  const data = BG.slice(), r = rng(seed);
  for (const [fx, fy] of spots) for (let j = 0; j < 18; j++) for (let i = 0; i < 18; i++) data[(fy + j) * W + fx + i] = FEATURE[j * 18 + i];
  if (noise) for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (r() * 2 - 1) * noise));
  return { data, width: W, height: H };
}
const centre = ([fx, fy]) => [(fx + 9) / W, (fy + 9) / H]; // where a user would click: the icon's middle
const near = (a, [fx, fy], px = 0.6) => {
  const [x, y] = centre([fx, fy]);
  assert.ok(Math.abs(a.x - x) * W <= px && Math.abs(a.y - y) * H <= px, `anchor at (${(a.x * W).toFixed(2)}, ${(a.y * H).toFixed(2)}) px, feature centre at (${x * W}, ${y * H})`);
};

test('living anchor: follows a moving feature, docks when it vanishes, re-locks when it returns', () => {
  const start = [100, 60];
  const tpl = capture(frame([start]), ...centre(start));
  assert.equal(tpl.length, TRACK.patch ** 2, 'a 16×16 luma template travels with the pin');
  const a = createAnchor(tpl, ...centre(start));
  track(a, frame([start]));
  assert.equal(a.state, 'locked');
  assert.ok(a.score > 0.99);
  near(a, start, 0.2);

  // The shared window scrolls/drags the feature by (dx, dy) each frame, through codec-like noise.
  let at = start;
  for (let k = 1; k <= 12; k++) {
    at = [100 + 6 * k, 60 + 3 * k];
    track(a, frame([at], 8, k));
    assert.equal(a.state, 'locked', `frame ${k}`);
    near(a, at);
  }

  // Covered (window closed / scrolled away): occluded, last position kept for docking.
  const last = { x: a.x, y: a.y };
  for (let k = 0; k < 4; k++) track(a, frame([], 8, 100 + k));
  assert.equal(a.state, 'occluded');
  assert.deepEqual({ x: a.x, y: a.y }, last);

  // Back somewhere else entirely: the coarse-to-fine whole-frame scan re-locks within 3 ticks.
  const back = [230, 130];
  for (let k = 0; k < 3 && a.state !== 'locked'; k++) track(a, frame([back], 8, 200 + k));
  assert.equal(a.state, 'locked');
  near(a, back);

  // A jump far beyond the local search radius re-locks in the same tick.
  const jump = [20, 15];
  track(a, frame([jump], 8, 300));
  assert.equal(a.state, 'locked');
  near(a, jump);
});

test('living anchor: never re-locks onto an ambiguous copy; flat areas are not tracked', () => {
  const start = [60, 40];
  const a = createAnchor(capture(frame([start]), ...centre(start)), ...centre(start));
  track(a, frame([start]));
  for (let k = 0; k < 6; k++) track(a, frame([], 0, k));
  assert.equal(a.state, 'occluded');
  for (let k = 0; k < 6; k++) track(a, frame([[200, 40], [200, 120]], 0, k));
  assert.equal(a.state, 'occluded', 'two identical icons: stay off-screen rather than guess');
  for (let k = 0; k < 3 && a.state !== 'locked'; k++) track(a, frame([[200, 120]], 0, 9));
  near(a, [200, 120]);

  const flat = { data: new Uint8Array(W * H).fill(200), width: W, height: H };
  assert.equal(capture(flat, 0.5, 0.5), null, 'nothing to lock onto');
  const still = createAnchor(new Uint8Array(256).fill(9), 0.5, 0.5);
  assert.equal(track(still, frame([start])).state, 'static');
  assert.deepEqual([still.x, still.y], [0.5, 0.5]);

  // Pins near the frame edge keep their exact offset inside a clamped template.
  const corner = [0, 0];
  const c = createAnchor(capture(frame([corner]), 2 / W, 3 / H), 2 / W, 3 / H);
  track(c, frame([[30, 20]], 4));
  assert.equal(c.state, 'locked');
  assert.ok(Math.abs(c.x * W - 32) < 0.6 && Math.abs(c.y * H - 23) < 0.6);
});

test('docking: an off-screen pin waits at the nearest edge, fully visible', () => {
  assert.deepEqual(dock(0.55, 0.9), { edge: 'bottom', x: 0.55, y: 0.95 });
  assert.deepEqual(dock(0.98, 0.5), { edge: 'right', x: 0.97, y: 0.5 });
  assert.deepEqual(dock(0.3, 0.02), { edge: 'top', x: 0.3, y: 0.12 });
  assert.deepEqual(dock(0.95, 0.99), { edge: 'bottom', x: 0.88, y: 0.95 }, 'clear of the corner controls');
  assert.deepEqual(dock(0.01, 0.02), { edge: 'left', x: 0.03, y: 0.12 });
});

// RGBA test frames for the background plate.
const rgba = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255], (y * w + x) * 4); return d; };

test('proposed move: the Coons plate reproduces UI backgrounds and erases what was there', () => {
  const gradient = (x, y) => [20 + 2 * x, 200 - y * 3, 90 + x + y]; // a linear gradient panel
  const box = { x: 12, y: 9, w: 20, h: 14 };
  const withCard = rgba(48, 32, (x, y) => (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h ? [255, 0, 200] : gradient(x, y)));
  const fill = coonsFill(ring(withCard, 48, 32, box), box.w, box.h);
  let worst = 0;
  for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(fill[(j * box.w + i) * 4 + c] - gradient(box.x + i, box.y + j)[c]));
  assert.ok(worst <= 1, `magenta card replaced by the exact background gradient (worst channel error ${worst})`);
  assert.equal(fill[3], 255);

  const solid = coonsFill(ring(rgba(10, 10, () => [33, 66, 99]), 10, 10, { x: 0, y: 0, w: 10, h: 10 }), 10, 10); // clamped at the frame border
  assert.deepEqual([...solid.slice(0, 4)], [33, 66, 99, 255]);
});

test('proposed move: geometry is validated and the tether runs edge to edge', () => {
  assert.deepEqual(patchBox({ sx: 0.9, sy: -1, sw: 0.2, sh: 0.1, tx: 2, ty: 0.5 }), { sx: 0.8, sy: 0, sw: 0.2, sh: 0.1, tx: 0.8, ty: 0.5 }, 'both places kept inside the frame');
  assert.equal(patchBox({ sx: 0.1, sy: 0.1, sw: 0.01, sh: 0.3, tx: 0, ty: 0 }), null, 'too small');
  assert.equal(patchBox({ sx: '0.1', sy: 0.1, sw: 0.2, sh: 0.3, tx: 0, ty: 0 }), null, 'not numbers');
  const S = { x: 0, y: 0, w: 10, h: 10 }, T = { x: 30, y: 0, w: 10, h: 10 };
  assert.deepEqual(tether(S, T), { x0: 10, y0: 5, x1: 30, y1: 5 });
  assert.equal(tether(S, { x: 5, y: 5, w: 10, h: 10 }), null, 'overlapping: no arrow');
});
