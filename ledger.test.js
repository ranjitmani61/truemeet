import test from 'node:test';
import assert from 'node:assert/strict';
import { LEDGER_BEGIN, LEDGER_END, canonical, createIdentity, fingerprint, parseLedger, proposalPayload, publicJwk, sign, verify, verifyLedger } from './public/ledger.js';

test('canonical JSON is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(proposalPayload({ text: 'Ship', roomCode: 'r', timestamp: 5, proposalId: 'p', extra: 'ignored' }), '{"proposalId":"p","roomCode":"r","text":"Ship","timestamp":5}');
});

test('identity: P-256 public JWK only, stable fingerprint, private key not exportable', async () => {
  const id = await createIdentity();
  assert.deepEqual(Object.keys(id.jwk), ['crv', 'kty', 'x', 'y']);
  assert.equal(id.fingerprint, await fingerprint({ ...id.jwk, d: 'secret-should-be-ignored', ext: true }), 'fingerprint ignores extra fields');
  assert.match(id.fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(id.privateKey.extractable, false);
  assert.equal(publicJwk({ ...id.jwk, crv: 'P-384' }), null);
  assert.equal(publicJwk({ ...id.jwk, x: 'short' }), null);
});

test('signatures verify, and any tampering is rejected', async () => {
  const ada = await createIdentity(), bo = await createIdentity();
  const proposal = { proposalId: 'prop-1-abcdef', text: 'Ship v2 on Friday', timestamp: 1_760_000_000_000, roomCode: 'abc-defg-hij' };
  const sig = await sign(ada.privateKey, proposalPayload(proposal));
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/, '64-byte raw ECDSA signature, base64url');
  assert.equal(await verify(ada.jwk, proposalPayload(proposal), sig), true);
  assert.equal(await verify(ada.jwk, proposalPayload({ ...proposal, text: 'Ship v2 on Monday' }), sig), false, 'tampered text');
  assert.equal(await verify(ada.jwk, proposalPayload({ ...proposal, timestamp: proposal.timestamp + 1 }), sig), false, 'tampered timestamp');
  assert.equal(await verify(ada.jwk, proposalPayload({ ...proposal, roomCode: 'other-room' }), sig), false, 'replayed into another room');
  assert.equal(await verify(bo.jwk, proposalPayload(proposal), sig), false, 'wrong key');
  const flipped = (sig[10] === 'A' ? 'B' : 'A');
  assert.equal(await verify(ada.jwk, proposalPayload(proposal), sig.slice(0, 10) + flipped + sig.slice(11)), false, 'flipped signature byte');
  for (const bad of ['', 'x'.repeat(86) + '!', 42, null]) assert.equal(await verify(ada.jwk, proposalPayload(proposal), bad), false, 'malformed signature');
});

test('ledger export round-trips and detects tampering', async () => {
  const people = await Promise.all(['Ada', 'Bo'].map(async (name) => ({ name, id: await createIdentity() })));
  const proposal = { proposalId: 'prop-7-0a1b2c', text: 'Adopt the new pricing', timestamp: 1_760_000_123_456, roomCode: 'abc-defg-hij', proposer: 'Ada' };
  const signatures = await Promise.all(people.map(async ({ name, id }) => ({ name, fingerprint: id.fingerprint, jwk: id.jwk, sig: await sign(id.privateKey, proposalPayload(proposal)) })));
  const ledger = { version: 1, room: 'abc-defg-hij', proposals: [{ ...proposal, signatures }] };
  const notes = `NOTES\n${LEDGER_BEGIN}\n${JSON.stringify(ledger, null, 2)}\n${LEDGER_END}\n`;
  const parsed = parseLedger(notes);
  const ok = await verifyLedger(parsed);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.proposals[0].signatures.map((s) => [s.name, s.valid]), [['Ada', true], ['Bo', true]]);

  const edited = structuredClone(parsed);
  edited.proposals[0].text = 'Adopt the old pricing';
  assert.equal((await verifyLedger(edited)).valid, false, 'edited decision text');
  const swapped = structuredClone(parsed);
  swapped.proposals[0].signatures[1].jwk = people[0].id.jwk;
  assert.equal((await verifyLedger(swapped)).valid, false, 'key no longer matches its fingerprint');
  const forged = structuredClone(parsed);
  forged.proposals[0].signatures[1] = { ...forged.proposals[0].signatures[1], sig: forged.proposals[0].signatures[0].sig };
  assert.equal((await verifyLedger(forged)).valid, false, 'someone else’s signature');
  assert.equal(parseLedger('no ledger here'), null);
});
