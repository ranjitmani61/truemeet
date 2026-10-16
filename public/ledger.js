// Cryptographic Decision Ledger: WebCrypto only, so the exact same code runs in browsers and in the
// Node server (which verifies every signature before relaying it) and in an offline verifier.
// Each participant holds an ECDSA P-256 key whose private half never leaves the browser; its
// fingerprint is folded into the pairwise safety code, so reading the code aloud also proves the
// signaling server didn't substitute anyone's signing key.
const subtle = globalThis.crypto.subtle;
const KEY = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const enc = new TextEncoder();
const B64U_RE = /^[A-Za-z0-9_-]+$/;
export const LEDGER_BEGIN = '-----BEGIN TRUEMEET LEDGER-----';
export const LEDGER_END = '-----END TRUEMEET LEDGER-----';

export const b64u = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)),
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Deterministic JSON: object keys sorted at every level, no whitespace.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// The only public-key shape we accept: an uncompressed P-256 point as a minimal JWK.
export function publicJwk(jwk) {
  const ok = jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && [jwk.x, jwk.y].every((c) => typeof c === 'string' && c.length === 43 && B64U_RE.test(c));
  return ok ? { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } : null;
}
export async function fingerprint(jwk) {
  return hex(await subtle.digest('SHA-256', enc.encode(canonical(publicJwk(jwk))))).slice(0, 32);
}
export async function createIdentity() {
  const keys = await subtle.generateKey(KEY, false, ['sign', 'verify']); // private key is non-extractable
  const jwk = publicJwk(await subtle.exportKey('jwk', keys.publicKey));
  return { privateKey: keys.privateKey, jwk, fingerprint: await fingerprint(jwk) };
}

export const proposalPayload = ({ proposalId, text, timestamp, roomCode }) => canonical({ proposalId, roomCode, text, timestamp });

export async function sign(privateKey, payload) {
  return b64u.encode(new Uint8Array(await subtle.sign(SIGN, privateKey, enc.encode(payload))));
}
export async function verify(jwk, payload, sig) {
  try {
    const pub = publicJwk(jwk);
    if (!pub || typeof sig !== 'string' || sig.length !== 86 || !B64U_RE.test(sig)) return false;
    const key = await subtle.importKey('jwk', pub, KEY, false, ['verify']);
    return await subtle.verify(SIGN, key, b64u.decode(sig), enc.encode(payload));
  } catch {
    return false;
  }
}

// Ledger = { version, room, proposals: [{ proposalId, text, timestamp, roomCode, proposer, signatures: [{ name, fingerprint, jwk, sig }] }] }
// Valid only if every signature verifies against the canonical payload AND its key matches its fingerprint.
export async function verifyLedger(ledger) {
  const proposals = await Promise.all((ledger?.proposals ?? []).map(async (p) => ({
    proposalId: p.proposalId,
    signatures: await Promise.all((p.signatures ?? []).map(async (s) => ({
      name: s.name,
      fingerprint: s.fingerprint,
      valid: publicJwk(s.jwk) !== null && (await fingerprint(s.jwk)) === s.fingerprint && (await verify(s.jwk, proposalPayload(p), s.sig)),
    }))),
  })));
  return { valid: proposals.length > 0 && proposals.every((p) => p.signatures.every((s) => s.valid)), proposals };
}
export function parseLedger(notes) {
  const a = notes.indexOf(LEDGER_BEGIN), b = notes.indexOf(LEDGER_END);
  return a < 0 || b < a ? null : JSON.parse(notes.slice(a + LEDGER_BEGIN.length, b));
}
