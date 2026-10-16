import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from './public/ledger.js';
import { GENESIS, WITNESS, WITNESS_BEGIN, WITNESS_END, checkFrame, digest, distance, hamming, link, matchFrame, parseWitness, rankFrames, sameFrame, signFrame, verifyWitness } from './public/witness.js';

const W = 640, H = 360;
const rng = (seed) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
// A synthetic "screen": a gradient backdrop and a 3×2 grid of panels (windows, slides, cells) of
// varying brightness, each with rows of text-like bars; `edit` changes one text line.
function screen(seed, edit = false) {
  const r = rng(seed), data = new Uint8Array(W * H), across = r() < 0.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = 30 + ((across ? x / W : y / H) * 90);
  const rect = (x, y, w, h, v) => { for (let j = y; j < Math.min(H, y + h); j++) data.fill(v, j * W + x, j * W + Math.min(W, x + w)); };
  for (let k = 0; k < 6; k++) {
    if (r() < 0.25) continue; // some cells stay backdrop
    const x = (k % 3) * 213 + Math.floor(r() * 30), y = Math.floor(k / 3) * 180 + Math.floor(r() * 30), w = 120 + Math.floor(r() * 60), h = 90 + Math.floor(r() * 50);
    rect(x, y, w, h, 100 + r() * 150);
    for (let row = y + 10; row < y + h - 8; row += 14) rect(x + 8, row, Math.floor(r() * (w - 16)), 6, 20 + r() * 60);
  }
  if (edit) rect(40, 60, 90, 6, 250); // one line of text changed
  return { data, width: W, height: H };
}
// What a lossy video link does to it: 8×8 blocks pulled toward their mean, a soft blur, noise.
function codec({ data }, seed) {
  const r = rng(seed), out = Float32Array.from(data);
  for (let by = 0; by < H; by += 8) for (let bx = 0; bx < W; bx += 8) {
    let s = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) s += out[y * W + x];
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) out[y * W + x] = 0.6 * out[y * W + x] + 0.4 * (s / 64);
  }
  const blur = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (dx) => out[y * W + Math.min(W - 1, Math.max(0, x + dx))];
    blur[y * W + x] = Math.max(0, Math.min(255, (at(-1) + 2 * at(0) + at(1)) / 4 + (r() * 2 - 1) * 10));
  }
  return { data: blur, width: W, height: H };
}

// Unrelated natural-ish images (smooth value noise).
function photo(seed) {
  const r = rng(seed), g = 12, gw = Math.ceil(W / g) + 2, lat = Array.from({ length: gw * (Math.ceil(H / g) + 2) }, () => r() * 255), data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = Math.floor(x / g), j = Math.floor(y / g), u = x / g - i, v = y / g - j, at = (a, b) => lat[b * gw + a];
    data[y * W + x] = (1 - v) * ((1 - u) * at(i, j) + u * at(i + 1, j)) + v * ((1 - u) * at(i, j + 1) + u * at(i + 1, j + 1));
  }
  return { data, width: W, height: H };
}

// The benchmark: 30 synthetic UI screens (435 pairs) the thresholds were chosen on, and 60 held-out
// screens (1770 pairs) they were not. Every screen also goes through one and two passes of the codec.
const corpus = (from, n) => Array.from({ length: n }, (_, i) => screen(from + i));
const pairsOf = (ds) => ds.flatMap((a, i) => ds.slice(i + 1).map((b) => distance(a, b)));
const damage = [(s, i) => codec(s, i + 100), (s, i) => codec(codec(s, i + 200), i + 300)];

test('dual-band digest: one screen survives lossy video; different pictures stay apart', () => {
  assert.match(digest(screen(1)), /^[0-9a-f]{32}$/);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.deepEqual(distance('8000000000000001' + '0'.repeat(16), '0'.repeat(31) + '3'), { layout: 2, detail: 2 });
  const screens = corpus(1, 90), ds = screens.map(digest);
  const worst = { layout: 0, detail: 0 };
  for (const hit of damage) screens.forEach((s, i) => { const d = distance(ds[i], digest(hit(s, i))); worst.layout = Math.max(worst.layout, d.layout); worst.detail = Math.max(worst.detail, d.detail); });
  assert.ok(sameFrame(worst), `all 90 screens, through one and two codec passes, stay the same frame (worst ${JSON.stringify(worst)} vs ${JSON.stringify(WITNESS.match)})`);
  assert.ok(sameFrame(distance(ds[0], digest(screen(1, true)))), 'perceptual, not pixel-exact: one changed line of text is still the same frame');
  const photos = [1, 2, 3, 4].map((seed) => digest(photo(seed)));
  assert.ok(pairsOf(photos).every((d) => d.layout > 20 && !sameFrame(d)), `different images: ${JSON.stringify(pairsOf(photos))}`);
});

test('dual-band digest: look-alike UI screens — 12% → 0% on the benchmark; the held-out ceiling, pinned', () => {
  const tune = corpus(1, 30).map(digest), held = corpus(31, 60).map(digest);
  const layoutOnly = (ps) => ps.filter((d) => d.layout <= 10).length, both = (ps) => ps.filter(sameFrame).length; // ≤ 10: the 64-bit rule it replaces
  // Layout alone (the 64-bit dHash) mistakes 12% of these pairs for the same frame: box averages
  // dilute thin detail into a shared flat backdrop. The detail band separates them.
  assert.equal(layoutOnly(pairsOf(tune)), 51, '64-bit dHash alone: 51 of 435 look-alike pairs pass');
  assert.equal(both(pairsOf(tune)), 0, 'dual band: none of the 435 pairs pass');
  // On screens the thresholds never saw it is ~23× better, not perfect: at 128 bits some screens
  // really are look-alikes (same layout, same busy tiles). Pinned so it can only get better.
  const heldPairs = pairsOf(held);
  assert.equal(layoutOnly(heldPairs), 235, '64-bit dHash alone: 235 of 1770 held-out pairs pass');
  assert.ok(both(heldPairs) <= 10, `dual band: ${both(heldPairs)} of 1770 held-out pairs pass`);
});

test('witness chain: signed links verify; forged, re-ordered or re-keyed frames do not', async () => {
  const bo = await createIdentity(), eve = await createIdentity(), room = 'abc-defg-hij';
  const f1 = await signFrame(bo.privateKey, room, null, digest(screen(1)), 1_700_000_000_000);
  const f2 = await signFrame(bo.privateKey, room, f1, digest(screen(2)), 1_700_000_002_000);
  const f3 = await signFrame(bo.privateKey, room, f2, digest(screen(3)), 1_700_000_004_000);
  assert.equal(f1.prev, GENESIS);
  assert.equal(f2.prev, f1.chain);
  assert.equal(f2.chain, await link(f1.chain, 2, f2.digest, f2.t), 'chain = SHA-256(prev:seq:digest:t)');
  assert.equal(await checkFrame(bo.jwk, room, f1, null), 'ok');
  assert.equal(await checkFrame(bo.jwk, room, f2, f1), 'ok');
  assert.equal(await checkFrame(bo.jwk, room, f3, null), 'ok', 'joined mid-share: the chain is taken from there on');

  assert.equal(await checkFrame(bo.jwk, room, { ...f2, digest: f3.digest }, f1), 'bad link', 'swapped picture');
  const relinked = { ...f2, digest: f3.digest, chain: await link(f1.chain, 2, f3.digest, f2.t) };
  assert.equal(await checkFrame(bo.jwk, room, relinked, f1), 'bad signature', 'consistent link, but not Bo’s signature');
  assert.equal(await checkFrame(bo.jwk, room, f3, f1), 'broken chain', 'a frame went missing');
  assert.equal(await checkFrame(bo.jwk, room, f1, f2), 'broken chain', 'replayed');
  assert.equal(await checkFrame(bo.jwk, room, { ...f1, prev: f3.chain }, null), 'broken chain', 'frame #1 starts at genesis');
  assert.equal(await checkFrame(eve.jwk, room, f2, f1), 'bad signature', 'someone else’s key');
  assert.equal(await checkFrame(bo.jwk, 'other-room', f2, f1), 'bad signature', 'bound to the meeting');
  assert.equal(await checkFrame(bo.jwk, room, { ...f2, seq: '2' }, f1), 'malformed');
  assert.equal(await checkFrame(bo.jwk, room, { ...f2, digest: f2.digest.slice(0, 16) }, f1), 'malformed', 'a 64-bit (v1) digest');

  // Exported in the notes, verified offline, and a screenshot proven to match a signed frame.
  const witness = { version: 1, room, chains: [{ name: 'Bo', fingerprint: bo.fingerprint, jwk: bo.jwk, frames: [f1, f2, f3] }] };
  const notes = `NOTES\n${WITNESS_BEGIN}\n${JSON.stringify(witness, null, 2)}\n${WITNESS_END}\n`;
  const verified = await verifyWitness(parseWitness(notes));
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.chains[0].frames.map((f) => f.valid), [true, true, true]);
  const shot = digest(codec(screen(2), 99)); // a screenshot of what a viewer saw
  assert.deepEqual(matchFrame(verified, shot).map((m) => [m.name, m.seq]), [['Bo', 2]], 'proves which signed frame it shows');
  assert.deepEqual(matchFrame(verified, digest(photo(9))), [], 'an unrelated picture matches nothing');
  assert.equal(rankFrames(verified, digest(photo(9))).length, 3, 'but the closest frames are still ranked, for the verifier to explain');

  const tampered = structuredClone(witness);
  tampered.chains[0].frames[1].digest = f3.digest;
  const bad = await verifyWitness(tampered);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.chains[0].frames.map((f) => f.valid), [true, false, true], 'pinpoints the edited frame');
  assert.deepEqual(matchFrame(bad, f3.digest).map((m) => m.seq), [3], 'an edited frame proves nothing');
  const rekeyed = structuredClone(witness);
  rekeyed.chains[0].jwk = eve.jwk;
  assert.equal((await verifyWitness(rekeyed)).valid, false, 'key must match the fingerprint read aloud');
});
