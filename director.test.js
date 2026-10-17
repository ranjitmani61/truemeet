import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEP, awayMonitor, burstDetector, chooseFocus, collisionDetector, crosstalkDetector, electedDirector, focusDirector, frameDiff, hesitationDetector, phraseTrigger, turnOrder } from './public/director.js';

test('director election: lowest connected Auto-Mode id, independent of join order', () => {
  const peers = new Map([
    ['c', { id: 'c', state: { auto: true } }],
    ['a', { id: 'a', state: { auto: false } }],
    ['b', { id: 'b', state: { auto: true } }],
    ['pending', { id: null, state: { auto: true } }],
  ]);
  assert.equal(electedDirector(peers.values()), 'b');
  peers.get('a').state.auto = true;
  assert.equal(electedDirector(peers.values()), 'a');
  peers.delete('a');
  assert.equal(electedDirector(peers.values()), 'b', 'disconnect elects the next director');
  peers.get('b').state.auto = false;
  assert.equal(electedDirector(peers.values()), 'c', 'opting out elects the next director');
  peers.get('c').state.auto = false;
  assert.equal(electedDirector(peers.values()), null);
  assert.equal(electedDirector([]), null);
});

test('phrase triggers', () => {
  assert.equal(phraseTrigger('Action item: Leo ships the deck'), 'action item');
  assert.equal(phraseTrigger('the deadline is Friday'), 'deadline');
  assert.equal(phraseTrigger('OK, let’s decide now'), 'decision');
  assert.equal(phraseTrigger('what are the next steps?'), 'next step');
  assert.equal(phraseTrigger('add it to the to-do list'), 'todo');
  assert.equal(phraseTrigger('Agreed.'), 'agreed');
  assert.equal(phraseTrigger('I will follow up tomorrow'), 'follow-up');
  assert.equal(phraseTrigger('what should we do today'), null, 'plain "to do" is not a trigger');
  assert.equal(phraseTrigger('stepping out'), null);
});

test('reaction burst needs volume, variety and respects cooldown', () => {
  const burst = burstDetector();
  assert.equal(burst('a', 0), false);
  assert.equal(burst('a', 100), false);
  assert.equal(burst('a', 200), false, 'one person spamming is not a burst');
  assert.equal(burst('b', 300), true);
  assert.equal(burst('b', 400), false, 'cooldown');
  const slow = burstDetector();
  assert.equal(slow('a', 0) || slow('b', 6000) || slow('c', 12_000), false, 'spread out is not a burst');
});

test('crosstalk needs sustained overlap', () => {
  const cross = crosstalkDetector();
  assert.equal(cross(2, 0), false);
  assert.equal(cross(1, 1000), false, 'gap resets');
  assert.equal(cross(2, 1100), false);
  assert.equal(cross(3, 2700), true);
  assert.equal(cross(2, 5000), false, 'cooldown');
});

test('focus: share holds while annotated, speaker takes over after 10s idle', () => {
  const base = { share: 'B', speaker: 'C', speakerAt: 0, count: 3 };
  assert.equal(chooseFocus({ ...base, shareActiveAt: 0, now: 5000, speakerAt: 4500 }), 'B', 'fresh share stays');
  assert.equal(chooseFocus({ ...base, shareActiveAt: 0, now: 11_000, speakerAt: 10_500 }), 'C', 'idle share yields to speaker');
  assert.equal(chooseFocus({ ...base, shareActiveAt: 10_000, now: 11_000, speakerAt: 10_500 }), 'B', 'ink activity reclaims stage');
  assert.equal(chooseFocus({ ...base, speaker: 'B', shareActiveAt: 0, now: 20_000, speakerAt: 19_500 }), 'B', 'sharer talking keeps share');
  assert.equal(chooseFocus({ ...base, shareActiveAt: 0, now: 20_000, speakerAt: 10_000 }), 'B', 'nobody else talking keeps share');
  assert.equal(chooseFocus({ share: null, speaker: 'C', speakerAt: 0, now: 500, count: 2 }), null, 'two people use the gallery');
  assert.equal(chooseFocus({ share: null, speaker: 'C', speakerAt: 0, now: 5000, count: 4 }), KEEP, 'pause keeps focus');
});

test('focus dwell prevents flapping', () => {
  const f = focusDirector({ dwellMs: 1000 });
  assert.equal(f('A', 0), null);
  assert.equal(f('A', 999), null);
  assert.equal(f('A', 1000), 'A');
  assert.equal(f('B', 1100), 'A');
  assert.equal(f('A', 1500), 'A', 'flip back cancels');
  assert.equal(f('B', 1600), 'A');
  assert.equal(f(KEEP, 2000), 'A');
  assert.equal(f('B', 2100), 'A');
  assert.equal(f('B', 3100), 'B');
});

test('away: prompt, then auto-mute; activity or speech resets', () => {
  const away = awayMonitor({ promptMs: 100, awayMs: 300 });
  const tick = (now, o = {}) => away({ now, micOn: true, speaking: false, active: false, ...o });
  assert.equal(tick(0), null);
  assert.equal(tick(100), 'prompt');
  assert.equal(tick(150), null, 'prompt only once');
  assert.equal(tick(300), 'away');
  assert.equal(tick(310, { active: true }), null);
  assert.equal(tick(500), null, 'idle timer restarted by activity');
  assert.equal(away({ now: 1000, micOn: false, speaking: false, active: false }), null, 'muted mic is never nagged');
});

test('frame diff', () => {
  assert.equal(frameDiff(new Uint8Array([0, 10]), new Uint8Array([4, 6])), 4);
  assert.equal(frameDiff(null, new Uint8Array(2)), 0);
});


test('collision: overlap, abrupt mutual stop, awkward pause → one signal', () => {
  const hit = collisionDetector();
  const run = (frames) => frames.map(([speaking, t]) => hit(speaking, t)).filter(Boolean);
  // A and B overlap for 450 ms, both stop within 150 ms, silence for 750 ms.
  const out = run([[['A'], 0], [['A', 'B'], 100], [['A', 'B'], 400], [['A', 'B'], 550], [['B'], 650], [[], 700], [[], 1200], [[], 1450]]);
  assert.deepEqual(out, [['A', 'B']]);
});

test('collision: no signal when it resolves itself or is too brief', () => {
  const brief = collisionDetector();
  assert.deepEqual([[['A', 'B'], 0], [['A', 'B'], 200], [[], 300], [[], 1200]].map(([s, t]) => brief(s, t)).filter(Boolean), [], 'overlap under 350 ms');
  const yielded = collisionDetector();
  assert.deepEqual([[['A', 'B'], 0], [['A', 'B'], 500], [['A'], 600], [['A'], 1300], [['A'], 2000], [[], 2100], [[], 3000]].map(([s, t]) => yielded(s, t)).filter(Boolean), [], 'B yielded, A carried on');
  const resumed = collisionDetector();
  assert.deepEqual([[['A', 'B'], 0], [['A', 'B'], 500], [[], 600], [['B'], 900], [[], 1000], [[], 2000]].map(([s, t]) => resumed(s, t)).filter(Boolean), [], 'B picked it back up during the pause');
  const cool = collisionDetector({ cooldownMs: 10_000 });
  const twice = [[['A', 'B'], 0], [['A', 'B'], 500], [[], 600], [[], 1400], [['A', 'B'], 2000], [['A', 'B'], 2500], [[], 2600], [[], 3400]].map(([s, t]) => cool(s, t)).filter(Boolean);
  assert.equal(twice.length, 1, 'cooldown');
});

test('turn order: least talk time first, deterministic ties', () => {
  assert.deepEqual(turnOrder(['b', 'a', 'c'], { a: 9000, b: 1000, c: 1000 }), ['b', 'c', 'a']);
  assert.deepEqual(turnOrder(['y', 'x'], {}), ['x', 'y']);
});

test('unmute hesitation: tried to jump in vs. genuinely spoke vs. stayed on', () => {
  const h = hesitationDetector();
  h.unmute('bo', 0, true);
  h.tick('bo', 150, true);
  assert.equal(h.mute('bo', 2500), true, 'blip of speech over someone else, muted within 3 s');
  h.unmute('bo', 10_000, true);
  h.tick('bo', 150, true); h.tick('bo', 150, true);
  assert.equal(h.mute('bo', 11_000), false, '300 ms is a real attempt that went through');
  h.unmute('bo', 20_000, false);
  assert.equal(h.mute('bo', 21_000), false, 'nobody else was talking');
  h.unmute('bo', 30_000, true);
  assert.equal(h.mute('bo', 34_000), false, 'stayed unmuted longer than 3 s');
  assert.equal(h.mute('cy', 0), false, 'never unmuted');
});
