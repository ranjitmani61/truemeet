// Proof-of-Frame: a signed, hash-chained perceptual witness of a shared screen.
// Every ~2 s while sharing, the presenter's browser digests the frame it is sending (128-bit
// dual-band perceptual digest, below), links it to the previous one
// (chain = SHA-256(prev:seq:digest:t)) and signs the link with the same non-extractable ECDSA
// P-256 key as the decision ledger — the key folded into the safety code. Each viewer checks the
// signature and the chain, then digests the frame its own decoder produced: close on both bands
// means "what I see is what they signed". The exported chain lets anyone prove later, offline,
// that a screenshot matches a signed frame (verify.html).
// WebCrypto only: the same code runs in browsers, in the server (which refuses forged or broken
// links) and in the offline verifier.
import { canonical, fingerprint, publicJwk, sign, verify } from './ledger.js';

export const WITNESS = {
  intervalMs: 2000, // one signed frame every 2 s per share
  sampleMs: 150, // viewers hash what they display this often…
  window: [-400, 2200], // …and match a signed frame against what they showed in [t-0.4 s, t+2.2 s]
  match: { layout: 7, detail: 8 }, // max differing bits per 64-bit band for "same frame" (measured: witness.test.js, e2e/deep-tech.mjs)
  read: [144, 128], // every digest is computed on 144×128 luma
  floor: 8, // tile edge energy (mean |∂x|+|∂y|, luma levels) below this is flat: codec noise must never set a detail bit
};
export const GENESIS = '0'.repeat(64); // `prev` of frame #1
export const WITNESS_BEGIN = '-----BEGIN TRUEMEET WITNESS-----';
export const WITNESS_END = '-----END TRUEMEET WITNESS-----';
export const HASH_RE = /^[0-9a-f]{64}$/;
export const DIGEST_RE = /^[0-9a-f]{32}$/;
const enc = new TextEncoder();

// Area-average any luma frame {data, width, height} to exactly w×h of 8-bit levels, like the
// browser's canvas readback (identity at that size).
export function resample({ data, width: W, height: H }, w = WITNESS.read[0], h = WITNESS.read[1]) {
  if (W === w && H === h) return { data, width: w, height: h };
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = (y * H) / h, y1 = ((y + 1) * H) / h;
    for (let x = 0; x < w; x++) {
      const x0 = (x * W) / w, x1 = ((x + 1) * W) / w;
      let s = 0, a = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) { const k = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy; s += data[yy * W + xx] * k; a += k; }
      }
      out[y * w + x] = s / a;
    }
  }
  return { data: out, width: w, height: h };
}

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

const hex64 = (bits) => bits.reduce((v, b) => (v << 1n) | (b ? 1n : 0n), 0n).toString(16).padStart(16, '0');

// Band 1, layout: 64-bit difference hash of 9×8 cells. Bit = "this cell is brighter than its
// right neighbour", row-major, most significant first, as 16 hex digits.
export function dHash(c) {
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(c[y * 9 + x] > c[y * 9 + x + 1]);
  return hex64(bits);
}

// Mean high-frequency energy |I(x+1,y) − I(x,y)| + |I(x,y+1) − I(x,y)| of each tile of a gw×gh grid:
// ~0 on flat background, high wherever text, borders or controls are.
export function edgeEnergy({ data, width: w, height: h }, gw = 8, gh = 8) {
  const out = new Float32Array(gw * gh);
  for (let ty = 0; ty < gh; ty++) {
    const y0 = Math.floor((ty * h) / gh), y1 = Math.floor(((ty + 1) * h) / gh);
    for (let tx = 0; tx < gw; tx++) {
      const x0 = Math.floor((tx * w) / gw), x1 = Math.floor(((tx + 1) * w) / gw);
      let s = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = y * w + x0; x < x1; x++, i++) s += (x + 1 < w ? Math.abs(data[i + 1] - data[i]) : 0) + (y + 1 < h ? Math.abs(data[i + w] - data[i]) : 0);
      }
      out[ty * gw + tx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// Band 2, detail: bit = "this tile holds more detail than the median non-empty tile". Box
// averages dilute thin UI detail into the backdrop; edge energy doesn't, so screens that share a
// flat backdrop and a layout still differ here. Flat tiles are always 0.
export function eHash(energy, floor = WITNESS.floor) {
  const busy = [...energy].filter((e) => e > floor).sort((a, b) => a - b);
  const cut = busy.length ? busy[busy.length >> 1] : Infinity;
  return hex64([...energy].map((e) => e > cut));
}

// The 128-bit dual-band digest of a frame, as 32 hex digits: dHash (layout) then eHash (detail).
export function digest(luma) {
  const l = resample(luma);
  return dHash(cells(l)) + eHash(edgeEnergy(l));
}

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  for (; x; n++) x &= x - 1n;
  return n;
}
// Differing bits per band, and whether two digests show the same frame (both bands close).
export const distance = (a, b) => ({ layout: hamming(a.slice(0, 16), b.slice(0, 16)), detail: hamming(a.slice(16), b.slice(16)) });
export const sameFrame = (d) => d.layout <= WITNESS.match.layout && d.detail <= WITNESS.match.detail;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const link = async (prev, seq, dig, t) => hex(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`${prev}:${seq}:${dig}:${t}`)));
// What is signed: the link plus everything it commits to, bound to the meeting.
export const witnessPayload = ({ room, seq, t, digest: dig, prev, chain }) => canonical({ chain, digest: dig, prev, room, seq, t });

// The next signed frame after `last` ({seq, chain}, or null to start a chain).
export async function signFrame(privateKey, room, last, dig, t) {
  const seq = (last?.seq ?? 0) + 1, prev = last?.chain ?? GENESIS, chain = await link(prev, seq, dig, t);
  return { seq, t, digest: dig, prev, chain, sig: await sign(privateKey, witnessPayload({ room, seq, t, digest: dig, prev, chain })) };
}

export const frameShape = (f) => Number.isSafeInteger(f?.seq) && f.seq >= 1 && Number.isSafeInteger(f.t) && f.t > 0
  && [f.prev, f.chain].every((h) => typeof h === 'string' && HASH_RE.test(h)) && typeof f.digest === 'string' && DIGEST_RE.test(f.digest) && typeof f.sig === 'string';

// Check one received frame against the signer's key and the last frame accepted from the same
// chain ({seq, chain}, or null if this is the first one we see). 'ok', or why it fails.
// A chain seen from its start must begin at GENESIS; one joined mid-way is taken from there on.
export async function checkFrame(jwk, room, f, last) {
  if (!frameShape(f)) return 'malformed';
  if (last ? f.seq !== last.seq + 1 || f.prev !== last.chain : f.seq === 1 && f.prev !== GENESIS) return 'broken chain';
  if ((await link(f.prev, f.seq, f.digest, f.t)) !== f.chain) return 'bad link';
  return (await verify(jwk, witnessPayload({ room, ...f }), f.sig)) ? 'ok' : 'bad signature';
}

// Witness = { version: 2, room, chains: [{ name, fingerprint, jwk, frames: [{ seq, t, digest, prev, chain, sig, … }] }] }
// (Version 1, with 64-bit dHash-only frames, was never released; it no longer verifies.)
// Valid only if every chain's key matches its fingerprint and every frame links and verifies.
export async function verifyWitness(w) {
  const chains = await Promise.all((w?.chains ?? []).map(async (c) => {
    const keyOk = publicJwk(c.jwk) !== null && (await fingerprint(c.jwk)) === c.fingerprint;
    const frames = [];
    let last = null;
    for (const f of c.frames ?? []) {
      const ok = keyOk && (await checkFrame(c.jwk, w.room, f, last)) === 'ok';
      frames.push({ seq: f.seq, t: f.t, digest: f.digest, valid: ok });
      last = { seq: f.seq, chain: f.chain };
    }
    return { name: c.name, fingerprint: c.fingerprint, frames };
  }));
  return { valid: chains.length > 0 && chains.every((c) => c.frames.length > 0 && c.frames.every((f) => f.valid)), chains };
}

// Valid signed frames ranked by closeness to a picture's digest; `match` says whether each one
// counts as the same frame.
export function rankFrames(verified, dig) {
  return verified.chains.flatMap((c) => c.frames.filter((f) => f.valid).map((f) => {
    const d = distance(f.digest, dig);
    return { name: c.name, fingerprint: c.fingerprint, seq: f.seq, t: f.t, ...d, match: sameFrame(d) };
  })).sort((a, b) => b.match - a.match || a.layout + a.detail - (b.layout + b.detail) || b.seq - a.seq);
}
export const matchFrame = (verified, dig) => rankFrames(verified, dig).filter((m) => m.match);

export function parseWitness(notes) {
  const a = notes.indexOf(WITNESS_BEGIN), b = notes.indexOf(WITNESS_END);
  return a < 0 || b < a ? null : JSON.parse(notes.slice(a + WITNESS_BEGIN.length, b));
}
