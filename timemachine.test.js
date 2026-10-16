import test from 'node:test';
import assert from 'node:assert/strict';
import { agoLabel, cardSlot, createRing, fitWithin, normRect, sourceRect } from './public/timemachine.js';

test('ring buffer keeps the newest N frames, oldest first', () => {
  const ring = createRing(3);
  assert.equal(ring.due(0), true, 'empty ring wants a frame');
  const f = (t) => ({ t });
  assert.equal(ring.push(f(0)), null);
  assert.equal(ring.due(1999, 2000), false);
  assert.equal(ring.due(2000, 2000), true);
  ring.push(f(2000));
  ring.push(f(4000));
  const evicted = ring.push(f(6000));
  assert.deepEqual(evicted, { t: 0 }, 'oldest evicted at capacity');
  assert.equal(ring.size, 3);
  assert.deepEqual([ring.at(0).t, ring.at(2).t, ring.latest().t], [2000, 6000, 6000]);
  assert.equal(ring.at(5), null);
  const viewed = ring.at(0);
  ring.push(f(8000));
  assert.equal(ring.indexOf(viewed), -1, 'a viewed frame can be evicted; callers keep their own reference');
  assert.equal(ring.clear().length, 3);
  assert.equal(ring.size, 0);
});

test('ago labels', () => {
  assert.equal(agoLabel(34_400), '-34s');
  assert.equal(agoLabel(65_000), '-1:05');
  assert.equal(agoLabel(-50), '-0s');
});

test('snip geometry: any drag direction, clamped, source pixels, letterbox-safe', () => {
  assert.deepEqual(normRect(0.8, 0.9, 0.2, 0.1), { x: 0.2, y: 0.1, w: 0.6000000000000001, h: 0.8 });
  assert.deepEqual(normRect(-0.5, 0.5, 1.5, 0.75), { x: 0, y: 0.5, w: 1, h: 0.25 }, 'clamped to content');
  assert.deepEqual(sourceRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1920, 1080), { sx: 480, sy: 540, w: 960, h: 270 });
  assert.deepEqual(sourceRect({ x: 1, y: 1, w: 0, h: 0 }, 640, 360), { sx: 639, sy: 359, w: 1, h: 1 }, 'never empty, never outside');
  assert.deepEqual(fitWithin(1920, 1080, 960), { w: 960, h: 540 });
  assert.deepEqual(fitWithin(300, 200, 960), { w: 300, h: 200 }, 'never upscales');
});

test('whiteboard card slots: grid, aspect preserved, inside the board', () => {
  const wide = cardSlot(0, 16 / 9);
  assert.ok(Math.abs(wide.w - 0.3) < 1e-9 && Math.abs(wide.h - 0.3) < 1e-9, '16:9 snip fills a cell');
  const tall = cardSlot(1, 0.5);
  assert.ok(tall.h <= 0.3 && Math.abs((tall.w / tall.h) * (16 / 9) - 0.5) < 1e-9, 'tall snip keeps aspect');
  assert.ok(tall.x > wide.x, 'next column');
  const slots = Array.from({ length: 12 }, (_, i) => cardSlot(i, 4 / 3));
  for (const s of slots) assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= 1 && s.y + s.h <= 1, JSON.stringify(s));
  assert.notDeepEqual(slots[9], slots[0], 'tenth snip cascades instead of covering the first');
});
