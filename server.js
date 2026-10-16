// TrueMeet server: static files + WebRTC signaling over Server-Sent Events. Zero dependencies.
// The server never sees media. It relays signaling, and owns the few facts that need one
// authority: who is host, who may enter, pin numbers, and a bounded catch-up buffer per room.
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFile, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fingerprint, proposalPayload, publicJwk, verify } from './public/ledger.js';

const PUBLIC = join(import.meta.dirname, 'public');
const ROOM_RE = /^[a-z0-9-]{3,40}$/;
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const NID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PEER_RE = /^[0-9a-f-]{36}$/;
const PROPOSAL_RE = /^prop-\d{1,6}-[0-9a-f]{6}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/; // raw 64-byte ECDSA P-256 signature, base64url
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/; // never SVG: no scriptable images
const SURFACE_RE = /^(board|share:[0-9a-f-]{36})$/;
const COLOR_RE = /^(#[0-9a-f]{6}|hsl\(\d{1,3} \d{1,3}% \d{1,3}%\))$/i;
const EMOJI = new Set(['👏', '❤️', '😂', '😮', '🎉', '👍']);
const REASONS = new Set(['action item', 'deadline', 'decision', 'next step', 'todo', 'agreed', 'follow-up', 'reactions', 'crosstalk']);
const MAX_PEERS = 8; // ponytail: full-mesh WebRTC tops out around 8 people; put an SFU (LiveKit/mediasoup) behind this for bigger rooms
const MAX_LOBBY = 20;
const MAX_BODY = 256 * 1024;
const MAX_PINS = 200; // per surface
const MAX_CAPTIONS = 40;
const MAX_HIGHLIGHTS = 200;
const MAX_PROPOSALS = 50;
const MAX_IMAGE = 200_000; // data-URL chars for a beamed frame or a snip card
const TARGETED = new Set(['beam-snapshot', 'whisper']); // strictly one-to-one: never broadcast
const SPEAK_GAP_MS = 2500; // "Speak to room": at most one synthesized reply per person every 2.5 s
const CATCHUP_AFTER_MS = 30_000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const ICE = {
  iceServers: [
    { urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' },
    ...(process.env.TURN_URL ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : []),
  ],
};

export const rooms = new Map();

const write = (peer, msg) => peer.res.writableEnded || peer.res.write(`data: ${JSON.stringify(msg)}\n\n`);
const broadcast = (room, msg, except) => { for (const p of room.peers.values()) if (p !== except) write(p, msg); };
const toHost = (room, msg) => { const h = room.peers.get(room.host); if (h) write(h, msg); };
const pub = ({ id, name, state, jwk }) => ({ id, name, state, jwk });
const keyOk = (peer, key) => { const a = Buffer.from(String(key)), b = Buffer.from(peer.key); return a.length === b.length && timingSafeEqual(a, b); };
const done = (res, code, data) => { res.writeHead(code, data ? { 'content-type': 'application/json' } : {}); res.end(data && JSON.stringify(data)); };

// ---------- Payload schemas: rebuild every relayed message from allowed fields only ----------
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max).trim() : undefined); // trim first: whitespace never eats the budget
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);
const nid = (v) => (typeof v === 'string' && NID_RE.test(v) ? v : undefined);
const lang = (v) => (typeof v === 'string' && LANG_RE.test(v) ? v : '');
const flags = (s) => ({
  mic: !!s?.mic, cam: !!s?.cam, hand: !!s?.hand, screen: !!s?.screen, rec: !!s?.rec, ink: !!s?.ink, auto: !!s?.auto, lang: lang(s?.lang),
});
const desc = (d) => (['offer', 'answer'].includes(d?.type) && typeof d.sdp === 'string' && d.sdp.length < 200_000 ? { type: d.type, sdp: d.sdp } : undefined);
const candidate = (c) => typeof c?.candidate === 'string' && c.candidate.length < 2000 ? {
  candidate: c.candidate,
  sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
  sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null,
  usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
} : undefined;
const points = (a) => (Array.isArray(a) && a.length >= 2 && a.length <= 4000 && a.every((v) => typeof v === 'number' && Number.isFinite(v)) ? a.slice(0, a.length & ~1).map(unit) : undefined);
const stroke = (m) => {
  const sid = nid(m?.sid), pts = points(m?.pts);
  return sid && pts && ['pen', 'laser'].includes(m.tool) && COLOR_RE.test(m.color) ? { sid, tool: m.tool, color: m.color, pts } : undefined;
};
const image = (v) => (typeof v === 'string' && v.length <= MAX_IMAGE && IMAGE_RE.test(v) ? v : undefined);
const overlayStroke = (m) => { const pts = points(m?.pts); return pts && pts.length <= 1000 && ['pen', 'laser'].includes(m.tool) && COLOR_RE.test(m.color) ? { tool: m.tool, color: m.color, pts } : undefined; };
const overlayPin = (m) => {
  const x = unit(m?.x), y = unit(m?.y);
  if (!Number.isInteger(m?.n) || m.n < 1 || m.n > 999 || x === undefined || y === undefined || (m.note !== undefined && typeof m.note !== 'string')) return;
  return { n: m.n, x, y, note: str(m.note, 140) ?? '', color: COLOR_RE.test(m.color) ? m.color : '#a78bfa' };
};
const list = (v, max, item) => { // every element must be valid, or the whole list is rejected
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return;
  const out = v.map(item);
  return out.every(Boolean) ? out : undefined;
};
const inkOp = (m) => {
  const s = typeof m.s === 'string' && SURFACE_RE.test(m.s) ? m.s : undefined;
  if (!s) return;
  switch (m.op) {
    case 'pts': { const st = stroke(m); return st && { s, op: 'pts', ...st }; }
    case 'undo': { const sid = nid(m.sid); return sid && { s, op: 'undo', sid }; }
    case 'clear': return { s, op: 'clear', all: !!m.all };
    case 'sync': {
      if (s !== 'board' || !Array.isArray(m.strokes) || m.strokes.length > 1000) return;
      return { s, op: 'sync', strokes: m.strokes.flatMap((x) => { const st = stroke(x); return st && typeof x.by === 'string' && x.by.length <= 40 ? [{ ...st, by: x.by }] : []; }) };
    }
    case 'pin': {
      const pid = nid(m.pid), x = unit(m.x), y = unit(m.y);
      if (!pid || x === undefined || y === undefined || (m.note !== undefined && typeof m.note !== 'string')) return;
      return { s, op: 'pin', pid, x, y, note: str(m.note, 140) ?? '', color: COLOR_RE.test(m.color) ? m.color : '#a78bfa' };
    }
    case 'resolve': { const pid = nid(m.pid); return pid && { s, op: 'resolve', pid }; }
    case 'card': { // a snipped screen region placed on the whiteboard
      const cid = nid(m.cid), img = image(m.image), [x, y, w, h] = [m.x, m.y, m.w, m.h].map(unit);
      if (s !== 'board' || !cid || !img || [x, y, w, h].includes(undefined) || w < 0.02 || h < 0.02 || (m.caption !== undefined && typeof m.caption !== 'string')) return;
      return { s, op: 'card', cid, image: img, x, y, w, h, caption: str(m.caption, 80) ?? '' };
    }
  }
};
const SCHEMA = {
  offer: (m) => { const sdp = desc(m.sdp); return sdp && { sdp }; },
  answer: (m) => { const sdp = desc(m.sdp); return sdp && { sdp }; },
  ice: (m) => { const c = candidate(m.candidate); return c && { candidate: c }; },
  state: (m) => ({ state: flags(m.state) }),
  chat: (m) => { const text = str(m.text, 2000); return text ? { text } : undefined; },
  reaction: (m) => (EMOJI.has(m.emoji) ? { emoji: m.emoji } : undefined),
  caption: (m) => { const text = str(m.text, 500); return text ? { text, final: !!m.final, lang: lang(m.lang), nid: nid(m.nid) } : undefined; },
  mark: (m) => {
    if (m.auto && !REASONS.has(m.reason)) return;
    if (m.context !== undefined && typeof m.context !== 'string') return;
    return { context: str(m.context, 200) ?? '', auto: !!m.auto, reason: m.auto ? m.reason : undefined, nid: nid(m.nid) };
  },
  ink: inkOp,
  // A rewound frame + the viewer's marks on it, for the presenter only.
  'beam-snapshot': (m) => {
    const img = image(m.image), strokes = list(m.strokes, 100, overlayStroke), pins = list(m.pins, 30, overlayPin);
    if (!img || !strokes || !pins || !Number.isInteger(m.ago) || m.ago < 0 || m.ago > 600) return;
    return { image: img, ago: m.ago, strokes, pins };
  },
  whisper: (m) => (typeof m.on === 'boolean' ? { on: m.on } : undefined),
  'turn-queue': (m) => (Array.isArray(m.order) && m.order.length >= 2 && m.order.length <= MAX_PEERS && m.order.every((id) => typeof id === 'string' && PEER_RE.test(id)) && new Set(m.order).size === m.order.length ? { order: [...m.order] } : undefined),
  identity: (m) => { const jwk = publicJwk(m.jwk); return jwk ? { jwk } : undefined; },
  proposal: (m) => { const text = str(m.text, 280); return text ? { text } : undefined; },
  // A reply the sender wants every other browser to speak aloud (and show) in the given language.
  'speak-reply': (m) => { const text = str(m.text, 280), l = lang(m.lang); return text && l ? { text, lang: l } : undefined; },
  'proposal-sign': (m) => (typeof m.proposalId === 'string' && PROPOSAL_RE.test(m.proposalId) && typeof m.sig === 'string' && SIG_RE.test(m.sig) ? { proposalId: m.proposalId, sig: m.sig } : undefined),
};

// ---------- Rooms ----------
function events(res, url) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const fail = (reason) => res.end(`data: ${JSON.stringify({ type: 'error', reason })}\n\n`);
  const roomId = url.searchParams.get('room') ?? '';
  if (!ROOM_RE.test(roomId)) return fail('That meeting code is not valid.');
  const room = rooms.get(roomId) ?? {
    id: roomId, peers: new Map(), lobby: new Map(), host: null, locked: false, waiting: false,
    started: null, pins: new Map(), captions: [], highlights: [], proposals: new Map(), seq: 0,
  };
  if (room.locked) return fail('The host has locked this meeting.');
  if (room.peers.size >= MAX_PEERS) return fail(`This meeting is full (${MAX_PEERS} people max).`);
  if (room.lobby.size >= MAX_LOBBY) return fail('Too many people are waiting to join. Try again shortly.');
  rooms.set(roomId, room);

  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 40) || 'Guest';
  const peer = { id: randomUUID(), key: randomBytes(16).toString('hex'), name, state: flags(), res };
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    if (room.lobby.delete(peer.id)) { toHost(room, { type: 'knock-cancel', id: peer.id }); dropIfEmpty(room); } else leave(room, peer);
  });

  if (room.waiting && room.peers.size) { // waiting room: the host decides
    room.lobby.set(peer.id, peer);
    write(peer, { type: 'waiting' });
    toHost(room, { type: 'knock', peer: pub(peer) });
  } else admit(room, peer, false);
}

function admit(room, peer, fromLobby) {
  const now = Date.now();
  room.started ??= now;
  broadcast(room, { type: 'join', peer: pub(peer) });
  const others = [...room.peers.values()].map(pub);
  room.peers.set(peer.id, peer);
  room.host ??= peer.id;
  write(peer, { type: 'welcome', id: peer.id, key: peer.key, host: room.host, locked: room.locked, waiting: room.waiting, started: room.started, now, peers: others });
  const pins = [...room.pins.values()].flatMap((surface) => [...surface.items.values()]);
  if (pins.length) write(peer, { type: 'pins', pins });
  if (room.proposals.size) write(peer, { type: 'ledger', proposals: [...room.proposals.values()].map(ledgerEntry) });
  if (fromLobby || now - room.started > CATCHUP_AFTER_MS) { // time-travel catch-up for late joiners
    write(peer, { type: 'catchup', now, started: room.started, highlights: room.highlights.slice(-20), captions: room.captions.slice(-12), openPins: pins.filter((p) => !p.resolved).length });
  }
  if (room.host === peer.id) for (const p of room.lobby.values()) write(peer, { type: 'knock', peer: pub(p) });
}

function leave(room, peer) {
  if (room.peers.get(peer.id) !== peer) return;
  room.peers.delete(peer.id);
  room.pins.get(`share:${peer.id}`)?.items.clear();
  broadcast(room, { type: 'leave', from: peer.id });
  if (!room.peers.size) {
    room.host = null;
    const next = room.lobby.values().next().value; // nobody left to admit people: let the longest waiter in as host
    if (next) { room.lobby.delete(next.id); admit(room, next, true); }
    return dropIfEmpty(room);
  }
  if (room.host === peer.id) {
    room.host = room.peers.keys().next().value; // longest-present participant inherits host
    broadcast(room, { type: 'host', id: room.host });
    for (const p of room.lobby.values()) toHost(room, { type: 'knock', peer: pub(p) });
  }
}

const ledgerEntry = ({ proposalId, text, timestamp, roomCode, proposer, signatures }) => ({ proposalId, text, timestamp, roomCode, proposer, signatures: [...signatures.values()] });

// Decision ledger: the server is the notary that refuses forged signatures; clients verify again.
async function ledgerOp(room, peer, type, clean) {
  if (type === 'identity') {
    if (peer.jwk && peer.fp !== (await fingerprint(clean.jwk))) return 409; // keys don't change mid-meeting
    peer.jwk = clean.jwk;
    peer.fp = await fingerprint(clean.jwk);
    broadcast(room, { type, from: peer.id, name: peer.name, jwk: clean.jwk }, peer);
    return 204;
  }
  if (type === 'proposal') {
    if (room.proposals.size >= MAX_PROPOSALS) return 429;
    const proposalId = `prop-${++room.seq}-${randomBytes(3).toString('hex')}`;
    const prop = { proposalId, text: clean.text, timestamp: Date.now(), roomCode: room.id, by: peer.id, proposer: peer.name, signatures: new Map() };
    room.proposals.set(proposalId, prop);
    broadcast(room, { type, from: peer.id, name: peer.name, proposalId, text: prop.text, timestamp: prop.timestamp, roomCode: prop.roomCode });
    return 204;
  }
  const prop = room.proposals.get(clean.proposalId);
  if (!prop) return 404;
  if (!peer.jwk) return 409; // no published key, nothing to verify against
  if (prop.signatures.has(peer.id)) return 409;
  if (!(await verify(peer.jwk, proposalPayload(prop), clean.sig))) return 400; // forged or for different words
  const entry = { name: peer.name, fingerprint: peer.fp, jwk: peer.jwk, sig: clean.sig };
  prop.signatures.set(peer.id, entry);
  broadcast(room, { type: 'proposal-signed', from: peer.id, proposalId: prop.proposalId, ...entry });
  return 204;
}

const dropIfEmpty = (room) => { if (!room.peers.size && !room.lobby.size && rooms.get(room.id) === room) rooms.delete(room.id); };
const push = (list, item, max) => { list.push(item); if (list.length > max) list.shift(); };

// Pins are numbered and timestamped here, so every participant sees the same "#3" in the same order.
function pinOp(room, peer, op) {
  let surface = room.pins.get(op.s);
  if (op.op === 'pin') {
    if (!surface) room.pins.set(op.s, (surface = { next: 1, items: new Map() }));
    if (surface.items.has(op.pid)) return 409;
    if (surface.items.size >= MAX_PINS) return 429;
    const pin = { ...op, n: surface.next++, by: peer.id, name: peer.name, t: Date.now(), resolved: false };
    surface.items.set(op.pid, pin);
    broadcast(room, { type: 'ink', from: peer.id, ...pin }); // echoed to the author too: authoritative number + time
    return 204;
  }
  const pin = surface?.items.get(op.pid);
  if (!pin) return 404;
  const sharer = op.s.startsWith('share:') && op.s.slice(6) === peer.id;
  if (pin.by !== peer.id && !sharer && !(op.s === 'board' && room.host === peer.id)) return 403;
  if (!pin.resolved) {
    Object.assign(pin, { resolved: true, resolvedBy: peer.name });
    broadcast(room, { type: 'ink', from: peer.id, name: peer.name, s: op.s, op: 'resolve', pid: op.pid });
  }
  return 204;
}

function inkAllowed(room, peer, op) {
  if (op.s === 'board') return op.op !== 'sync' || room.host === peer.id; // only the host seeds late joiners
  const owner = op.s.slice(6);
  if (owner === peer.id) return true;
  const sharer = room.peers.get(owner);
  if (op.op === 'clear' && op.all) return false; // only the sharer wipes everyone's marks
  return op.op === 'resolve' || !!(sharer?.state.screen && sharer.state.ink); // annotation only while the sharer allows it
}

const body = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});

async function signal(req, res) {
  let msg;
  try { msg = JSON.parse(await body(req)); } catch { return done(res, 400); }
  const room = rooms.get(msg?.room);
  const peer = room?.peers.get(msg.id);
  if (!peer || !keyOk(peer, msg.key)) return done(res, 403);
  const { type } = msg;

  if (Object.hasOwn(SCHEMA, type)) {
    const clean = SCHEMA[type](msg);
    if (!clean) return done(res, 400);
    const out = { type, from: peer.id, name: peer.name, ...clean }; // the server, not the client, says who sent it

    if (type === 'state') {
      if (peer.state.screen && !clean.state.screen) room.pins.get(`share:${peer.id}`)?.items.clear(); // share ended
      peer.state = clean.state;
    } else if (type === 'caption' && clean.final) {
      push(room.captions, { nid: clean.nid, name: peer.name, text: clean.text, t: Date.now() }, MAX_CAPTIONS);
    } else if (type === 'mark') {
      push(room.highlights, { nid: clean.nid, name: peer.name, context: clean.context, auto: clean.auto, reason: clean.reason, t: Date.now() }, MAX_HIGHLIGHTS);
    } else if (type === 'ink') {
      if (!inkAllowed(room, peer, clean)) return done(res, 403);
      if (clean.op === 'pin' || clean.op === 'resolve') return done(res, pinOp(room, peer, clean));
      if (clean.op === 'clear' && clean.all) room.pins.get(clean.s)?.items.clear();
    } else if (type === 'identity' || type === 'proposal' || type === 'proposal-sign') {
      return done(res, await ledgerOp(room, peer, type, clean));
    } else if (type === 'speak-reply') { // always for the whole room: a `to` field is ignored
      if (Date.now() - (peer.spokeAt ?? 0) < SPEAK_GAP_MS) return done(res, 429);
      peer.spokeAt = Date.now();
      broadcast(room, out, peer);
      return done(res, 204);
    } else if (type === 'turn-queue') {
      if (!peer.state.auto) return done(res, 403); // only an Auto-Mode director suggests turn order
      if (!clean.order.every((id) => room.peers.has(id))) return done(res, 400);
    }

    const target = typeof msg.to === 'string' ? room.peers.get(msg.to) : null;
    if (TARGETED.has(type)) { // whispers and beams go to exactly one other participant
      if (!target || target === peer) return done(res, 400);
      write(target, out);
      return done(res, 204);
    }
    if (msg.to !== undefined) { if (target) write(target, out); } else broadcast(room, out, peer);
    return done(res, 204);
  }

  if (room.host !== peer.id) return done(res, 403);
  const target = room.peers.get(msg.target) ?? room.lobby.get(msg.target);
  switch (type) {
    case 'lock':
      room.locked = !!msg.locked;
      broadcast(room, { type: 'locked', locked: room.locked });
      break;
    case 'waiting':
      room.waiting = !!msg.on;
      broadcast(room, { type: 'waiting-room', on: room.waiting });
      if (!room.waiting) {
        for (const p of [...room.lobby.values()]) {
          room.lobby.delete(p.id);
          if (room.peers.size < MAX_PEERS) admit(room, p, true);
          else { write(p, { type: 'error', reason: `This meeting is full (${MAX_PEERS} people max).` }); p.res.end(); }
        }
      }
      break;
    case 'admit':
      if (!target || !room.lobby.has(target.id)) return done(res, 404);
      if (room.peers.size >= MAX_PEERS) return done(res, 409);
      room.lobby.delete(target.id);
      admit(room, target, true);
      break;
    case 'deny':
      if (!target || !room.lobby.delete(target.id)) return done(res, 404);
      write(target, { type: 'error', reason: 'The host didn’t let you in this time.' });
      target.res.end();
      break;
    case 'mute-all':
      broadcast(room, { type: 'mute-all', name: peer.name }, peer);
      break;
    case 'nudge': // the host invites someone who tried to jump in
      if (!target || target === peer || !room.peers.has(target.id)) return done(res, 404);
      write(target, { type: 'nudge', name: peer.name });
      break;
    case 'kick':
      if (!target || target === peer || !room.peers.has(target.id)) return done(res, 404);
      write(target, { type: 'kicked' });
      target.res.end();
      leave(room, target);
      break;
    default:
      return done(res, 400);
  }
  done(res, 204);
}

function serve(res, pathname) {
  const file = extname(pathname) ? join(PUBLIC, normalize(pathname)) : join(PUBLIC, 'index.html'); // extensionless paths are meeting links
  if (!file.startsWith(PUBLIC + sep)) return done(res, 404);
  readFile(file, (err, data) => {
    if (err) return done(res, 404);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}

export function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/events') return events(res, url);
  if (req.method === 'POST' && url.pathname === '/api/signal') return signal(req, res);
  if (req.method === 'GET' && url.pathname === '/config') return done(res, 200, ICE);
  if (req.method === 'GET') return serve(res, url.pathname);
  done(res, 405);
}

const tls = process.env.TLS_CERT && { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) };
export const server = tls ? createTlsServer(tls, handler) : createServer(handler);

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${port} is already in use by another app. Start TrueMeet on a free port, e.g.:\n  PORT=${port + 100} npm start`);
    process.exit(1);
  });
  server.listen(port, () => console.log(`TrueMeet ready on ${tls ? 'https' : 'http'}://localhost:${port}`));
}
