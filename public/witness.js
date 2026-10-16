// Proof-of-Frame: a signed, hash-chained perceptual witness of a shared screen.
// Every ~2 s while sharing, the presenter's browser hashes the frame it is sending (64-bit dHash),
// links it to the previous one (chain = SHA-256(prev:seq:dHash:t)) and signs the link with the
// same non-extractable ECDSA P-256 key as the decision ledger — the key folded into the safety
// code. Each viewer checks the signature and the chain, then hashes the frame its own decoder
// produced: within 10 of 64 bits means "what I see is what they signed". The exported chain
// lets anyone prove later, offline, that a screenshot matches a signed frame (verify.html).
// WebCrypto only: the same code runs in browsers, in the server (which refuses forged or broken
// links) and in the offline verifier.
import { canonical, fingerprint, publicJwk, sign, verify } from './ledger.js';

export const WITNESS = {
  intervalMs: 2000, // one signed frame every 2 s per share
  sampleMs: 150, // viewers hash what they display this often…
  window: [-400, 2200], // …and match a signed frame against what they showed in [t-0.4 s, t+2.2 s]
  match: 10, // max differing bits (of 64) for "same frame"
  read: [144, 128], // frames are resampled to 144×128 luma, then box-averaged into 9×8 cells
};
export const GENESIS = '0'.repeat(64); // `prev` of frame #1
export const WITNESS_BEGIN = '-----BEGIN TRUEMEET WITNESS-----';
export const WITNESS_END = '-----END TRUEMEET WITNESS-----';
export const HASH_RE = /^[0-9a-f]{64}$/;
export const DHASH_RE = /^[0-9a-f]{16}$/;
const enc = new TextEncoder();

// Box-average a luma frame {data, width, height} into gw×gh cells, rounded to whole levels so
// flat areas give identical cells on both ends of a lossy video link.
export function cells({ data, width: w, height: h }, gw = 9, gh = 8) {
  const out = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * h) / gh), y1 = Math.floor(((gy + 1) * h) / gh);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw), x1 = Math.floor(((gx + 1) * w) / gw);
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += data[y * w + x];
      out[gy * gw + gx] = Math.round(s / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

// 64-bit difference hash of 9×8 cells: bit = "this cell is brighter than its right neighbour",
// row-major, most significant first, as 16 hex digits.
export function dHash(c) {
  let v = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) v = (v << 1n) | (c[y * 9 + x] > c[y * 9 + x + 1] ? 1n : 0n);
  return v.toString(16).padStart(16, '0');
}
export const frameHash = (luma) => dHash(cells(luma));

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  for (; x; n++) x &= x - 1n;
  return n;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const link = async (prev, seq, dhash, t) => hex(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`${prev}:${seq}:${dhash}:${t}`)));
// What is signed: the link plus everything it commits to, bound to the meeting.
export const witnessPayload = ({ room, seq, t, dhash, prev, chain }) => canonical({ chain, dhash, prev, room, seq, t });

// The next signed frame after `last` ({seq, chain}, or null to start a chain).
export async function signFrame(privateKey, room, last, dhash, t) {
  const seq = (last?.seq ?? 0) + 1, prev = last?.chain ?? GENESIS, chain = await link(prev, seq, dhash, t);
  return { seq, t, dhash, prev, chain, sig: await sign(privateKey, witnessPayload({ room, seq, t, dhash, prev, chain })) };
}

export const frameShape = (f) => Number.isSafeInteger(f?.seq) && f.seq >= 1 && Number.isSafeInteger(f.t) && f.t > 0
  && [f.prev, f.chain].every((h) => typeof h === 'string' && HASH_RE.test(h)) && typeof f.dhash === 'string' && DHASH_RE.test(f.dhash) && typeof f.sig === 'string';

// Check one received frame against the signer's key and the last frame accepted from the same
// chain ({seq, chain}, or null if this is the first one we see). 'ok', or why it fails.
// A chain seen from its start must begin at GENESIS; one joined mid-way is taken from there on.
export async function checkFrame(jwk, room, f, last) {
  if (!frameShape(f)) return 'malformed';
  if (last ? f.seq !== last.seq + 1 || f.prev !== last.chain : f.seq === 1 && f.prev !== GENESIS) return 'broken chain';
  if ((await link(f.prev, f.seq, f.dhash, f.t)) !== f.chain) return 'bad link';
  return (await verify(jwk, witnessPayload({ room, ...f }), f.sig)) ? 'ok' : 'bad signature';
}

// Witness = { version, room, chains: [{ name, fingerprint, jwk, frames: [{ seq, t, dhash, prev, chain, sig, … }] }] }
// Valid only if every chain's key matches its fingerprint and every frame links and verifies.
export async function verifyWitness(w) {
  const chains = await Promise.all((w?.chains ?? []).map(async (c) => {
    const keyOk = publicJwk(c.jwk) !== null && (await fingerprint(c.jwk)) === c.fingerprint;
    const frames = [];
    let last = null;
    for (const f of c.frames ?? []) {
      const ok = keyOk && (await checkFrame(c.jwk, w.room, f, last)) === 'ok';
      frames.push({ seq: f.seq, t: f.t, dhash: f.dhash, valid: ok });
      last = { seq: f.seq, chain: f.chain };
    }
    return { name: c.name, fingerprint: c.fingerprint, frames };
  }));
  return { valid: chains.length > 0 && chains.every((c) => c.frames.length > 0 && c.frames.every((f) => f.valid)), chains };
}

// Signed frames a picture's dHash matches, closest first.
export function matchFrame(verified, hash, max = WITNESS.match) {
  return verified.chains.flatMap((c) => c.frames.filter((f) => f.valid).map((f) => ({ name: c.name, fingerprint: c.fingerprint, seq: f.seq, t: f.t, distance: hamming(f.dhash, hash) })))
    .filter((m) => m.distance <= max).sort((a, b) => a.distance - b.distance || b.seq - a.seq);
}

export function parseWitness(notes) {
  const a = notes.indexOf(WITNESS_BEGIN), b = notes.indexOf(WITNESS_END);
  return a < 0 || b < a ? null : JSON.parse(notes.slice(a + WITNESS_BEGIN.length, b));
}
