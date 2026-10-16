import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rooms, server } from './server.js';
import { createIdentity, proposalPayload, sign, verify } from './public/ledger.js';

let base;
before(() => new Promise((resolve) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; resolve(); })));
after(() => { server.closeAllConnections(); server.close(); });

// Minimal SSE client: `next()` resolves with the next message, `close()` disconnects.
const open = (room, name) => {
  const ctrl = new AbortController(), queue = [];
  let wake;
  (async () => {
    const res = await fetch(`${base}/api/events?room=${room}&name=${name}`, { signal: ctrl.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        if (line) { queue.push(JSON.parse(line.slice(6))); wake?.(); }
      }
    }
  })().catch(() => {});
  return {
    next: async () => { while (!queue.length) await new Promise((r) => (wake = r)); return queue.shift(); },
    until: async (type) => { for (;;) { const m = await (async () => { while (!queue.length) await new Promise((r) => (wake = r)); return queue.shift(); })(); if (m.type === type) return m; } },
    close: () => ctrl.abort(),
  };
};
const poster = (room) => (who, msg) => fetch(`${base}/api/signal`, { method: 'POST', body: JSON.stringify({ room, id: who.id, key: who.key, ...msg }) }).then((r) => r.status);
const settle = async (room) => { for (let i = 0; rooms.has(room) && i < 100; i++) await new Promise((r) => setTimeout(r, 10)); };

test('signaling: join, relay, host lock and kick', async () => {
  const post = poster('test-room');
  const a = open('test-room', 'Ana');
  const wa = await a.next();
  assert.equal(wa.type, 'welcome');
  assert.equal(wa.host, wa.id, 'first in is host');
  assert.deepEqual(wa.peers, []);
  assert.equal(typeof wa.started, 'number');

  const b = open('test-room', 'Bo');
  const wb = await b.next();
  assert.equal(wb.peers[0].id, wa.id);
  assert.equal((await a.next()).peer.name, 'Bo');

  assert.equal(await post(wb, { type: 'offer', to: wa.id, sdp: { type: 'offer', sdp: 'v=0' }, name: 'Spoofed', extra: 1 }), 204);
  assert.deepEqual(await a.next(), { type: 'offer', from: wb.id, name: 'Bo', sdp: { type: 'offer', sdp: 'v=0' } }, 'server stamps sender, strips extras');

  assert.equal(await post(wb, { type: 'state', state: { mic: 1, lang: '<script>', extra: 'x' } }), 204);
  assert.deepEqual((await a.next()).state, { mic: true, cam: false, hand: false, screen: false, rec: false, ink: false, auto: false, lang: '' }, 'state is sanitised');
  assert.equal(await post(wb, { type: 'ink', s: 'board', op: 'pts', sid: 's1', tool: 'pen', color: '#ffffff', pts: [0.1, 7, -2, 0.5, 0.3] }), 204);
  const ink = await a.next();
  assert.deepEqual(ink.pts, [0.1, 1, 0, 0.5], 'coordinates clamped, odd tail dropped');

  // Waiting room: host holds newcomers, then admits or denies them.
  assert.equal(await post(wb, { type: 'waiting', on: true }), 403, 'only host controls the waiting room');
  assert.equal(await post(wa, { type: 'waiting', on: true }), 204);
  assert.equal((await a.next()).on, true);
  assert.equal((await b.next()).on, true);
  const d = open('test-room', 'Di');
  assert.equal((await d.next()).type, 'waiting');
  const knock = await a.next();
  assert.equal(knock.type, 'knock');
  assert.equal(await post(wb, { type: 'admit', target: knock.peer.id }), 403);
  assert.equal(await post(wa, { type: 'admit', target: knock.peer.id }), 204);
  assert.equal((await d.next()).type, 'welcome');
  assert.equal((await d.next()).type, 'catchup', 'admitted from the waiting room → catch-up');
  assert.equal((await a.next()).peer.name, 'Di');
  assert.equal((await b.next()).peer.name, 'Di');
  const e = open('test-room', 'Ed');
  assert.equal((await e.next()).type, 'waiting');
  const knock2 = await a.next();
  assert.equal(await post(wa, { type: 'deny', target: knock2.peer.id }), 204);
  assert.match((await e.next()).reason, /didn’t let you in/);
  d.close();
  assert.equal((await a.next()).type, 'leave');
  assert.equal((await b.next()).type, 'leave');

  assert.equal(await post({ ...wb, key: 'nope' }, { type: 'chat', text: 'hi' }), 403, 'bad key');
  assert.equal(await post(wb, { type: 'welcome' }), 403, 'clients cannot forge server messages');
  assert.equal(await post(wb, { type: 'lock', locked: true }), 403, 'only host locks');
  assert.equal(await post(wa, { type: 'lock', locked: true }), 204);
  assert.equal((await a.next()).locked, true);
  assert.equal((await b.next()).locked, true);

  const c = open('test-room', 'Cy');
  assert.match((await c.next()).reason, /locked/);

  assert.equal(await post(wa, { type: 'kick', target: wb.id }), 204);
  assert.equal((await b.next()).type, 'kicked');
  assert.deepEqual(await a.next(), { type: 'leave', from: wb.id });

  a.close();
  await settle('test-room');
  assert.ok(!rooms.has('test-room'), 'empty room is dropped');
});

test('pins: server numbers them, author or sharer resolves, malformed rejected', async () => {
  const post = poster('pin-room');
  const a = open('pin-room', 'Ana'), wa = await a.next();
  const b = open('pin-room', 'Bo'), wb = await b.next();
  await a.until('join');
  const share = `share:${wa.id}`;

  assert.equal(await post(wb, { type: 'ink', s: share, op: 'pin', pid: 'p1', x: 0.5, y: 0.5 }), 403, 'cannot pin a screen that is not being shared');
  assert.equal(await post(wa, { type: 'state', state: { screen: true, ink: true } }), 204);
  await b.until('state');

  assert.equal(await post(wb, { type: 'ink', s: share, op: 'pin', pid: 'p1', x: 1.4, y: -3, note: `<b>hi</b>${'x'.repeat(300)}`, color: 'javascript:alert(1)', extra: 'nope' }), 204);
  const pinA = await a.until('ink'), pinB = await b.until('ink');
  assert.deepEqual(pinB, pinA, 'author gets the same authoritative echo');
  assert.equal(pinA.n, 1);
  assert.equal(pinA.pid, 'p1');
  assert.deepEqual([pinA.x, pinA.y], [1, 0], 'clamped to [0,1]');
  assert.equal(pinA.note.length, 140, 'note capped');
  assert.equal(pinA.note.slice(0, 9), '<b>hi</b>', 'stored as plain text; clients render it with text nodes');
  assert.equal(pinA.color, '#a78bfa', 'bad colour replaced');
  assert.equal(pinA.extra, undefined, 'unexpected fields stripped');
  assert.equal(pinA.by, wb.id);
  assert.equal(typeof pinA.t, 'number');

  assert.equal(await post(wb, { type: 'ink', s: share, op: 'pin', pid: 'p2', x: 0.2, y: 0.2, note: 'second' }), 204);
  assert.equal((await a.until('ink')).n, 2);
  await b.until('ink');
  assert.equal(await post(wb, { type: 'ink', s: share, op: 'pin', pid: 'p2', x: 0.2, y: 0.2 }), 409, 'pid is unique');
  for (const bad of [{ pid: 'p 3', x: 0.1, y: 0.1 }, { pid: 'p3', x: '0.1', y: 0.1 }, { pid: 'p3', x: 0.1 }, { pid: 'p3', x: 0.1, y: 0.1, note: 42 }]) {
    assert.equal(await post(wb, { type: 'ink', s: share, op: 'pin', ...bad }), 400, JSON.stringify(bad));
  }
  assert.equal(await post(wb, { type: 'ink', s: 'share:../../etc', op: 'pin', pid: 'p9', x: 0, y: 0 }), 400, 'surface key validated');

  const c = open('pin-room', 'Cy'), wc = await c.next();
  assert.equal((await c.next()).pins.length, 2, 'late joiner receives existing pins');
  await a.until('join'); await b.until('join');
  assert.equal(await post(wc, { type: 'ink', s: share, op: 'resolve', pid: 'p1' }), 403, 'only author or sharer resolves');
  assert.equal(await post(wb, { type: 'ink', s: share, op: 'resolve', pid: 'p1' }), 204, 'author resolves');
  assert.equal((await a.until('ink')).op, 'resolve');
  assert.equal(await post(wa, { type: 'ink', s: share, op: 'resolve', pid: 'p2' }), 204, 'sharer resolves');
  assert.equal(await post(wa, { type: 'ink', s: share, op: 'resolve', pid: 'zzz' }), 404);

  assert.equal(await post(wa, { type: 'state', state: { screen: false } }), 204);
  await c.until('state');
  const d = open('pin-room', 'Di');
  await d.next();
  assert.equal(rooms.get('pin-room').pins.get(share).items.size, 0, 'pins end with the share');
  [a, b, c, d].forEach((x) => x.close());
  await settle('pin-room');
});

test('highlights + captions: relayed sanitised and replayed as catch-up for late joiners', async () => {
  const post = poster('cu-room');
  const a = open('cu-room', 'Ana'), wa = await a.next();
  assert.equal(await post(wa, { type: 'mark', auto: true, reason: 'decision', context: 'Ana: “let’s decide on Friday”', nid: 'h1', extra: 'x' }), 204);
  assert.equal(await post(wa, { type: 'mark', auto: true, reason: 'gossip', context: 'x' }), 400, 'unknown auto reason rejected');
  assert.equal(await post(wa, { type: 'mark', context: { evil: true } }), 400, 'context must be text');
  assert.equal(await post(wa, { type: 'mark', context: 'manual one', nid: 'h2' }), 204);
  assert.equal(await post(wa, { type: 'caption', text: 'Action item: ship it', final: true, lang: 'en-US', nid: 'c1' }), 204);
  assert.equal(await post(wa, { type: 'caption', text: 'interim words', final: false }), 204);
  assert.equal(await post(wa, { type: 'caption', text: 7, final: true }), 400);
  assert.equal(await post(wa, { type: 'catchup', highlights: [] }), 400, 'clients cannot send catch-up');

  const b = open('cu-room', 'Bo');
  assert.equal((await b.next()).type, 'welcome');
  const mark = await (async () => { assert.equal(await post(wa, { type: 'mark', auto: true, reason: 'reactions', context: 'burst', nid: 'h3' }), 204); return b.until('mark'); })();
  assert.deepEqual(mark, { type: 'mark', from: wa.id, name: 'Ana', context: 'burst', auto: true, reason: 'reactions', nid: 'h3' }, 'auto-highlight relayed, extras stripped');

  rooms.get('cu-room').started -= 31_000; // the meeting has now been running for over 30 seconds
  const c = open('cu-room', 'Cy');
  assert.equal((await c.next()).type, 'welcome');
  const cu = await c.next();
  assert.equal(cu.type, 'catchup', 'late direct joiner gets catch-up');
  assert.ok(cu.now - cu.started > 30_000);
  assert.deepEqual(cu.highlights.map((h) => [h.nid, h.auto, h.reason ?? null]), [['h1', true, 'decision'], ['h2', false, null], ['h3', true, 'reactions']]);
  assert.deepEqual(cu.captions.map((x) => [x.nid, x.name, x.text]), [['c1', 'Ana', 'Action item: ship it']], 'only final captions are buffered');
  assert.equal(cu.highlights[0].extra, undefined);
  [a, b, c].forEach((x) => x.close());
  await settle('cu-room');
  assert.ok(!rooms.has('cu-room'), 'buffers vanish with the room');
});

const JPEG = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`;

test('beam-snapshot + whisper: one-to-one only, images and overlays validated', async () => {
  const post = poster('novel-room');
  const a = open('novel-room', 'Ana'), wa = await a.next();
  const b = open('novel-room', 'Bo'), wb = await b.next();
  const c = open('novel-room', 'Cy'), wc = await c.next();
  await a.until('join'); await a.until('join'); await b.until('join');

  const beam = { type: 'beam-snapshot', to: wb.id, image: JPEG, ago: 34, strokes: [{ tool: 'pen', color: '#f2f4fa', pts: [0.1, 0.2, 1.7, -1] }], pins: [{ n: 1, x: 0.5, y: 2, note: 'Was this <b>right</b>?' }], extra: 'x' };
  assert.equal(await post(wa, beam), 204);
  const got = await b.until('beam-snapshot');
  assert.deepEqual(got, { type: 'beam-snapshot', from: wa.id, name: 'Ana', image: JPEG, ago: 34, strokes: [{ tool: 'pen', color: '#f2f4fa', pts: [0.1, 0.2, 1, 0] }], pins: [{ n: 1, x: 0.5, y: 1, note: 'Was this <b>right</b>?', color: '#a78bfa' }] }, 'clamped, defaulted, extras stripped');
  for (const [bad, why] of [
    [{ ...beam, to: undefined }, 'must be targeted'],
    [{ ...beam, to: wa.id }, 'not to yourself'],
    [{ ...beam, to: 'nobody' }, 'unknown target'],
    [{ ...beam, image: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'no SVG'],
    [{ ...beam, image: 'data:image/jpeg;base64,not base64!' }, 'not base64'],
    [{ ...beam, image: `data:image/jpeg;base64,${'A'.repeat(200_001)}` }, 'too big'],
    [{ ...beam, ago: -1 }, 'ago range'],
    [{ ...beam, ago: 1.5 }, 'ago integer'],
    [{ ...beam, strokes: [{ tool: 'brush', color: '#ffffff', pts: [0, 0] }] }, 'unknown tool'],
    [{ ...beam, strokes: Array(101).fill(beam.strokes[0]) }, 'too many strokes'],
    [{ ...beam, pins: [{ n: 0, x: 0.1, y: 0.1 }] }, 'pin number'],
    [{ ...beam, pins: [{ n: 1, x: '0.1', y: 0.1 }] }, 'pin coordinates'],
  ]) assert.equal(await post(wa, bad), 400, why);

  assert.equal(await post(wa, { type: 'whisper', to: wb.id, on: true, extra: 1 }), 204);
  assert.deepEqual(await b.until('whisper'), { type: 'whisper', from: wa.id, name: 'Ana', on: true });
  assert.equal(await post(wa, { type: 'whisper', on: true }), 400, 'a whisper is never broadcast');
  assert.equal(await post(wa, { type: 'whisper', to: wa.id, on: true }), 400);
  assert.equal(await post(wa, { type: 'whisper', to: wb.id, on: 'yes' }), 400);
  assert.equal(await post(wa, { type: 'whisper', to: wb.id, on: false }), 204);
  assert.equal((await b.until('whisper')).on, false);

  // Turn queue: only from an Auto-Mode director, only about people in the room.
  assert.equal(await post(wa, { type: 'turn-queue', order: [wb.id, wc.id] }), 403, 'not in Auto-Mode');
  assert.equal(await post(wa, { type: 'state', state: { auto: true, mic: true } }), 204);
  await b.until('state'); await c.until('state');
  assert.equal(await post(wa, { type: 'turn-queue', order: [wb.id, wc.id] }), 204);
  assert.deepEqual((await c.until('turn-queue')).order, [wb.id, wc.id]);
  assert.equal(await post(wa, { type: 'turn-queue', order: [wb.id] }), 400, 'needs two people');
  assert.equal(await post(wa, { type: 'turn-queue', order: [wb.id, wb.id] }), 400, 'no duplicates');
  assert.equal(await post(wa, { type: 'turn-queue', order: [wb.id, '00000000-0000-0000-0000-000000000000'] }), 400, 'unknown participant');

  // Host nudge after a hesitation
  assert.equal(await post(wb, { type: 'nudge', target: wc.id }), 403, 'host only');
  assert.equal(await post(wa, { type: 'nudge', target: wc.id }), 204);
  assert.deepEqual(await c.until('nudge'), { type: 'nudge', name: 'Ana' });

  // Snip cards on the whiteboard
  const card = { type: 'ink', s: 'board', op: 'card', cid: 'k1', image: JPEG, x: 0.1, y: 0.1, w: 0.3, h: 1.4, caption: 'Bo’s screen · 10:42' };
  assert.equal(await post(wc, card), 204);
  assert.equal((await a.until('ink')).h, 1, 'clamped');
  assert.equal(await post(wc, { ...card, s: `share:${wb.id}` }), 400, 'cards only go on the whiteboard');
  assert.equal(await post(wc, { ...card, w: 0.001 }), 400, 'degenerate card');
  assert.equal(await post(wc, { ...card, image: 'https://example.com/x.png' }), 400, 'no remote URLs');
  [a, b, c].forEach((x) => x.close());
  await settle('novel-room');
});

test('decision ledger: server verifies real signatures and refuses forgeries', async () => {
  const post = poster('ledger-room');
  const a = open('ledger-room', 'Ana'), wa = await a.next();
  const b = open('ledger-room', 'Bo'), wb = await b.next();
  await a.until('join');
  const ana = await createIdentity(), bo = await createIdentity(), eve = await createIdentity();

  assert.equal(await post(wa, { type: 'identity', jwk: { ...ana.jwk, d: 'private-part-is-stripped' } }), 204);
  assert.deepEqual((await b.until('identity')).jwk, ana.jwk, 'only the public point is relayed');
  assert.equal(await post(wa, { type: 'identity', jwk: eve.jwk }), 409, 'no key swapping mid-meeting');
  assert.equal(await post(wb, { type: 'identity', jwk: { kty: 'EC', crv: 'P-256', x: 'nope', y: 'nope' } }), 400);

  assert.equal(await post(wa, { type: 'proposal', text: 'Ship v2 on Friday', extra: 1 }), 204);
  const prop = await a.until('proposal');
  assert.deepEqual(await b.until('proposal'), prop, 'everyone, including the proposer, gets the same proposal');
  assert.match(prop.proposalId, /^prop-1-[0-9a-f]{6}$/);
  assert.equal(prop.roomCode, 'ledger-room');
  assert.equal(await post(wa, { type: 'proposal', text: '   ' }), 400);

  const payload = proposalPayload(prop);
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig: await sign(bo.privateKey, payload) }), 409, 'Bo has not published a key yet');
  assert.equal(await post(wb, { type: 'identity', jwk: bo.jwk }), 204);
  await a.until('identity');
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig: await sign(eve.privateKey, payload) }), 400, 'signed with someone else’s key');
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig: await sign(bo.privateKey, proposalPayload({ ...prop, text: 'Ship v2 on Monday' })) }), 400, 'signed different words');
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig: 'A'.repeat(86) }), 400, 'garbage signature');
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: 'prop-99-000000', sig: await sign(bo.privateKey, payload) }), 404);
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig: 'short' }), 400, 'schema');

  const sig = await sign(bo.privateKey, payload);
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig }), 204);
  const signed = await a.until('proposal-signed');
  assert.deepEqual([signed.name, signed.sig, signed.jwk], ['Bo', sig, bo.jwk]);
  assert.equal(await verify(signed.jwk, payload, signed.sig), true, 'relayed signature verifies client-side');
  assert.equal(await post(wb, { type: 'proposal-sign', proposalId: prop.proposalId, sig }), 409, 'one signature per person');

  const c = open('ledger-room', 'Cy');
  assert.equal((await c.next()).type, 'welcome');
  const ledger = await c.until('ledger');
  assert.equal(ledger.proposals[0].signatures[0].sig, sig, 'late joiners receive the ledger');
  [a, b, c].forEach((x) => x.close());
  await settle('ledger-room');
});
