// TrueMeet client: lobby, WebRTC mesh, chat, captions + translation, recording, whiteboard,
// screen annotation + pins, highlights, Auto-Mode, catch-up, waiting room, safety codes, host controls,
// Screen Time Machine, lean-in whispers, signed decision ledger, polite turn engine, snip-to-board,
// living anchors (tracked pins), proposed moves, and the signed Proof-of-Frame witness.
import { apply as inkApply, bindPointer, boardCards, containRect, createSurface, dropSurface, exportPng, fixedRect, newId, paintOverlay, penStrokes } from './ink.js';
import { awayMonitor, burstDetector, chooseFocus, collisionDetector, crosstalkDetector, focusDirector, frameDiff, hesitationDetector, phraseTrigger, turnOrder } from './director.js';
import { RING, agoLabel, captureFrame, cardSlot, createRing, cropToDataUrl, fitWithin, normRect } from './timemachine.js';
import { LEDGER_BEGIN, LEDGER_END, b64u, canonical, createIdentity, fingerprint, proposalPayload, sign, verify, verifyLedger } from './ledger.js';
import { TRACK, capture, createAnchor, dock, readLuma, track } from './tracker.js';
import { WITNESS, WITNESS_BEGIN, WITNESS_END, checkFrame, digest, distance, sameFrame, signFrame, verifyWitness } from './witness.js';
import { createSpatialMixer } from './spatial.js';
import { analyze, hasDevanagari, renderAnswer, renderBasis, renderIntent, speakable, transliterate } from './copilot.js';
import { gloss, glossable } from './glossary.js';

const $ = (s) => document.querySelector(s);
const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener('click', fn));
const icon = (n) => `<svg class="i i-${n}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const iceConfig = fetch('/config').then((r) => r.json()).catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));
const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const EMOJI = ['👏', '❤️', '😂', '😮', '🎉', '👍'];
const SPEAKING = 0.015; // ponytail: fixed voice-activity threshold; tune if active-speaker switching feels twitchy
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
// What I speak (the speech recogniser's language) and what captions are translated into.
const SPEAK = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['hi-IN', 'हिन्दी'], ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-BR', 'Português (Brasil)'], ['it-IT', 'Italiano'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文'], ['ar-SA', 'العربية'], ['ru-RU', 'Русский']];
const LANGS = [['', 'Off'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['pt', 'Português'], ['hi', 'हिन्दी'], ['ar', 'العربية'], ['ru', 'Русский'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文']];
const BOARD_BG = (ctx, r) => { ctx.fillStyle = '#0d1120'; ctx.fillRect(r.x, r.y, r.w, r.h); };
const MOTION = 4; // ponytail: mean luminance change (0-255) that counts as camera movement; tune per camera
// Browser capabilities, detected once. Missing ones show a status badge instead of failing at use time.
const CAPS = {
  translate: 'Translator' in self ? 'On-device' : typeof window.translation?.createTranslator === 'function' ? 'On-device (preview)' : '',
  popout: 'documentPictureInPicture' in window ? 'Floating window' : document.pictureInPictureEnabled ? 'Video only' : '',
  transitions: typeof document.startViewTransition === 'function',
};

const me = { id: null, key: null, name: '', mic: true, cam: true, hand: false, screen: false, rec: false, ink: true, auto: false, lang: navigator.language || 'en-US' };
const L = { id: 'me', state: me, level: null, tile: null, video: null, talk: 0, lastSpoke: 0, get name() { return me.name; } }; // local participant
const peers = new Map();
const transcript = [];
const chatLog = [];
const highlights = [];
const capEls = new Map();
const knocks = new Map();
const seen = new Set(); // note ids (captions, highlights) already in our notes: dedupes live relay vs catch-up
const pinLog = new Map(); // pid → exported pin record
const triggerAt = new Map(); // auto-highlight reason → last time it fired
const proposals = new Map(); // proposalId → proposal with verified signatures (keyed by key fingerprint)
let room = '', host = null, locked = false, waitingRoom = false, view = 'gallery', pinned = null, active = null, started = 0, unread = 0, tab = 'chat';
let camTrack = null, micTrack = null, screenTrack = null;
let es = null, inbox = Promise.resolve(), outbox = Promise.resolve();
let ac = null, recognizer = null, recorder = null, mix = null, lastInterim = 0, recStarted = 0;
let heard = false, mutedFrames = 0, lastHint = 0;
let inkTool = null, boardTool = 'pen', boardColor = '#f2f4fa', boardNoticed = false, target = store.get('truemeet-tl') ?? '';
const boardMine = [];
let skew = 0, caughtUp = false, autoFocusId = null, boardAuto = false, boardClosedAt = 0, boardAt = 0, lastInput = Date.now(), motionAt = 0;
let away = awayMonitor(), motion = null, pinPop = null;
const dwell = focusDirector(), reactionBurst = burstDetector(), crosstalk = crosstalkDetector();
const collision = collisionDetector(), hesitation = hesitationDetector();
const mixer = createSpatialMixer(() => (ac ??= new AudioContext()));
let identity = null, whisperTo = null, hoverTile = null;
const whisperFrom = new Set();
// This tab's signing key (ECDSA P-256, private half non-extractable). Needs WebCrypto (HTTPS or localhost).
const identityReady = (globalThis.crypto?.subtle ? createIdentity() : Promise.reject(new Error('WebCrypto unavailable'))).then((id) => (identity = id), () => null);

const all = () => [L, ...peers.values()];
const idOf = (p) => (p === L ? me.id : p.id);
const show = (id) => document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== id));
const link = () => `${location.origin}/${room}`;
const clock = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const clockS = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';
const hue = (n) => { let h = 7; for (const c of n) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const myInk = () => `hsl(${hue(me.name)} 90% 66%)`;
const seenNid = (n) => { if (!n) return false; if (seen.has(n)) return true; seen.add(n); return false; };
const isDirector = () => me.auto && !!me.id && all().filter((p) => p.state.auto && idOf(p)).map(idOf).sort()[0] === me.id;
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform); // "macOS" (Chromium) or "MacIntel"
// What to tell someone whose camera, mic or screen was refused: macOS also asks, per app.
const blocked = (what, pane) => `${what} blocked — allow it in Chrome’s address bar${IS_MAC ? `, and in System Settings → Privacy & Security → ${pane} (then restart Chrome)` : ''}`;
const deviceError = (e, what, pane) => (e?.name === 'NotAllowedError' ? blocked(what, pane) : e?.name === 'NotReadableError' ? `${what} is in use by another app` : `${what} unavailable`);
const baseLang = (l) => (typeof l === 'string' && LANG_RE.test(l) ? l.split('-')[0].toLowerCase() : 'en');
const duration = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
};

function toast(text, iconName, ms = 3200) {
  const el = Object.assign(document.createElement('div'), { className: 'toast glass', innerHTML: iconName ? icon(iconName) : '' });
  el.append(text);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 500);
  return el;
}
function save(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
function copyLink() {
  navigator.clipboard?.writeText(link()).then(() => toast('Invite link copied', 'check'), () => toast(link())) ?? toast(link());
}

// ---------- Signaling ----------
function send(msg) {
  const body = JSON.stringify({ ...msg, room, id: me.id, key: me.key });
  outbox = outbox.then(() => fetch('/api/signal', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).catch(() => {}); // sequential keeps offer before ICE
}
function connect() {
  es = new EventSource(`/api/events?room=${encodeURIComponent(room)}&name=${encodeURIComponent(me.name)}`);
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'error' || m.type === 'kicked') es.close(); // stop EventSource auto-reconnect
    inbox = inbox.then(() => handle(m)).catch((err) => console.error('[TrueMeet]', err));
  };
  es.onerror = () => {
    if (es?.readyState !== EventSource.CONNECTING) return;
    if (me.id) toast('Connection lost — reconnecting…', 'waves');
    else $('#lobbyErr').textContent = 'Can’t reach TrueMeet — retrying…';
  };
}

async function handle(m) {
  const p = peers.get(m.from);
  switch (m.type) {
    case 'welcome': return welcome(m);
    case 'waiting': return joining(true, 'Waiting for the host to let you in…');
    case 'error': joining(false); $('#lobbyErr').textContent = m.reason; return;
    case 'join':
      await addPeer(m.peer, false);
      chime(true);
      if (host === me.id) syncBoard(m.peer.id);
      return toast(`${m.peer.name} joined`, 'user-plus');
    case 'leave': if (p) { removePeer(p); chime(false); toast(`${p.name} left`, 'user-minus'); } return;
    case 'offer': {
      const q = p ?? await addPeer({ id: m.from, name: m.name }, false);
      await q.pc.setRemoteDescription(m.sdp);
      attach(q);
      await q.pc.setLocalDescription();
      return send({ type: 'answer', to: q.id, sdp: q.pc.localDescription });
    }
    case 'answer': return p?.pc.setRemoteDescription(m.sdp);
    case 'ice': return p?.pc.addIceCandidate(m.candidate).catch(() => {});
    case 'state': {
      if (!p) return;
      const now = Date.now();
      if (!p.state.mic && m.state.mic) hesitation.unmute(p.id, now, othersTalking(p));
      if (p.state.mic && !m.state.mic && hesitation.mute(p.id, now) && host === me.id) nudgeCard(p); // private to the host
      if (p.state.screen && !m.state.screen) { endTimeMachine(p); p.wit = p.samples = p.witState = null; }
      if (m.state.screen && !p.state.screen) p.shareAt = now;
      if (m.state.hand && !p.state.hand) toast(`${p.name} raised a hand`, 'hand');
      if (m.state.rec && !p.state.rec) toast(`${p.name} started recording`, 'record');
      if (!(m.state.screen && m.state.ink)) { p.surface.strokes.clear(); p.surface.patches.clear(); } // share ended or annotation switched off
      p.surface.dirty = true;
      p.state = m.state;
      paint(p); paintWitness(p); renderPeople(); paintRec(); layout();
      return;
    }
    case 'identity': if (p) { p.jwk = m.jwk; p.code = null; } return;
    case 'whisper': return onWhisper(p, m.on);
    case 'beam-snapshot': return p && beamCard(p, m);
    case 'screen-patch': return p && onPatch(p, m);
    case 'witness-frame': return p && onWitness(p, m);
    case 'turn-queue': return showTurnQueue(m.order);
    case 'nudge': return nudged(m.name);
    case 'proposal': return onProposal(m);
    case 'proposal-signed': return onSigned(m);
    case 'ledger':
      for (const x of m.proposals ?? []) {
        await onProposal({ ...x, name: x.proposer, replay: true });
        for (const sig of x.signatures ?? []) await onSigned({ ...sig, proposalId: x.proposalId });
      }
      return;
    case 'chat': return addChat(m.name, String(m.text).slice(0, 2000), false);
    case 'reaction': if (p && EMOJI.includes(m.emoji)) { burst(p, m.emoji); directorReaction(p.id); } return;
    case 'caption': {
      if (!p || (m.final && seenNid(m.nid))) return;
      const text = String(m.text).slice(0, 500);
      caption(p, text, !!m.final, m.lang);
      if (m.final) { directorCaption(p, text); copilotFor(p, text, m.lang); }
      return;
    }
    case 'ink': { const sender = m.from === me.id ? L : p; return sender && onInk(sender, m); } // pins echo back to their author
    case 'pins': for (const pin of m.pins ?? []) onInk(pin.by === me.id ? L : peers.get(pin.by) ?? { id: pin.by, name: pin.name, state: {} }, { ...pin, op: 'pin', replay: true }); return;
    case 'mark':
      if (!p || seenNid(m.nid)) return;
      addMark({ name: m.auto ? 'Auto-Mode' : p.name, context: String(m.context ?? '').slice(0, 200), auto: !!m.auto, reason: m.reason });
      return toast(m.auto ? `Auto-highlight · ${m.reason}` : `${p.name} marked a highlight`, m.auto ? 'wand' : 'bookmark');
    case 'catchup': return renderCatchup(m);
    case 'speak-reply': return p && speakReply(p, String(m.text).slice(0, 280), m.lang);
    case 'host':
      host = m.id;
      if (host !== me.id) { knocks.clear(); renderKnocks(); }
      renderPeople();
      if (host === me.id) toast('You are now the host', 'crown');
      return;
    case 'locked': locked = m.locked; paintLock(); return toast(locked ? 'Meeting locked — no one else can join' : 'Meeting unlocked', locked ? 'lock' : 'unlock');
    case 'waiting-room': waitingRoom = m.on; paintLock(); return toast(waitingRoom ? 'Waiting room on — the host admits each person' : 'Waiting room off', 'clock');
    case 'knock': knocks.set(m.peer.id, m.peer); renderKnocks(); chime(true); return toast(`${m.peer.name} is waiting to join`, 'clock');
    case 'knock-cancel': knocks.delete(m.id); return renderKnocks();
    case 'mute-all': if (me.mic) toggleMic(); return toast(`${m.name} muted everyone`, 'mic-off');
    case 'kicked': return leave('The host removed you from the meeting');
  }
}

async function welcome(m) {
  if (me.id) resetPeers(); else { enterRoom(); chime(true); } // a second welcome means EventSource reconnected with a fresh identity
  Object.assign(me, { id: m.id, key: m.key });
  skew = Date.now() - m.now; // server→local clock offset, so everyone's timestamps line up
  started = m.started + skew;
  host = m.host;
  locked = m.locked;
  waitingRoom = m.waiting;
  paintLock();
  syncState();
  identityReady.then((id) => id && me.id === m.id && send({ type: 'identity', jwk: id.jwk }));
  for (const info of m.peers) await addPeer(info, true); // newcomer offers to everyone already here
}

// ---------- Peers ----------
async function addPeer(info, offer) {
  if (peers.has(info.id)) return peers.get(info.id);
  const pc = new RTCPeerConnection(await iceConfig);
  const p = { id: info.id, name: info.name, state: info.state ?? {}, jwk: info.jwk ?? null, pc, stream: new MediaStream(), level: null, talk: 0, lastSpoke: 0, shareAt: info.state?.screen ? Date.now() : 0, inkAt: 0 };
  peers.set(p.id, p);
  makeTile(p);
  p.video.srcObject = p.stream;
  if ($('#spkSel').value) p.video.setSinkId?.($('#spkSel').value).catch(() => {});
  pc.onicecandidate = (e) => e.candidate && send({ type: 'ice', to: p.id, candidate: e.candidate });
  pc.ontrack = ({ track }) => {
    p.stream.addTrack(track);
    p.video.play().catch(() => {});
    if (track.kind === 'audio') { p.level = meter(track); mix?.add(track); if (mixer.active) applyMix(); }
  };
  pc.onconnectionstatechange = () => p.tile.classList.toggle('weak', ['disconnected', 'failed'].includes(pc.connectionState));
  if (offer) {
    pc.addTransceiver('audio');
    pc.addTransceiver('video');
    attach(p);
    await pc.setLocalDescription();
    send({ type: 'offer', to: p.id, sdp: pc.localDescription });
  }
  paint(p); layout(); renderPeople();
  return p;
}
function attach(p) {
  // One audio + one video transceiver per peer; camera/screen swaps use replaceTrack, so no renegotiation.
  const [a, v] = p.pc.getTransceivers();
  a.direction = v.direction = 'sendrecv';
  a.sender.replaceTrack(whisperTo && whisperTo !== p.id ? null : micTrack).catch(() => {}); // mid-whisper joiners don't overhear
  v.sender.replaceTrack(outVideo()).catch(() => {});
  p.aud = a.sender;
  p.vid = v.sender;
}
function removePeer(p) {
  if (whisperTo === p.id) stopWhisper();
  if (whisperFrom.delete(p.id)) applyMix();
  hesitation.forget(p.id);
  endTimeMachine(p);
  p.pc.close();
  p.tile.remove();
  dropSurface(p.surface);
  dropSurface(p.past);
  peers.delete(p.id);
  capEls.get(p.id)?.remove();
  capEls.delete(p.id);
  if (pinned === p.id) pinned = null;
  if (active === p.id) active = null;
  layout(); renderPeople(); paintRec();
}
const resetPeers = () => [...peers.values()].forEach(removePeer);

// Short authentication string: both ends hash the two DTLS fingerprints they actually negotiated.
// A man-in-the-middle (even a malicious signaling server) must swap fingerprints, so the codes differ.
async function safetyCode(p) {
  const fp = (sdp) => sdp?.match(/a=fingerprint:sha-256 ([0-9A-F:]+)/i)?.[1]?.toUpperCase();
  const a = fp(p.pc.localDescription?.sdp), b = fp(p.pc.remoteDescription?.sdp);
  if (!a || !b || !crypto.subtle || !identity || !p.jwk) return null;
  // The two ledger signing keys are part of the code too: matching codes also prove nobody swapped them.
  const keys = [identity.fingerprint, await fingerprint(p.jwk)].sort();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...[a, b].sort(), ...keys].join('|'))));
  return String(((h[0] << 16) | (h[1] << 8) | h[2]) % 1e6).padStart(6, '0').replace(/^(\d{3})/, '$1 ');
}

// ---------- Media ----------
const pick = (sel) => ($(sel).value ? { exact: $(sel).value } : undefined);
const audioOpts = () => ({ deviceId: pick('#micSel'), echoCancellation: true, autoGainControl: true, noiseSuppression: $('#nsToggle').checked });
const videoOpts = () => ({ deviceId: pick('#camSel'), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
const gum = (c) => navigator.mediaDevices.getUserMedia(c);
const outVideo = () => screenTrack ?? (me.cam ? camTrack : null);
const blurCapable = (t) => t?.getCapabilities?.().backgroundBlur?.length > 1;

async function getCam() {
  try {
    const [t] = (await gum({ video: videoOpts() })).getVideoTracks();
    $('#blurRow').hidden = !blurCapable(t);
    if (blurCapable(t) && $('#blurToggle').checked) t.applyConstraints({ backgroundBlur: true }).catch(() => {});
    return t;
  } catch (e) { toast(deviceError(e, 'Camera', 'Camera'), 'video-off', 9000); return null; }
}
async function getMic() {
  try { return (await gum({ audio: audioOpts() })).getAudioTracks()[0]; } catch (e) { toast(deviceError(e, 'Microphone', 'Microphone'), 'mic-off', 9000); return null; }
}
async function initMedia() {
  try {
    const s = await gum({ audio: audioOpts(), video: videoOpts() });
    [micTrack] = s.getAudioTracks();
    [camTrack] = s.getVideoTracks();
    $('#blurRow').hidden = !blurCapable(camTrack);
  } catch {
    micTrack = await getMic();
    camTrack = await getCam();
  }
  me.mic = !!micTrack;
  me.cam = !!camTrack;
  setProbe();
}
function setProbe() {
  // Meter an always-enabled clone so we can still hear you while muted (for the "you're muted" hint).
  L.probe?.stop();
  L.probe = micTrack?.clone() ?? null;
  if (L.probe) L.probe.enabled = true;
  L.level = meter(L.probe);
  heard = false;
}
function stopMedia() {
  for (const t of [camTrack, micTrack, L.probe]) t?.stop();
  camTrack = micTrack = L.probe = null;
  L.level = null;
}
function chime(up) {
  if (ac?.state !== 'running') return;
  const t = ac.currentTime, g = ac.createGain();
  g.connect(ac.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  (up ? [659, 880] : [880, 587]).forEach((f, i) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(t + i * 0.1);
    o.stop(t + 0.6);
  });
}
function meter(track) {
  if (!track) return null;
  ac ??= new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 512;
  ac.createMediaStreamSource(new MediaStream([track])).connect(an);
  const buf = new Float32Array(an.fftSize);
  return () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; return Math.sqrt(s / buf.length); };
}
async function fillDevices() {
  const devs = (await navigator.mediaDevices?.enumerateDevices().catch(() => null)) ?? [];
  const fill = (sel, kind, label, current) => {
    const el = $(sel), list = devs.filter((d) => d.kind === kind);
    el.replaceChildren(...list.map((d, i) => new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
    if (current) el.value = current;
    el.closest('label').hidden = !list.length;
  };
  fill('#camSel', 'videoinput', 'Camera', camTrack?.getSettings().deviceId);
  fill('#micSel', 'audioinput', 'Microphone', micTrack?.getSettings().deviceId);
  fill('#spkSel', 'audiooutput', 'Speaker');
  if (!('setSinkId' in HTMLMediaElement.prototype)) $('#spkSel').closest('label').hidden = true;
}

function renderLocal() {
  const v = outVideo();
  for (const el of [$('#preview'), L.video]) if (el && el.srcObject?.getVideoTracks()[0] !== v) el.srcObject = v ? new MediaStream([v]) : null;
  const n = $('#name').value.trim() || me.name || 'You';
  $('#previewWrap').classList.toggle('cam-off', !v);
  $('#previewWrap .avatar').style.setProperty('--hue', hue(n));
  $('.self-initials').textContent = initials(n);
  paintChecks();
}
function paintChecks() {
  const check = (sel, ok, text) => { $(sel).classList.toggle('ok', ok); $(`${sel} span`).textContent = text; };
  const h = camTrack?.getSettings().height;
  check('#chkCam', !!outVideo(), outVideo() ? `Camera${h ? ` · ${h}p` : ''}` : 'Camera off');
  check('#chkMic', !!micTrack && heard, !micTrack ? 'No microphone' : heard ? 'Mic sounds good' : 'Say something to test');
}
function joining(busy, text = 'Joining…') {
  $('#joinBtn').disabled = busy;
  $('#joinBtn').classList.toggle('loading', busy);
  $('#joinBtn .btn-text').textContent = busy ? text : 'Join meeting';
}
function pushVideo() {
  const v = outVideo();
  for (const p of peers.values()) p.vid?.replaceTrack(v).catch(() => {});
  renderLocal();
}

// ---------- Controls ----------
function setCtl(sel, on, onIcon, offIcon, cls) {
  for (const b of document.querySelectorAll(sel)) {
    b.querySelector('use').setAttribute('href', `#i-${on || !offIcon ? onIcon : offIcon}`);
    b.classList.toggle(cls, cls === 'off' ? !on : on);
    b.setAttribute('aria-pressed', String(on));
  }
}
function paintControls() {
  setCtl('.mic-ctl', me.mic, 'mic', 'mic-off', 'off');
  setCtl('.cam-ctl', me.cam, 'video', 'video-off', 'off');
  setCtl('#shareBtn', me.screen, 'screen', null, 'on');
  setCtl('#handBtn', me.hand, 'hand', null, 'on');
  setCtl('#ccBtn', !!recognizer, 'captions', null, 'on');
  setCtl('#recBtn', !!recorder, 'record', null, 'rec');
  setCtl('#boardBtn', !$('#board').hidden, 'board', null, 'on');
  setCtl('#autoBtn', me.auto, 'wand', null, 'on');
  $('#autoChip').hidden = !me.auto;
}
function syncState() {
  paintControls(); paint(L); renderPeople(); paintRec(); layout();
  const { mic, cam, hand, screen, rec, ink, auto, lang } = me;
  if (me.id) send({ type: 'state', state: { mic, cam, hand, screen, rec, ink, auto, lang } });
}

function toggleMic() {
  if (!micTrack) return toast('No microphone available', 'mic-off');
  me.mic = !me.mic;
  micTrack.enabled = me.mic && !voiceDuck;
  syncState();
}
async function toggleCam() {
  if (me.cam) { camTrack?.stop(); camTrack = null; me.cam = false; } // release the camera so its light goes off
  else { camTrack = await getCam(); me.cam = !!camTrack; }
  pushVideo(); syncState();
}
async function toggleShare() {
  if (screenTrack) return stopShare();
  try { [screenTrack] = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } })).getVideoTracks(); }
  catch (e) { if (e instanceof TypeError) toast('Screen sharing isn’t supported on this device'); return; }
  screenTrack.contentHint = 'detail';
  screenTrack.onended = stopShare;
  me.screen = true;
  me.ink = true;
  pushVideo(); syncState();
  toast('Sharing — viewers can point and draw on your screen. Pop out the presenter view to see them.', 'screen');
}
function stopShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  me.screen = false;
  L.surface?.strokes.clear();
  L.surface?.patches.clear();
  witnessOut = null;
  blackTicks = 0;
  paintWitness(L);
  pushVideo(); syncState();
}
function toggleHand() { me.hand = !me.hand; syncState(); }

// ---------- Live captions + translation ----------
function startCaptions() {
  const r = (recognizer = new SR());
  r.continuous = true;
  r.interimResults = true;
  r.lang = me.lang; // fixed for the session: changing "I speak" restarts recognition
  r.onresult = (e) => {
    if (!me.mic || voiceDuck) return; // never transcribe while muted, or a reply our speakers are voicing
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], text = res[0].transcript.trim();
      if (!text || (!res.isFinal && Date.now() - lastInterim < 250)) continue;
      lastInterim = Date.now();
      const nid = res.isFinal ? newId() : undefined;
      if (nid) seen.add(nid);
      caption(L, text, res.isFinal, me.lang);
      send({ type: 'caption', text, final: res.isFinal, lang: me.lang, nid });
      if (!res.isFinal) continue;
      directorCaption(L, text);
      if (!peers.size) copilotFor(L, text, me.lang, true); // alone: preview the Co-Pilot on your own questions
    }
  };
  r.onend = () => setTimeout(() => { if (recognizer === r) try { r.start(); } catch {} }, 300); // browsers stop after silence
  r.onerror = (e) => {
    if (!['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) return;
    recognizer = null;
    paintControls();
    toast('Live captions are blocked in this browser', 'captions');
  };
  r.start();
}
const stopCaptions = () => { const r = recognizer; recognizer = null; r?.stop(); };
const speakLabel = () => SPEAK.find(([t]) => t === me.lang)?.[1] ?? me.lang;
function toggleCaptions() {
  if (!SR) return toast('Live captions need Chrome, Edge or Safari');
  if (recognizer) stopCaptions(); else startCaptions();
  paintControls();
  paintTlStatus();
  if (recognizer) toast(`Live captions on — listening for ${speakLabel()}. Change it under Caption languages.`, 'captions');
}
// Arrow keys on a closed <select> fire "change" at every step: act once, where the user stops —
// well within the few seconds a click or key press counts as a user gesture (downloads need one).
const settled = () => { let id = 0; return (fn) => { clearTimeout(id); id = setTimeout(fn, 600); }; };
const afterSpeak = settled(), afterTarget = settled();
function setSpeak(tag) {
  me.lang = tag;
  store.set('truemeet-speak', tag);
  syncState(); // everyone translates my captions from this language
  paintTlStatus();
  afterSpeak(() => {
    if (recognizer) { stopCaptions(); startCaptions(); }
    if (target && baseLang(me.lang) !== target) engine(baseLang(me.lang), target, true);
    paintControls();
    toast(`Captions now listen for ${speakLabel()}`, 'captions');
  });
}

// One engine per language pair. Chrome's Translator API runs on-device; a model it still has to
// download needs a click (user activation) and can take minutes, and some pairs have no model.
// Until a model is ready — or when there is none — captions use the instant built-in dictionary
// (glossary.js), always marked "≈", and transcript lines are upgraded once the model arrives.
const engines = new Map(); // 'en>es' → { src, dst, state, progress, translator, settled }
// gesture: called from a deliberate user choice, so a model may be downloaded; otherwise a model
// that needs downloading waits for a click ('needs-click').
function engine(src, dst, gesture = false) {
  const k = `${src}>${dst}`, old = engines.get(k);
  if (old && !(gesture && ['needs-click', 'failed'].includes(old.state))) return old;
  const e = { src, dst, state: 'checking', progress: 0, translator: null };
  engines.set(k, e);
  e.settled = prepare(e, gesture);
  return e;
}
async function prepare(e, gesture) {
  const pair = { sourceLanguage: e.src, targetLanguage: e.dst };
  const set = (state, progress = e.progress) => { Object.assign(e, { state, progress }); paintTlStatus(); };
  const monitor = (m) => m.addEventListener('downloadprogress', (ev) => set('downloading', ev.total ? ev.loaded / ev.total : ev.loaded));
  try {
    if ('Translator' in self) {
      const a = await Translator.availability(pair);
      if (a === 'unavailable') return set('no-model');
      if (a !== 'available') { if (!gesture) return set('needs-click'); set('downloading'); }
      e.translator = await Translator.create({ ...pair, monitor });
    } else if (typeof window.translation?.createTranslator === 'function') {
      const a = await window.translation.canTranslate?.(pair);
      if (a === 'no') return set('no-model');
      if (a === 'after-download') { if (!gesture) return set('needs-click'); set('downloading'); }
      e.translator = await window.translation.createTranslator(pair);
    } else return set('no-model');
    set('ready', 1);
  } catch (err) {
    set(err?.name === 'NotAllowedError' ? 'needs-click' : 'failed');
  }
}
const modelReady = (src, dst) => engine(src, dst).settled.then(() => engine(src, dst).state === 'ready');
const translations = new Map(); // model output only (the dictionary is instant): `${src}>${dst}\n${text}` → Promise<string|null>
// → { text, via: 'model' | 'dictionary' }, or null when neither can translate it.
async function translateTo(text, src, dst) {
  if (!dst || src === dst) return null;
  const e = engine(src, dst);
  if (e.state === 'checking') await Promise.race([e.settled, new Promise((r) => setTimeout(r, 1200))]); // an installed model loads in well under a second
  if (e.state === 'ready') {
    const k = `${src}>${dst}\n${text}`;
    if (!translations.has(k)) {
      if (translations.size >= 300) translations.delete(translations.keys().next().value);
      translations.set(k, e.translator.translate(text).catch(() => null));
    }
    const out = await translations.get(k);
    if (out) return { text: out, via: 'model' };
  }
  const g = gloss(text, src, dst);
  return g && { text: g, via: 'dictionary' };
}
const translate = (text, lang) => translateTo(text, baseLang(lang), target);
const sourceLangs = () => new Set([baseLang(me.lang), ...[...peers.values()].map((p) => baseLang(p.state.lang))]);
function setTarget(lang) {
  target = lang;
  store.set('truemeet-tl', lang);
  paintTlStatus();
  afterTarget(() => {
    if (!target) return toast('Caption translation off', 'languages');
    for (const src of sourceLangs()) if (src !== target) engine(src, target, true); // a deliberate choice: models may download
    toast(`Captions will be translated to ${LANGS.find(([c]) => c === target)[1]}`, 'languages');
  });
}
function describeEngine(e) {
  const pair = `${e.src.toUpperCase()} → ${e.dst.toUpperCase()}`, meanwhile = glossable(e.src, e.dst) ? ' · dictionary meanwhile' : '';
  switch (e.state) {
    case 'ready': return `${pair} · on-device translator ready`;
    case 'checking': return `${pair} · checking translator…`;
    case 'downloading': return `${pair} · downloading model ${Math.round(e.progress * 100)}%${meanwhile}`;
    case 'needs-click': return `${pair} · click to download the model${meanwhile}`;
    default: return glossable(e.src, e.dst) ? `${pair} · built-in dictionary (approximate)` : `${pair} · no translator for this pair here`;
  }
}
// The pill above the captions: one status per language pair that matters right now.
function paintTlStatus() {
  const list = target && me.id ? [...sourceLangs()].filter((src) => src !== target).map((src) => engine(src, target)) : [];
  const text = list.map(describeEngine).join('  ·  ');
  $('#tlPill').hidden = !list.length;
  $('#tlPill').dataset.state = ['needs-click', 'downloading', 'checking', 'ready'].find((st) => list.some((e) => e.state === st)) ?? 'dictionary';
  $('#tlPill span').textContent = text;
  $('#tlStatus').textContent = text || (target ? 'Nothing to translate: everyone speaks your caption language.' : 'Captions are shown as spoken.');
}
const tlTag = (src, via) => `${src.toUpperCase()} → ${target.toUpperCase()}${via === 'dictionary' ? ' ≈' : ''}`;
function caption(p, text, final, lang) {
  let el = capEls.get(p.id);
  if (!el) {
    el = document.createElement('div');
    el.innerHTML = '<b></b><span></span><em></em>';
    el.querySelector('b').textContent = p === L ? 'You' : p.name;
    $('#captions').append(el);
    capEls.set(p.id, el);
  }
  const span = el.querySelector('span'), em = el.querySelector('em');
  span.textContent = text;
  em.textContent = '';
  el.title = '';
  clearTimeout(el.timer);
  el.timer = setTimeout(() => { el.remove(); capEls.delete(p.id); }, 4000);
  // Live translation of every caption update — mine too, so you can hear yourself in another
  // language — interim ones included; only the newest result is shown.
  const src = baseLang(lang), live = target && src !== target ? translate(text, lang) : null;
  if (live) {
    const seq = (el.seq = (el.seq ?? 0) + 1);
    live.then((tr) => {
      if (!tr || el.seq !== seq) return;
      span.textContent = tr.text;
      em.textContent = tlTag(src, tr.via);
      em.title = tr.via === 'dictionary' ? 'Approximate: built-in dictionary while the on-device translator isn’t ready' : 'Translated on your device';
      el.title = text;
    });
  }
  if (!final) return;
  const { li, entry } = addEntry('#transcript', transcript, p.name, text, false);
  live?.then((tr) => tr && showTranslation(li, entry, text, src, tr));
}
function showTranslation(li, entry, text, src, tr) {
  Object.assign(entry, { tr: tr.text, trVia: tr.via });
  li.querySelector('p').textContent = tr.text;
  li.title = text;
  const small = li.querySelector('small'), mark = small.querySelector('.tr') ?? small.appendChild(Object.assign(document.createElement('span'), { className: 'tr' }));
  mark.textContent = tr.via === 'dictionary' ? ' · ≈ dictionary translation' : ' · translated';
  const dst = target;
  if (tr.via === 'dictionary') { // upgrade the line when the real model is ready
    modelReady(src, dst).then((ok) => ok && translateTo(text, src, dst)).then((better) => better?.via === 'model' && showTranslation(li, entry, text, src, better));
  }
}

// ---------- Private Co-Pilot ----------
// When someone else asks, objects, names a price or a deadline, or wants a status update, only you
// get a card: what they asked (in your language) and two ranked replies grounded in this meeting's
// pins, highlights, proposals and snips — each in your language and in theirs, ready to read aloud
// or send. Deterministic and offline by default; refined by on-device AI when Chrome has it ready.
let copilotOn = store.get('truemeet-copilot') !== '0', copilotAt = 0, copilotView = null, lmBase = null;
const AI_SCHEMA = { type: 'object', properties: { intent: { type: 'string' }, answers: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } }, required: ['intent', 'answers'] };
function meetingState(question) {
  return {
    highlights: highlights.map(({ context, auto, reason, t }) => ({ context, auto, reason, t })),
    pins: [...pinLog.values()].map(({ n, note, resolved, t }) => ({ n, note, resolved, t })),
    proposals: [...proposals.values()].map(({ text, proposer, timestamp }) => ({ text, proposer, t: timestamp + skew })),
    cards: boardCards(board).map(({ caption }) => ({ caption, t: 0 })),
    captions: transcript.filter((x) => x.text !== question).slice(-12).map(({ name, text, t }) => ({ name, text, t })),
  };
}
async function copilotFor(p, text, lang, self = false) {
  if (!copilotOn || !me.id || Date.now() - copilotAt < 3000) return;
  const speakerLang = baseLang(lang), mine = target || baseLang(me.lang);
  const a = analyze({ text, lang: speakerLang, speaker: p.name, state: meetingState(text) });
  if (!a) return;
  copilotAt = Date.now();
  const sayLang = a.lang; // templates exist for 7 languages; others fall back to English (translated below)
  const view = {
    source: self ? 'preview on your own speech' : 'from this meeting’s context', mine, speakerLang, speakerTag: LANG_RE.test(lang) ? lang : speakerLang,
    intent: renderIntent(a, mine, (await translateTo(text, speakerLang, mine))?.text ?? text),
    basis: renderBasis(a, mine),
    answers: await Promise.all(a.answers.map(async (ans) => {
      const spoken = renderAnswer(a, ans, sayLang);
      return { native: renderAnswer(a, ans, mine), spoken: sayLang === speakerLang ? spoken : (await translateTo(spoken, sayLang, speakerLang))?.text ?? spoken };
    })),
  };
  copilotCard(view);
  const ai = await aiSuggest(a, p, text, speakerLang).catch(() => null);
  if (!ai || copilotView !== view) return;
  const model = (x, dst) => translateTo(x, 'en', dst).then((r) => (r?.via === 'model' ? r.text : null)); // a dictionary gloss isn't good enough here
  const native = await Promise.all(ai.answers.map((x) => (mine === 'en' ? x : model(x, mine))));
  const spoken = await Promise.all(ai.answers.map((x) => (speakerLang === 'en' ? x : model(x, speakerLang))));
  if (native.some((x) => !x) || spoken.some((x) => !x)) return; // keep the natively-phrased answers rather than mix languages
  copilotCard({ ...view, source: 'refined by on-device AI', answers: ai.answers.map((_, i) => ({ native: native[i], spoken: spoken[i] })) });
}
async function aiSuggest(a, p, text, speakerLang) {
  if (!('LanguageModel' in self)) return null;
  const inputs = ['en', ...(['es', 'de', 'fr', 'ja'].includes(speakerLang) ? [speakerLang] : [])];
  const opts = { expectedInputs: [{ type: 'text', languages: inputs }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  if ((await LanguageModel.availability(opts)) !== 'available') return null; // never start a multi-GB model download unasked
  lmBase ??= LanguageModel.create({ ...opts, initialPrompts: [{ role: 'system', content: 'You are a discreet meeting co-pilot. Given facts from the meeting and what a participant just said, suggest two short, concrete replies the user could say. Ground them only in the facts; never invent numbers, dates or commitments.' }] }).catch(() => (lmBase = null));
  const base = await lmBase;
  if (!base) return null;
  const session = await base.clone();
  try {
    const facts = a.facts.map((f) => `- (${f.kind}) ${f.text}`).join('\n') || '- (none yet)';
    const raw = await Promise.race([
      session.prompt(`Meeting facts:\n${facts}\n\n${p.name} just said: "${text}"\n\nReturn JSON with "intent" (one short line: what is being asked) and "answers" (best reply first, then an alternative; first person, at most 25 words each).`, { responseConstraint: AI_SCHEMA }),
      new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), 8000)),
    ]);
    const out = JSON.parse(raw);
    if (typeof out?.intent !== 'string' || !Array.isArray(out.answers) || out.answers.length < 2 || !out.answers.every((x) => typeof x === 'string' && x.trim())) return null;
    return { intent: out.intent.slice(0, 160), answers: out.answers.slice(0, 2).map((x) => x.trim().slice(0, 240)) };
  } finally {
    session.destroy?.();
  }
}
function copilotCard(view) {
  copilotView = view;
  const el = document.createElement('section');
  el.className = 'copilot glass';
  el.setAttribute('role', 'complementary');
  el.setAttribute('aria-label', 'Co-Pilot suggestions, visible only to you');
  el.innerHTML = `<header>${icon('wand')}<div><b>Co-Pilot</b><small></small></div><button class="icon-btn" aria-label="Dismiss suggestions">${icon('x')}</button></header><p class="cp-intent"></p><ol class="cp-answers"></ol><p class="cp-basis"></p>`;
  el.querySelector('small').textContent = `Only you can see this · ${view.source}`;
  el.querySelector('.cp-intent').textContent = view.intent;
  el.querySelector('.cp-basis').textContent = view.basis;
  const bilingual = view.mine !== view.speakerLang;
  const dismiss = () => { if (copilotView === view) copilotView = null; el.remove(); };
  view.answers.forEach((ans) => {
    const li = document.createElement('li');
    li.innerHTML = `<p class="cp-native"><span class="cp-tag"></span><span class="cp-text"></span></p><p class="cp-spoken"><span class="cp-tag"></span><span class="cp-say"></span></p><p class="cp-pron"></p><div class="cp-actions"><button class="btn ghost xs cp-read">${icon('waves')}Read aloud</button><button class="btn ghost xs cp-speak">${icon('volume')}<span>Speak to room</span></button><button class="btn primary xs cp-send">${icon('send')}Send</button></div>`;
    const [nativeTag, spokenTag] = li.querySelectorAll('.cp-tag');
    nativeTag.textContent = view.mine.toUpperCase();
    nativeTag.hidden = !bilingual;
    li.querySelector('.cp-text').textContent = ans.native;
    li.querySelector('.cp-spoken').hidden = !bilingual; // one language in common: one line is enough
    spokenTag.textContent = view.speakerLang.toUpperCase();
    const say = speakable(ans.spoken, view.speakerLang);
    li.querySelector('.cp-say').textContent = say;
    const pron = hasDevanagari(say) && view.mine !== 'hi' ? transliterate(say) : '';
    li.querySelector('.cp-pron').textContent = pron ? `Say it: ${pron}` : '';
    li.querySelector('.cp-pron').hidden = !pron;
    li.querySelector('.cp-read').onclick = () => readAloud(say, view.speakerTag);
    li.querySelector('.cp-speak').onclick = (e) => {
      send({ type: 'speak-reply', text: ans.spoken, lang: view.speakerTag });
      speakReply(L, ans.spoken, view.speakerTag, true);
      toast(`TrueMeet is speaking your reply to the room (${voiceLabel(view.speakerTag)})`, 'volume');
      e.currentTarget.disabled = true;
      e.currentTarget.querySelector('span').textContent = 'Spoken';
      for (const b of el.querySelectorAll('.cp-speak:not(:disabled)')) { b.disabled = true; setTimeout(() => (b.disabled = false), 2600); } // server allows one every 2.5 s
    };
    li.querySelector('.cp-send').onclick = () => {
      send({ type: 'chat', text: ans.spoken });
      addChat(me.name, ans.spoken, true);
      toast('Sent to the meeting chat', 'send');
      dismiss();
    };
    el.querySelector('.cp-answers').append(li);
  });
  el.querySelector('header .icon-btn').onclick = dismiss;
  const expire = () => (copilotView !== view ? null : el.matches(':hover, :focus-within') ? setTimeout(expire, 10_000) : dismiss());
  setTimeout(expire, 60_000);
  $('#copilot').replaceChildren(el);
}
function readAloud(text, l) { // a private preview, so you can say it yourself
  duck(true);
  speakAloud(text, l, { onEnd: () => duck(false) }).then((r) => {
    if (r === 'spoke') return;
    duck(false);
    toast(`No ${voiceLabel(l)} voice on this device — read it from the card`, 'waves');
  });
}

// ---------- Speak to room ----------
// A chosen reply is spoken aloud by every other participant's browser and shown on the sender's tile.
// Speech synthesis bypasses echo cancellation, so (1) the sender's own browser stays silent — their
// mic would carry it twice — and (2) each listener briefly ducks their own mic, and ignores their
// own captions, while it plays; otherwise every listener would re-broadcast the reply.
let voiceDuck = 0;
const voiceLabel = (l) => String(l).split('-')[0].toUpperCase();
function duck(on) {
  voiceDuck = Math.max(0, voiceDuck + (on ? 1 : -1));
  if (micTrack) micTrack.enabled = me.mic && !voiceDuck;
}
async function voicesFor(l) {
  if (!('speechSynthesis' in window)) return [];
  if (!speechSynthesis.getVoices().length) { // voices load asynchronously on first use
    await new Promise((resolve) => { speechSynthesis.addEventListener?.('voiceschanged', resolve, { once: true }); setTimeout(resolve, 800); });
  }
  const want = String(l).toLowerCase(), base = want.split('-')[0], tag = (v) => v.lang.toLowerCase().replace('_', '-');
  const all = speechSynthesis.getVoices();
  return [...all.filter((v) => tag(v) === want), ...all.filter((v) => tag(v) !== want && tag(v).split('-')[0] === base)];
}
// Speak text; resolves 'spoke' once audio starts, or 'no-voice' / 'failed'. onEnd fires when it stops.
async function speakAloud(text, l, { onEnd } = {}) {
  const [voice] = await voicesFor(l);
  if (!voice) return 'no-voice';
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    Object.assign(u, { lang: voice.lang, voice, rate: 0.95 });
    const timer = setTimeout(() => resolve('failed'), 3000);
    u.onstart = () => { clearTimeout(timer); resolve('spoke'); };
    u.onend = () => onEnd?.();
    u.onerror = () => { clearTimeout(timer); onEnd?.(); resolve('failed'); };
    speechSynthesis.speak(u);
  });
}
function earcon() { // no voice installed: a soft rising two-note cue, then the words on screen
  if (ac?.state !== 'running') return;
  const t = ac.currentTime, g = ac.createGain();
  g.connect(ac.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  [523.25, 783.99].forEach((f, i) => {
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(g);
    o.start(t + i * 0.14);
    o.stop(t + 0.7);
  });
}
function spokenBanner(p, text) {
  const el = p.tile?.querySelector('.spoken');
  if (!el) return { meta() {}, translation() {}, done() {} };
  el.querySelector('p').textContent = text;
  el.querySelector('.sp-tr').textContent = '';
  el.querySelector('.sp-meta').textContent = '';
  el.hidden = false;
  const hideIn = (ms) => { clearTimeout(el.timer); el.timer = setTimeout(() => (el.hidden = true), ms); };
  hideIn(Math.max(6000, text.length * 80)); // time to read it, even if the voice never ends
  return {
    meta: (m) => { el.querySelector('.sp-meta').textContent = m; },
    translation: (tr) => { el.querySelector('.sp-tr').textContent = tr; },
    done: () => hideIn(Math.max(3000, text.length * 45)),
  };
}
async function speakReply(p, text, l, local = false) {
  const tag = typeof l === 'string' && LANG_RE.test(l) ? l : 'en';
  addEntry('#transcript', transcript, `${p === L ? me.name : p.name} · TrueMeet voice`, text, false);
  const banner = spokenBanner(p, text);
  if (local) return banner.meta('Spoken to the room — the others hear the voice');
  if (target && baseLang(tag) !== target) translate(text, tag).then((tr) => tr && banner.translation(tr.via === 'dictionary' ? `≈ ${tr.text}` : tr.text));
  duck(true);
  let ended = false;
  const finish = () => { if (!ended) { ended = true; duck(false); banner.done(); } };
  const r = await speakAloud(speakable(text, baseLang(tag)), tag, { onEnd: finish });
  if (r === 'spoke') return banner.meta(`TrueMeet voice · ${voiceLabel(tag)}`);
  finish();
  earcon();
  banner.meta(`Text only — no ${voiceLabel(tag)} voice on this device`);
}

// ---------- Chat, transcript, highlights, reactions ----------
function addEntry(list, log, name, text, mine, t = Date.now()) {
  const entry = { t, name, text };
  log.push(entry);
  const li = document.createElement('li');
  li.className = mine ? 'mine' : '';
  li.innerHTML = '<small></small><p></p>';
  li.querySelector('small').textContent = `${mine ? 'You' : name} · ${clock(t)}`;
  li.querySelector('p').textContent = text;
  const ol = $(list);
  ol.append(li);
  ol.scrollTop = ol.scrollHeight;
  return { li, entry };
}
function addChat(name, text, mine) {
  addEntry('#chatList', chatLog, name, text, mine);
  if (mine || (!$('#panel').hidden && tab === 'chat')) return;
  $('#unread').hidden = false;
  $('#unread').textContent = ++unread;
  toast(`${name}: ${text.slice(0, 80)}`, 'message');
}
function mark() {
  const nid = newId(), context = transcript.at(-1)?.text ?? '';
  seen.add(nid);
  send({ type: 'mark', context, nid });
  addMark({ name: me.name, context });
  toast('Highlight marked — it’s in the transcript and the download', 'bookmark');
}
function addMark({ name, context, auto = false, reason, t = Date.now() }) {
  highlights.push({ t, name, context, auto, reason, rec: recorder ? t - recStarted : null });
  addNote(auto ? 'auto' : 'mark', `${auto ? `Auto · ${reason}` : `Highlight · ${name}`} · +${duration(Math.max(0, t - started))}`, context || 'Moment marked');
}
function addNote(kind, title, body) {
  const li = document.createElement('li');
  li.className = `note note-${kind}`; // namespaced: never collide with global classes like .mark (logo) or .pin (tile button)
  li.innerHTML = `${icon({ auto: 'wand', pin: 'pin-drop', proposal: 'stamp' }[kind] ?? 'bookmark')}<div><small></small><p></p></div>`;
  li.querySelector('small').textContent = title;
  li.querySelector('p').textContent = body;
  if (kind === 'mark' || kind === 'auto') { // any highlight can be promoted to a signable proposal
    const b = Object.assign(document.createElement('button'), { className: 'btn ghost xs propose', innerHTML: `${icon('stamp')}Propose` });
    b.onclick = () => proposeFrom(body === 'Moment marked' ? '' : body);
    li.querySelector('div').append(b);
  }
  $('#transcript').append(li);
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
  return li;
}

// ---------- Auto-Mode: the meeting director ----------
// One director per room (lowest id among Auto-Mode users) creates room-wide auto-highlights, so
// several people running Auto-Mode never log the same moment twice.
function autoMark(reason, context) {
  const nid = newId();
  seen.add(nid);
  send({ type: 'mark', auto: true, reason, context: context.slice(0, 200), nid });
  addMark({ name: 'Auto-Mode', context: context.slice(0, 200), auto: true, reason });
  toast(`Auto-highlight · ${reason}`, 'wand');
}
function directorCaption(speaker, text) {
  const reason = isDirector() && phraseTrigger(text);
  if (!reason || Date.now() - (triggerAt.get(reason) ?? -Infinity) < 20_000) return;
  triggerAt.set(reason, Date.now());
  autoMark(reason, `${speaker.name}: “${text.slice(0, 160)}”`);
}
function directorReaction(who) {
  if (isDirector() && reactionBurst(who, Date.now())) autoMark('reactions', 'Reaction burst — the room reacted together');
}
function toggleAuto() {
  me.auto = !me.auto;
  autoFocusId = null;
  away = awayMonitor();
  lastInput = Date.now();
  if (!me.auto) $('#notices [data-key="away"]')?.remove();
  syncState();
  toast(me.auto ? 'Auto-Mode on — the stage follows the action and key moments are captured for you' : 'Auto-Mode off', 'wand');
}
function flagDrawing(p) {
  if (!p.tile) return;
  p.tile.classList.add('drawing');
  clearTimeout(p.drawT);
  p.drawT = setTimeout(() => p.tile?.classList.remove('drawing'), 2000);
}
function sampleMotion() {
  if (!camTrack || !me.cam) { motion = null; return; }
  if (motion?.track !== camTrack) {
    const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: new MediaStream([camTrack]) });
    video.play().catch(() => {});
    motion = { track: camTrack, video, ctx: Object.assign(document.createElement('canvas'), { width: 32, height: 18 }).getContext('2d', { willReadFrequently: true }), last: null };
    return;
  }
  if (motion.video.readyState < 2) return;
  motion.ctx.drawImage(motion.video, 0, 0, 32, 18);
  const d = motion.ctx.getImageData(0, 0, 32, 18).data, lum = new Uint8Array(32 * 18);
  for (let i = 0; i < lum.length; i++) lum[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  if (frameDiff(lum, motion.last) > MOTION) motionAt = Date.now();
  motion.last = lum;
}
function notice(key, build) {
  $(`#notices [data-key="${key}"]`)?.remove();
  const el = document.createElement('section');
  el.className = 'notice glass';
  el.dataset.key = key;
  el.setAttribute('role', 'status');
  build(el);
  $('#notices').prepend(el);
  return el;
}
function awayPrompt() {
  notice('away', (el) => {
    el.innerHTML = `<header>${icon('mic')}<div><b>Still there?</b><small>Your mic is on, but it’s been quiet for a while.</small></div></header><footer><button class="btn ghost xs">Keep mic on</button><button class="btn primary xs">Mute</button></footer>`;
    const [keep, mute] = el.querySelectorAll('button');
    keep.onclick = () => el.remove();
    mute.onclick = () => { if (me.mic) toggleMic(); el.remove(); };
    setTimeout(() => el.remove(), 30_000);
  });
}

// ---------- Lean-in whisper ----------
// Holding whisper on someone's tile: your mic is cut for everyone else (per-connection, so it is
// genuinely private), and both of you hear the room softly on the left, each other on the right.
const othersTalking = (p) => all().some((q) => q !== p && Date.now() - q.lastSpoke < 600);
function startWhisper(p) {
  if (!p || p === L || !peers.has(p.id) || whisperTo === p.id || !me.id) return;
  if (whisperTo) stopWhisper();
  whisperTo = p.id;
  for (const q of peers.values()) q.aud?.replaceTrack(q.id === p.id ? micTrack : null).catch(() => {});
  send({ type: 'whisper', to: p.id, on: true });
  applyMix();
}
function stopWhisper(p) {
  if (!whisperTo || (p && p.id !== whisperTo)) return;
  const to = whisperTo;
  whisperTo = null;
  for (const q of peers.values()) q.aud?.replaceTrack(micTrack).catch(() => {});
  if (peers.has(to)) send({ type: 'whisper', to, on: false });
  applyMix();
}
function onWhisper(p, on) {
  if (!p) return;
  if (on) whisperFrom.add(p.id); else whisperFrom.delete(p.id);
  applyMix();
}
function applyMix() {
  const partners = new Set([whisperTo, ...whisperFrom].filter((id) => id && peers.has(id)));
  const list = [...peers.values()].map((q) => ({ id: q.id, track: q.stream.getAudioTracks()[0], video: q.video }));
  if (partners.size) mixer.apply(list, partners); else if (mixer.active) mixer.release(list);
  for (const q of all()) paint(q);
  if (!partners.size) return $('#notices [data-key="whisper"]')?.remove();
  notice('whisper', (el) => {
    el.classList.add('whisper-note');
    el.innerHTML = `<header>${icon('ear')}<div><b></b><small>The room is softly in your left ear, the whisper in your right. Nobody else hears it.</small></div></header>`;
    el.querySelector('b').textContent = whisperTo ? `Whispering to ${peers.get(whisperTo).name} — release to return` : `${[...partners].map((id) => peers.get(id).name).join(', ')} is whispering to you`;
  });
}

// ---------- Screen Time Machine ----------
// Each viewer keeps a private, local 2-minute rewind of every shared screen (one frame / 2 s).
function recordShares(now) {
  for (const p of peers.values()) {
    if (!p.state.screen || p.tile.ownerDocument !== document || !p.video.videoWidth || p.tmBusy) continue;
    p.tm ??= createRing(RING.capacity);
    if (!p.tm.due(now)) continue;
    p.tmBusy = true;
    captureFrame(p.video).then((f) => {
      p.tmBusy = false;
      if (f && p.tm) { p.tm.push({ ...f, t: now }); paintTimeline(p); }
    }, () => { p.tmBusy = false; });
  }
}
function paintTimeline(p) {
  const range = p.tile.querySelector('.tm-range'), n = p.tm?.size ?? 0;
  range.max = String(n); // the right end is "live"
  range.value = String(p.tmView ? Math.max(0, p.tm.indexOf(p.tmView)) : n);
  p.tile.querySelector('.tm-badge').textContent = p.tmView ? `Viewing ${agoLabel(Date.now() - p.tmView.t)}` : n ? 'Live' : 'Recording…';
}
function setFrame(p, frame) {
  const img = p.tile.querySelector('.tm-frame');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (frame) img.src = URL.createObjectURL(frame.blob); else img.removeAttribute('src');
  p.tmView = frame;
  inkApply(p.past, { op: 'clear', all: true }, me.id); // marks belong to the frame they were made on
  p.tile.classList.toggle('rewound', !!frame);
  paint(p);
  paintTimeline(p);
}
function scrub(p, v) {
  const frame = v < (p.tm?.size ?? 0) ? p.tm.at(v) : null;
  if (frame !== p.tmView) setFrame(p, frame);
}
const jumpLive = (p) => setFrame(p, null);
function endTimeMachine(p) {
  if (!p.tile) return;
  if (p.tmView) setFrame(p, null);
  p.tm?.clear();
  p.tm = null;
}
async function beam(p) {
  if (!p.tmView) return;
  const img = p.tile.querySelector('.tm-frame');
  await img.decode().catch(() => {});
  const shot = cropToDataUrl(img);
  if (!shot) return toast('Couldn’t capture that frame', 'history');
  const strokes = penStrokes(p.past).slice(0, 100).map(({ tool, color, pts }) => ({ tool, color, pts: pts.slice(0, 1000) }));
  const pins = [...p.past.pins.values()].filter((x) => !x.resolved).slice(0, 30).map(({ n, x, y, note, color }) => ({ n, x, y, note, color }));
  const ago = Math.min(600, Math.round((Date.now() - p.tmView.t) / 1000));
  send({ type: 'beam-snapshot', to: p.id, image: shot.url, ago, strokes, pins });
  toast(`Beamed to ${p.name}: your marks on their screen from ${ago}s ago`, 'send');
}
async function drawSnapshot(canvas, m, maxSide) {
  const img = canvas.ownerDocument.createElement('img');
  img.src = m.image;
  await img.decode();
  const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, maxSide);
  Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  paintOverlay(ctx, m, { x: 0, y: 0, w, h });
}
// The presenter's comparison card: in the pop-out presenter window when it's open, else the stack.
async function beamCard(p, m) {
  if (typeof m.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(m.image)) return;
  const pip = window.documentPictureInPicture?.window, doc = pip?.document ?? document;
  const holder = pip ? (doc.querySelector('.pip-cards') ?? doc.body.appendChild(Object.assign(doc.createElement('div'), { className: 'pip-cards' }))) : $('#notices');
  const el = doc.createElement('section');
  el.className = 'notice glass beam';
  el.setAttribute('role', 'status');
  el.innerHTML = `<header>${icon('history')}<div><b></b><small>Click the frame to compare it with your screen now.</small></div><button class="icon-btn" aria-label="Dismiss">${icon('x')}</button></header><button class="beam-thumb" aria-label="Compare with your screen now"><canvas></canvas></button>`;
  el.querySelector('b').textContent = `${p.name} is referencing your screen from ${m.ago}s ago`;
  await drawSnapshot(el.querySelector('canvas'), m, 380).catch(() => {});
  el.querySelector('.beam-thumb').onclick = () => openCompare(doc, p, m);
  el.querySelector('.icon-btn').onclick = () => el.remove();
  holder.prepend(el);
  chime(true);
}
function openCompare(doc, p, m) {
  doc.querySelector('.compare')?.remove();
  const box = doc.createElement('div');
  box.className = 'compare glass';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Compare a past frame with your screen now');
  box.innerHTML = `<header><b></b><button class="icon-btn" aria-label="Close comparison">${icon('x')}</button></header><div class="panes"><figure><canvas></canvas><figcaption></figcaption></figure><figure><video autoplay muted playsinline></video><figcaption></figcaption></figure></div>`;
  box.querySelector('b').textContent = `${p.name}’s reference vs. now`;
  const [then, now] = box.querySelectorAll('figcaption');
  then.textContent = `${m.ago}s ago · ${p.name}’s marks`;
  now.textContent = screenTrack ? 'Your screen now' : 'You’re not sharing right now';
  if (screenTrack) {
    const live = box.querySelector('video');
    live.srcObject = new MediaStream([screenTrack]);
    live.play().catch(() => {});
  }
  drawSnapshot(box.querySelector('canvas'), m, 1280).catch(() => {});
  const close = () => box.remove();
  box.querySelector('.icon-btn').onclick = close;
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  doc.body.append(box);
  box.querySelector('.icon-btn').focus();
}

// ---------- Snip a screen region onto the whiteboard ----------
function snip(p, { x0, y0, x1, y1 }) {
  const src = p.tmView ? p.tile.querySelector('.tm-frame') : p.video;
  const shot = cropToDataUrl(src, normRect(x0, y0, x1, y1));
  if (!shot) return toast('Couldn’t capture that region', 'scissors');
  const card = {
    cid: newId(), ...cardSlot(board.cards.size, shot.w / shot.h), image: shot.url,
    caption: `${p === L ? 'Your screen' : `${p.name}’s screen`} · ${clock()}${p.tmView ? ` · ${agoLabel(Date.now() - p.tmView.t)}` : ''}`,
  };
  inkApply(board, { op: 'card', ...card }, me.id);
  send({ type: 'ink', s: 'board', op: 'card', ...card });
  toast('Snipped to the whiteboard — press W to compare', 'scissors');
}

// ---------- Living anchors ----------
// Pins on a shared screen carry a 16×16 luma template of what they point at; every participant
// tracks it locally on the frames they see (~12 Hz), so pins follow scrolled or dragged content,
// dock at the edge as "Off-screen" while it's hidden, and re-lock when it returns.
const MAX_ANCHORS = 24; // ponytail: the 24 newest open pins per share are tracked; older ones stay where dropped
const lumaOf = (v) => readLuma(v, TRACK.width, Math.max(TRACK.patch, Math.round((TRACK.width * v.videoHeight) / v.videoWidth)));
function pinTemplate(video, x, y) {
  if (!video.videoWidth) return undefined;
  const tpl = capture(lumaOf(video), x, y);
  return tpl ? b64u.encode(tpl) : undefined; // flat spot: nothing to follow, the pin stays put
}
const sameSpot = (a, b) => a === b || (!!a && !!b && a.state === b.state && Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4);
function trackPins() {
  for (const p of all()) {
    const s = p.surface, v = p.video;
    if (!s?.pins.size || !p.state.screen || !v?.videoWidth) continue;
    const open = [...s.pins.values()].filter((pin) => pin.tpl && !pin.resolved).slice(-MAX_ANCHORS);
    if (!open.length) continue;
    const frame = lumaOf(v);
    for (const pin of open) {
      const a = track((pin.anchor ??= createAnchor(b64u.decode(pin.tpl), pin.x, pin.y)), frame);
      const live = a.state === 'occluded' ? { ...dock(a.x, a.y), state: 'occluded' } : a.state === 'locked' ? { x: a.x, y: a.y, state: 'locked' } : null;
      if (!sameSpot(pin.live, live)) { pin.live = live; s.dirty = true; }
    }
  }
}

// ---------- Proposed moves ----------
// "What if this were over there?": anyone allowed to annotate lifts a region of a shared screen
// and drops it elsewhere. Everyone — the presenter included, in the pop-out presenter window too —
// sees the live pixels at the new spot, a background plate where they were, and an arrow.
function proposeMove(p, box) {
  const patchId = newId();
  inkApply(p.surface, { op: 'patch', patchId, ...box, name: me.name }, me.id);
  send({ type: 'screen-patch', s: `share:${idOf(p)}`, op: 'add', patchId, ...box });
  p.inkAt = Date.now();
  toast(p === L ? 'Proposed move shown to everyone' : `Proposed move shown to ${p.name} and everyone else`, 'move');
}
function onPatch(sender, m) {
  const target = surfaceFor(m.s);
  if (!target?.owner) return;
  const { surface, owner } = target;
  if (m.op === 'remove') return inkApply(surface, { op: 'unpatch', patchId: m.patchId, force: sender === owner }, sender.id);
  if (sender !== owner && !(owner.state.screen && owner.state.ink)) return;
  inkApply(surface, { ...m, op: 'patch', name: sender.name }, sender.id);
  owner.inkAt = Date.now();
  flagDrawing(sender);
  if (owner === L) toast(`${sender.name} proposes moving part of your screen`, 'move');
}
function unpatch(p, patchId) { // my proposal, or any proposal on my screen: gone for everyone; otherwise just for me
  const pt = p.surface.patches.get(patchId);
  if (!pt) return;
  inkApply(p.surface, { op: 'unpatch', patchId, force: true }, me.id);
  if (pt.by === me.id || p === L) send({ type: 'screen-patch', s: `share:${idOf(p)}`, op: 'remove', patchId });
}

// ---------- Proof-of-Frame witness ----------
// While I share, every 2 s: digest the frame I'm sending (dHash layout + eHash detail, 128 bits),
// chain it to the last one, sign it with my ledger key, relay it. As a viewer: verify the signature
// and the chain, digest what my decoder shows, and badge the share "Witness Verified · Frame #N"
// when both bands agree.
const MAX_WITNESS_FRAMES = 5400; // ponytail: 3 h of frames per chain kept for the notes; older ones are dropped
const witnessChains = []; // every chain this tab signed or watched, for the notes
let witnessOut = null, witnessBusy = false, grabber = null;
const chainRecord = (name, fp, jwk, mine) => { const c = { name, fingerprint: fp, jwk, mine, frames: [], rejected: [] }; witnessChains.push(c); return c; };
const keep = (list, item) => { list.push(item); if (list.length > MAX_WITNESS_FRAMES) list.shift(); };
async function shareLuma() { // straight from the track, so it keeps working while my tab is in the background
  const [w, h] = WITNESS.read;
  if ('ImageCapture' in window) {
    try {
      if (grabber?.track !== screenTrack) grabber = new ImageCapture(screenTrack);
      const bmp = await grabber.grabFrame();
      try { return readLuma(bmp, w, h); } finally { bmp.close(); }
    } catch {}
  }
  return L.video?.videoWidth ? readLuma(L.video, w, h) : null;
}
// A share that is pure black usually means the OS refused screen capture (on macOS: Screen
// Recording permission) — the presenter would otherwise never know what the room sees.
let blackTicks = 0;
function blackShareCheck({ data }) {
  let max = 0;
  for (const v of data) if (v > max) max = v;
  blackTicks = max < 16 ? blackTicks + 1 : 0;
  if (blackTicks !== 2) return;
  toast(IS_MAC ? 'Your shared screen is coming through black. On a Mac: System Settings → Privacy & Security → Screen & System Audio Recording → allow Google Chrome, then restart Chrome.' : 'Your shared screen is coming through black — try sharing a different window or screen.', 'screen', 12000);
}
async function witnessTick() {
  if (!screenTrack || !me.id || witnessBusy) return;
  witnessBusy = true;
  try {
    const luma = await shareLuma();
    if (!luma || !screenTrack) return;
    blackShareCheck(luma);
    if (!identity) return; // signing needs WebCrypto (HTTPS or localhost)
    const out = (witnessOut ??= { last: null, rec: chainRecord(me.name, identity.fingerprint, identity.jwk, true) });
    const f = await signFrame(identity.privateKey, room, out.last, digest(luma), Date.now() - skew);
    if (witnessOut !== out) return; // the share ended meanwhile
    out.last = f;
    keep(out.rec.frames, f);
    send({ type: 'witness-frame', ...f });
    paintWitness(L);
  } finally {
    witnessBusy = false;
  }
}
function sampleShares() { // what each viewer actually displays, digested, for matching against signed frames
  const [w, h] = WITNESS.read, now = Date.now() - skew;
  for (const p of peers.values()) {
    if (!p.state.screen || !p.jwk || !p.video.videoWidth) continue;
    (p.samples ??= []).push({ t: now, digest: digest(readLuma(p.video, w, h)) });
    if (p.samples.length > 40) p.samples.shift();
  }
}
async function onWitness(p, m) {
  if (!p.jwk) return; // nothing to verify against yet
  p.wit ??= { last: null, misses: 0, rec: chainRecord(p.name, await fingerprint(p.jwk), p.jwk, false) }; // a new share starts a new chain (reset on share end)
  const w = p.wit, f = { seq: m.seq, t: m.t, digest: m.digest, prev: m.prev, chain: m.chain, sig: m.sig };
  const why = await checkFrame(p.jwk, room, f, w.last); // never take the server's word for it
  if (p.wit !== w) return;
  if (why !== 'ok') { keep(w.rec.rejected, { seq: f.seq, t: f.t, why }); return witnessState(p, 'invalid', f.seq, why); }
  w.last = f;
  const e = { ...f, seen: null, layout: null, detail: null, verdict: 'pending' };
  keep(w.rec.frames, e);
  if (!p.witState) witnessState(p, 'pending', f.seq);
  setTimeout(() => judge(p, w, e), Math.max(0, f.t + skew + WITNESS.window[1] - Date.now())); // once my decoder has shown it
}
function judge(p, w, e) {
  const near = (p.samples ?? []).filter((x) => x.t >= e.t + WITNESS.window[0] && x.t <= e.t + WITNESS.window[1]);
  if (!near.length) { e.verdict = 'unseen'; return; } // my tile wasn't decoding then
  const best = near.map((x) => ({ seen: x.digest, ...distance(e.digest, x.digest) })).reduce((a, b) => (b.layout + b.detail < a.layout + a.detail ? b : a));
  Object.assign(e, best, { verdict: sameFrame(best) ? 'valid' : 'mismatch' });
  if (p.wit !== w) return;
  w.misses = e.verdict === 'mismatch' ? w.misses + 1 : 0;
  if (e.verdict === 'valid') witnessState(p, 'verified', e.seq);
  else if (w.misses >= 2) witnessState(p, 'mismatch', e.seq); // one late frame isn't an alarm; two in a row is
}
function witnessState(p, state, seq, why) {
  const was = p.witState;
  Object.assign(p, { witState: state, witSeq: seq, witWhy: why });
  paintWitness(p);
  if (state === was) return;
  if (state === 'invalid') toast(`${p.name}’s screen: a frame failed verification (${why})`, 'alert', 6000);
  if (state === 'mismatch') toast(`${p.name}’s screen doesn’t match what they signed`, 'alert', 6000);
}
function paintWitness(p) {
  const b = p.tile?.querySelector('.witness');
  if (!b) return;
  const mine = p === L, state = mine ? (witnessOut?.last ? 'signing' : null) : p.state.screen ? p.witState : null;
  b.hidden = !state;
  if (!state) return;
  const seq = mine ? witnessOut.last.seq : p.witSeq;
  const text = { signing: `Signing frames · #${seq}`, pending: 'Witness pending…', verified: `Witness Verified · Frame #${seq}`, mismatch: `Frame Mismatch · #${seq}`, invalid: `Tamper detected · #${seq}` }[state];
  const detail = {
    signing: 'Every 2 s the frame you share is hashed, chained and signed with your device key; viewers check what they receive.',
    pending: 'Checking signed frames against what you see…',
    verified: `What you see matches the frame ${p.name} signed with their device key — compare safety codes to know the key is theirs.`,
    mismatch: `What you see differs from the frames ${p.name} signed.`,
    invalid: `A frame failed verification (${p.witWhy}).`,
  }[state];
  b.dataset.state = state;
  b.querySelector('span').textContent = text;
  b.querySelector('use').setAttribute('href', state === 'mismatch' || state === 'invalid' ? '#i-alert' : '#i-shield');
  b.title = `${detail} Click to save this frame as evidence.`;
  b.setAttribute('aria-label', `${text}. ${b.title}`);
}
async function saveEvidence(p) { // the exact pixels on screen, provable later against the signed chain
  const v = p.video;
  if (!v.videoWidth) return;
  const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight });
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  save(blob, `truemeet-frame-${stamp()}.png`);
  toast('Frame saved — prove it later: drop it with your notes on /verify.html', 'download');
}
async function witnessSection() {
  const chains = witnessChains.filter((c) => c.frames.length || c.rejected.length);
  if (!chains.length) return [];
  const signed = chains.filter((c) => c.frames.length);
  const witness = {
    version: 2, room, exportedAt: new Date().toISOString(),
    algorithm: 'digest = dHash-64 (9×8 luma cells) + eHash-64 (8×8 tile edge energy vs median) · chain = SHA-256(prev:seq:digest:t) · ECDSA P-256 + SHA-256 over canonical JSON {chain, digest, prev, room, seq, t}',
    chains: signed.map(({ name, fingerprint: fp, jwk, frames }) => ({
      name, fingerprint: fp, jwk,
      frames: frames.map(({ seq, t, digest: dig, prev, chain, sig, seen, layout, detail }) => ({ seq, t, digest: dig, prev, chain, sig, ...(seen && { seen, layout, detail }) })),
    })),
  };
  const check = await verifyWitness(witness);
  const lines = ['SCREEN WITNESS (every frame’s signature and chain link re-verified in this browser at export)'];
  for (const c of chains) {
    const verdicts = check.chains[signed.indexOf(c)]?.frames ?? [];
    lines.push(`${c.mine ? 'Your screen (frames you signed)' : `${c.name}’s screen`} · key ${c.fingerprint} · ${c.frames.length} signed frame${c.frames.length === 1 ? '' : 's'}`);
    c.frames.forEach((f, i) => {
      const word = !verdicts[i]?.valid ? 'INVALID' : c.mine ? 'SIGNED' : { valid: 'VALID', mismatch: 'MISMATCH', unseen: 'UNSEEN' }[f.verdict] ?? 'PENDING';
      lines.push(`    ${word.padEnd(8)} #${f.seq} · ${clockS(f.t + skew)} · digest ${f.digest}${f.seen ? ` · ${f.layout}/64 layout + ${f.detail}/64 detail bits from what you saw` : ''}`);
    });
    for (const r of c.rejected) lines.push(`    REJECTED #${r.seq} · ${clockS(r.t + skew)} · ${r.why}`);
  }
  if (!signed.length) return lines;
  return [...lines, '', `Machine-verifiable copy (drop these notes on ${location.origin}/verify.html, or use verifyWitness() from public/witness.js):`, WITNESS_BEGIN, JSON.stringify(witness, null, 2), WITNESS_END];
}

// ---------- Decision ledger ----------
function proposeFrom(text) {
  notice('propose', (el) => {
    el.classList.add('proposal');
    el.innerHTML = `<header>${icon('stamp')}<div><b>Turn this into a proposal</b><small>Everyone can sign it with their device key; signatures are verifiable in the exported notes.</small></div><button type="button" class="icon-btn" aria-label="Cancel">${icon('x')}</button></header><form><textarea maxlength="280" rows="3" aria-label="Proposal text" placeholder="What are we agreeing to?"></textarea><footer><button type="button" class="btn ghost xs">Cancel</button><button class="btn primary xs">Propose</button></footer></form>`;
    const ta = el.querySelector('textarea');
    ta.value = text.slice(0, 280);
    const close = () => el.remove();
    el.querySelector('.icon-btn').onclick = close;
    el.querySelector('footer .ghost').onclick = close;
    el.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const t = ta.value.trim();
      if (!t) return ta.focus();
      send({ type: 'proposal', text: t });
      close();
    };
    setTimeout(() => ta.focus());
  });
}
async function onProposal(m) {
  if (typeof m.proposalId !== 'string' || proposals.has(m.proposalId)) return;
  const prop = { proposalId: m.proposalId, text: String(m.text).slice(0, 280), timestamp: m.timestamp, roomCode: m.roomCode, proposer: String(m.name ?? '').slice(0, 40), signatures: new Map() };
  proposals.set(prop.proposalId, prop);
  prop.li = addNote('proposal', `Proposal · ${prop.proposer} · ${clock(prop.timestamp + skew)}`, prop.text);
  proposalCard(prop);
  if (!m.replay) chime(true);
}
async function onSigned(m) {
  const prop = proposals.get(m.proposalId);
  if (!prop || typeof m.fingerprint !== 'string' || prop.signatures.has(m.fingerprint)) return;
  // Never take the server's word for it: the key must be the one this person published, and the
  // signature must verify locally against the exact proposal we hold.
  const known = m.from === me.id ? identity?.jwk : peers.get(m.from)?.jwk;
  if (known && canonical(known) !== canonical(m.jwk)) return;
  if ((await fingerprint(m.jwk)) !== m.fingerprint || !(await verify(m.jwk, proposalPayload(prop), m.sig))) return;
  prop.signatures.set(m.fingerprint, { name: String(m.name).slice(0, 40), fingerprint: m.fingerprint, jwk: m.jwk, sig: m.sig, mine: m.fingerprint === identity?.fingerprint });
  prop.li?.querySelector('small') && (prop.li.querySelector('small').textContent = `Proposal · ${prop.proposer} · signed by ${[...prop.signatures.values()].map((x) => x.name).join(', ')}`);
  proposalCard(prop);
}
function proposalCard(prop) {
  if (prop.dismissed) return;
  const key = `prop-${prop.proposalId}`;
  const el = $(`#notices [data-key="${key}"]`) ?? notice(key, (e) => {
    e.classList.add('proposal');
    e.innerHTML = `<header>${icon('stamp')}<div><b></b><small></small></div><button class="icon-btn" aria-label="Hide proposal">${icon('x')}</button></header><blockquote></blockquote><p class="signers"></p><footer><button class="btn primary xs sign-btn">${icon('stamp')}<span>Sign &amp; Agree</span></button></footer>`;
    e.querySelector('.icon-btn').onclick = () => { prop.dismissed = true; e.remove(); };
    e.querySelector('.sign-btn').onclick = () => signProposal(prop);
  });
  el.querySelector('b').textContent = `Proposal by ${prop.proposer}`;
  el.querySelector('small').textContent = `${clock(prop.timestamp + skew)} · signed with each person’s device key`;
  el.querySelector('blockquote').textContent = prop.text;
  const signed = [...prop.signatures.values()], mine = signed.some((x) => x.mine);
  el.querySelector('.signers').textContent = signed.length ? `Signed by ${signed.map((x) => (x.mine ? 'you' : x.name)).join(', ')} · ${signed.length} of ${all().length} · every signature verified on this device` : 'No signatures yet';
  if (mine && !prop.retire) { // once your verified signature is in, the card steps aside (it stays in the notes)
    prop.retire = () => (el.matches(':hover, :focus-within') ? setTimeout(prop.retire, 4000) : (prop.dismissed = true, el.remove()));
    setTimeout(prop.retire, 6000);
  }
  const btn = el.querySelector('.sign-btn');
  btn.disabled = mine || !!prop.signing;
  btn.querySelector('span').textContent = mine ? 'Signed' : prop.signing ? 'Signing…' : 'Sign & Agree';
}
async function signProposal(prop) {
  if (!identity) return toast('Signing needs a secure page (HTTPS or localhost)', 'stamp');
  prop.signing = true;
  proposalCard(prop);
  send({ type: 'proposal-sign', proposalId: prop.proposalId, sig: await sign(identity.privateKey, proposalPayload(prop)) });
  prop.signing = false; // the card updates when the server's verified echo arrives
}
async function ledgerSection() {
  if (!proposals.size) return [];
  const ledger = {
    version: 1, room, exportedAt: new Date().toISOString(),
    algorithm: 'ECDSA P-256 + SHA-256 over canonical JSON {proposalId, roomCode, text, timestamp}',
    proposals: [...proposals.values()].map(({ proposalId, text, timestamp, roomCode, proposer, signatures }) => ({
      proposalId, text, timestamp, roomCode, proposer,
      signatures: [...signatures.values()].map(({ name, fingerprint: fp, jwk, sig }) => ({ name, fingerprint: fp, jwk, sig })),
    })),
  };
  const check = await verifyLedger(ledger);
  const lines = ['DECISION LEDGER (every signature re-verified in this browser at export)'];
  ledger.proposals.forEach((x, i) => {
    lines.push(`[${clock(x.timestamp + skew)}] Proposal by ${x.proposer}: “${x.text}”`);
    if (!x.signatures.length) lines.push('    (no signatures)');
    for (const sig of check.proposals[i].signatures) lines.push(`    ${sig.valid ? 'VALID  ' : 'INVALID'} ${sig.name} · key ${sig.fingerprint}`);
  });
  return [...lines, '', 'Machine-verifiable copy (check it with verifyLedger() from public/ledger.js):', LEDGER_BEGIN, JSON.stringify(ledger, null, 2), LEDGER_END];
}

// ---------- Polite turn engine ----------
function showTurnQueue(order) {
  if (!Array.isArray(order)) return;
  const names = order.map((id) => (id === me.id ? 'you' : peers.get(id)?.name)).filter(Boolean);
  if (names.length < 2) return;
  toast(`Collision detected — ${names[0]} go ahead, then ${names.slice(1).join(', then ')}`, 'users', 5000).classList.add('turn');
}
function nudgeCard(p) {
  notice(`nudge-${p.id}`, (el) => {
    el.innerHTML = `<header>${icon('hand')}<div><b></b><small>Only you see this.</small></div></header><footer><button class="btn ghost xs">Not now</button><button class="btn primary xs">Invite to speak</button></footer>`;
    el.querySelector('b').textContent = `${p.name} tried to jump in — invite them to speak?`;
    const [no, yes] = el.querySelectorAll('button');
    no.onclick = () => el.remove();
    yes.onclick = () => { send({ type: 'nudge', target: p.id }); el.remove(); toast(`Invited ${p.name} to speak`, 'hand'); };
    setTimeout(() => el.remove(), 20_000);
  });
}
function nudged(name) {
  notice('nudged', (el) => {
    el.innerHTML = `<header>${icon('mic')}<div><b></b><small>The floor is yours.</small></div></header><footer><button class="btn ghost xs">Not now</button><button class="btn primary xs">Unmute</button></footer>`;
    el.querySelector('b').textContent = `${String(name).slice(0, 40)} invites you to speak`;
    const [no, yes] = el.querySelectorAll('button');
    no.onclick = () => el.remove();
    yes.onclick = () => { if (!me.mic) toggleMic(); el.remove(); };
    setTimeout(() => el.remove(), 20_000);
  });
}

// ---------- Time-travel catch-up ----------
function renderCatchup(m) {
  const marks = [], lines = [];
  for (const c of Array.isArray(m.captions) ? m.captions : []) {
    if (typeof c?.text !== 'string' || seenNid(c.nid)) continue;
    addEntry('#transcript', transcript, String(c.name).slice(0, 40), c.text.slice(0, 500), false, c.t + skew);
    lines.push(c);
  }
  for (const h of Array.isArray(m.highlights) ? m.highlights : []) {
    if (!h || seenNid(h.nid)) continue;
    const entry = { name: h.auto ? 'Auto-Mode' : String(h.name).slice(0, 40), context: String(h.context ?? '').slice(0, 200), auto: !!h.auto, reason: String(h.reason ?? ''), t: h.t + skew };
    addMark(entry);
    marks.push(entry);
  }
  const nothing = !marks.length && !lines.length;
  if (nothing && (caughtUp || m.now - m.started < 30_000)) return; // nothing worth a card (fresh meeting or reconnect)
  caughtUp = true;
  notice('catchup', (el) => {
    el.classList.add('catchup');
    el.innerHTML = `<header>${icon('history')}<div><b>Catch up</b><small></small></div><button class="icon-btn" aria-label="Dismiss catch-up">${icon('x')}</button></header>
      <h3>Key moments</h3><ul class="cu-marks"></ul><h3>Recent conversation</h3><ul class="cu-lines"></ul>
      <footer><button class="btn ghost xs cu-board">${icon('board')}Open whiteboard</button><button class="btn primary xs cu-notes">${icon('captions')}View notes</button></footer>`;
    el.querySelector('small').textContent = `You joined ${duration(Math.max(0, m.now - m.started))} into the meeting${m.openPins ? ` · ${m.openPins} open pin${m.openPins > 1 ? 's' : ''}` : ''}`;
    const fill = (sel, items, empty, row) => {
      const ul = el.querySelector(sel);
      if (!items.length) return ul.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: empty }));
      for (const x of items) {
        const [lead, body] = row(x);
        const li = document.createElement('li');
        li.append(Object.assign(document.createElement('b'), { textContent: lead }), ` ${body}`);
        ul.append(li);
      }
    };
    fill('.cu-marks', marks.slice(-5), 'Nothing marked yet.', (h) => [`+${duration(Math.max(0, h.t - started))}`, `${h.auto ? `[Auto · ${h.reason}]` : `${h.name}:`} ${h.context || 'Moment marked'}`]);
    fill('.cu-lines', lines.slice(-4), 'No captions yet — anyone can turn them on with L.', (c) => [`${String(c.name).slice(0, 40)}:`, c.text.slice(0, 160)]);
    el.querySelector('.icon-btn').onclick = () => el.remove();
    const expire = () => (el.matches(':hover, :focus-within') ? setTimeout(expire, 10_000) : el.remove());
    setTimeout(expire, 60_000); // a notification, not a wall: it steps aside after a minute
    el.querySelector('.cu-board').onclick = () => { setBoard(true); el.remove(); };
    el.querySelector('.cu-notes').onclick = () => { setPanel('notes'); el.remove(); };
  });
}
async function downloadNotes() {
  if (!transcript.length && !chatLog.length && !highlights.length && !pinLog.size && !proposals.size && !witnessChains.length) return toast('Nothing yet — turn on live captions, chat, drop a pin or mark a highlight');
  const line = (x) => `[${clock(x.t)}] ${x.name}: ${x.text}${x.tr ? `\n          → ${x.tr}${x.trVia === 'dictionary' ? '  (≈ dictionary)' : ''}` : ''}`;
  const hl = (x) => `[+${duration(Math.max(0, x.t - started))}${x.rec != null ? ` · rec ${duration(x.rec)}` : ''}] ${x.auto ? `[Auto] ${x.reason}` : x.name}${x.context ? ` — ${x.context}` : ''}`;
  const pin = (x) => `#${x.n} · ${x.name} · ${clock(x.t)} · ${x.label}${x.note ? ` — “${x.note}”` : ''}${x.resolved ? ` (resolved by ${x.resolvedBy})` : ''}`;
  const text = [
    `TrueMeet · ${room} · ${new Date(started).toLocaleString()}`, '',
    'HIGHLIGHTS', ...highlights.toSorted((a, b) => a.t - b.t).map(hl), '',
    'PINS', ...[...pinLog.values()].map(pin), '',
    'TRANSCRIPT', ...transcript.map(line), '',
    'CHAT', ...chatLog.map(line), '',
    ...(await ledgerSection()), '',
    ...(await witnessSection()),
  ].join('\n');
  save(new Blob([text], { type: 'text/plain' }), `truemeet-${room}-${stamp()}.txt`);
}
function burst(p, emoji) {
  const f = document.createElement('span');
  f.className = 'floater';
  f.style.left = `${6 + Math.random() * 22}%`;
  f.append(emoji, Object.assign(document.createElement('small'), { textContent: p === L ? 'You' : p.name }));
  $('#floaters').append(f);
  setTimeout(() => f.remove(), 3300);
  const b = p.tile?.querySelector('.react');
  if (!b) return;
  b.textContent = emoji;
  b.classList.remove('pop');
  void b.offsetWidth; // restart the animation
  b.classList.add('pop');
}

// ---------- Ink: whiteboard + screen annotation ----------
const board = createSurface($('#boardCanvas'), fixedRect(16, 9), BOARD_BG, $('#boardPins'));
board.onPin = (pid, el) => openPinCard(board, 'board', pid, el);
bindPointer(board, {
  tool: () => boardTool,
  color: () => boardColor,
  me: () => me.id,
  emit: (m) => send({ type: 'ink', s: 'board', ...m }),
  onStroke: (st) => st.tool === 'pen' && boardMine.push(st.sid),
  onPinDrop: (x, y) => openPinEditor(board, 'board', x, y, boardColor),
});
function surfaceFor(s) {
  if (s === 'board') return { surface: board, owner: null };
  const owner = s === `share:${me.id}` ? L : peers.get(String(s).slice(6));
  return owner?.surface ? { surface: owner.surface, owner } : null;
}
function onInk(sender, m) {
  const target = surfaceFor(m.s), by = idOf(sender);
  if (!target) return;
  const { surface, owner } = target;
  if (owner && sender !== owner && m.op !== 'resolve' && !(owner.state.screen && owner.state.ink)) return; // annotation only while the sharer allows it
  if (m.op === 'sync' && by !== host) return; // only the host seeds late joiners
  inkApply(surface, { ...m, all: m.op === 'clear' && m.all && (!owner || sender === owner) }, m.op === 'pin' ? m.by ?? by : by);
  if (m.op === 'pin' || m.op === 'resolve') logPin(m, sender);
  if (m.replay) return;
  const activity = m.op === 'pts' || m.op === 'pin' || m.op === 'card';
  if (activity && owner) owner.inkAt = Date.now(); // annotation keeps a share in the spotlight (incl. my own pin echoes)
  if (sender === L) return;
  if (!owner && m.op === 'clear' && m.all) toast(`${sender.name} cleared the whiteboard`, 'eraser');
  if (!activity) return;
  flagDrawing(sender);
  if (!owner) boardActivity(sender, m.op === 'card');
}
function boardActivity(sender, snipped = false) {
  boardAt = Date.now();
  if (!$('#board').hidden) return;
  if (me.auto && Date.now() - boardClosedAt > 15_000) return setBoard(true, true); // Auto-Mode follows the action
  $('#boardBtn .dot').hidden = false;
  if (snipped) return toast(`${sender.name} snipped a screen region onto the whiteboard — press W to see it`, 'scissors');
  if (!boardNoticed) { boardNoticed = true; toast(`${sender.name} is drawing on the whiteboard — press W to open it`, 'board'); }
}
const surfaceLabel = (s) => (s === 'board' ? 'whiteboard' : s === `share:${me.id}` ? 'your screen' : `${peers.get(s.slice(6))?.name ?? 'a shared'}’s screen`);
function logPin(m, sender) {
  if (m.op === 'resolve') {
    const e = pinLog.get(m.pid);
    if (!e || e.resolved) return;
    Object.assign(e, { resolved: true, resolvedBy: sender.name });
    e.li?.classList.add('resolved');
    e.li?.querySelector('small').append(` · resolved by ${sender.name}`);
    return;
  }
  if (!Number.isInteger(m.n)) return; // optimistic local copy: the server's numbered echo gets logged
  const fresh = !pinLog.has(m.pid);
  const e = Object.assign(pinLog.get(m.pid) ?? {}, {
    n: m.n, name: String(m.name ?? sender.name).slice(0, 40), note: String(m.note ?? '').slice(0, 140),
    label: surfaceLabel(m.s), t: (Number(m.t) || Date.now() - skew) + skew, resolved: !!m.resolved, resolvedBy: m.resolvedBy,
  });
  pinLog.set(m.pid, e);
  if (!fresh) return;
  e.li = addNote('pin', `Pin #${e.n} · ${e.name} · ${e.label}${e.resolved ? ' · resolved' : ''}`, e.note || 'No note');
  if (sender !== L && !m.replay) toast(`${e.name} dropped pin #${e.n}${e.note ? ` — ${e.note.slice(0, 60)}` : ''}`, 'pin-drop');
}

// Pin drop + pin card. Both are built inside the surface's own document, so they also work in the
// pop-out presenter window. Notes are only ever inserted as text.
function closePinPop() { pinPop?.remove(); pinPop = null; }
function placePop(el, box, px, py) {
  el.style.left = `${Math.max(8, Math.min(px + 16, box.clientWidth - 260))}px`;
  el.style.top = `${Math.max(8, Math.min(py - 18, box.clientHeight - 120))}px`;
}
function openPinEditor(surface, s, x, y, color, tpl) {
  closePinPop();
  const box = surface.canvas.parentElement, r = surface.rect(surface.canvas.clientWidth, surface.canvas.clientHeight);
  if (!r) return;
  const form = (pinPop = box.ownerDocument.createElement('form'));
  form.className = 'pin-pop glass';
  form.innerHTML = '<input maxlength="140" placeholder="Add a note (optional)" aria-label="Pin note" autocomplete="off"><button class="btn primary xs">Drop pin</button>';
  placePop(form, box, r.x + x * r.w, r.y + y * r.h);
  box.append(form);
  const input = form.querySelector('input');
  input.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const pid = newId(), note = input.value.trim().slice(0, 140);
    if (s === null) inkApply(surface, { op: 'pin', pid, x, y, note, color, name: me.name, n: surface.pins.size + 1 }, me.id); // private, until beamed
    else {
      inkApply(surface, { op: 'pin', pid, x, y, note, color, name: me.name, tpl }, me.id);
      send({ type: 'ink', s: typeof s === 'function' ? s() : s, op: 'pin', pid, x, y, note, color, ...(tpl && { tpl }) });
    }
    closePinPop();
  };
  form.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePinPop(); } };
}
function openPinCard(surface, s, pid, el) {
  closePinPop();
  const pin = surface.pins.get(pid), key = typeof s === 'function' ? s() : s;
  if (!pin) return;
  const box = surface.canvas.parentElement, card = (pinPop = box.ownerDocument.createElement('div'));
  card.className = 'pin-pop glass card';
  card.setAttribute('role', 'dialog');
  card.innerHTML = '<small></small><p></p><div class="pin-actions"></div>';
  card.setAttribute('aria-label', `Pin ${pin.n ?? ''}`);
  card.querySelector('small').textContent = `#${pin.n ?? '…'} · ${pin.name} · ${clock(pin.t + (pin.n ? skew : 0))}`;
  card.querySelector('p').textContent = pin.note || 'No note';
  const actions = card.querySelector('.pin-actions');
  const owner = key === 'board' || key == null ? null : key.slice(6);
  if (key == null) { // a private mark on a rewound frame
    actions.append(Object.assign(box.ownerDocument.createElement('button'), {
      className: 'btn primary xs', textContent: 'Remove',
      onclick: () => { inkApply(surface, { op: 'resolve', pid }, me.id); closePinPop(); },
    }));
  } else if (pin.n && (pin.by === me.id || owner === me.id || (key === 'board' && host === me.id))) {
    actions.append(Object.assign(box.ownerDocument.createElement('button'), {
      className: 'btn primary xs', textContent: 'Resolve',
      onclick: () => { send({ type: 'ink', s: key, op: 'resolve', pid }); closePinPop(); },
    }));
  }
  actions.append(Object.assign(box.ownerDocument.createElement('button'), { className: 'btn ghost xs', textContent: 'Close', onclick: closePinPop }));
  placePop(card, box, el.offsetLeft, el.offsetTop);
  box.append(card);
}
function syncBoard(to) {
  // Seed a late joiner with the board in chunks that stay well under the server's body limit.
  let chunk = [], size = 0;
  const flush = () => { if (chunk.length) send({ type: 'ink', s: 'board', op: 'sync', to, strokes: chunk }); chunk = []; size = 0; };
  for (const st of penStrokes(board)) {
    chunk.push(st);
    size += st.pts.length * 7 + 120;
    if (size > 150_000) flush();
  }
  flush();
  for (const card of boardCards(board)) send({ type: 'ink', s: 'board', op: 'card', to, ...card }); // one image per message
}
function setBoard(open, auto = false) {
  $('#board').hidden = !open;
  if (open) $('#boardBtn .dot').hidden = true;
  else boardClosedAt = Date.now();
  boardAuto = open && auto; // only boards Auto-Mode opened get closed by Auto-Mode
  board.dirty = true;
  paintControls();
}
const toggleBoard = () => setBoard($('#board').hidden);
function paintBoardTools() {
  document.querySelectorAll('[data-board-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.boardTool === boardTool)));
  document.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === boardColor)));
}
function setInkTool(t) {
  inkTool = t || null;
  for (const p of all()) { p.surface?.cancelLift?.(); paint(p); }
}

// ---------- Rendering ----------
function makeTile(p, local = false) {
  const t = $('#tileTpl').content.firstElementChild.cloneNode(true);
  p.tile = t;
  p.video = t.querySelector('video');
  p.video.muted = local;
  t.classList.toggle('local', local);
  t.querySelector('.avatar').style.setProperty('--hue', hue(p.name));
  t.querySelector('.avatar span').textContent = initials(p.name);
  t.querySelector('.name').textContent = local ? `${p.name} (You)` : p.name;
  const pin = () => { pinned = pinned === p.id ? null : p.id; layout(); };
  t.querySelector('.pin').onclick = pin;
  t.ondblclick = (e) => !inkTool && pin(e);
  t.style.viewTransitionName = `tile-${newId()}`;
  if (!CAPS.popout) t.querySelector('.ink-pop').hidden = true;
  p.surface = createSurface(t.querySelector('.ink'), containRect(p.video), null, t.querySelector('.pins'));
  p.surface.media = p.video;
  p.surface.onPin = (pid, el) => openPinCard(p.surface, () => `share:${idOf(p)}`, pid, el);
  p.surface.onUnpatch = (patchId) => unpatch(p, patchId);
  bindPointer(p.surface, {
    tool: () => (p.state.screen && (p.state.ink || p === L) ? inkTool : null),
    color: myInk,
    me: () => me.id,
    emit: (m) => { p.inkAt = Date.now(); send({ type: 'ink', s: `share:${idOf(p)}`, ...m }); },
    onPinDrop: (x, y) => openPinEditor(p.surface, () => `share:${idOf(p)}`, x, y, myInk(), pinTemplate(p.video, x, y)), // template from the frame clicked
    onSnip: (r) => snip(p, r),
    onPatch: (box) => proposeMove(p, box),
  });
  // Rewound frames get their own private ink layer: marks there are never sent, only beamed.
  p.past = createSurface(t.querySelector('.ink-past'), containRect(t.querySelector('.tm-frame')), null, t.querySelector('.pins-past'));
  p.past.onPin = (pid, el) => openPinCard(p.past, null, pid, el);
  bindPointer(p.past, {
    tool: () => (p.tmView && inkTool !== 'move' ? inkTool : null), // a proposed move needs the live screen
    color: myInk,
    me: () => me.id,
    emit: () => {},
    onPinDrop: (x, y) => openPinEditor(p.past, null, x, y, myInk()),
    onSnip: (r) => snip(p, r),
  });
  t.querySelector('.tm-range').addEventListener('input', (e) => scrub(p, Number(e.target.value)));
  t.querySelector('.tm-live').onclick = () => jumpLive(p);
  t.querySelector('.tm-beam').onclick = () => beam(p);
  t.querySelector('.witness').onclick = () => saveEvidence(p);
  const wb = t.querySelector('.whisper-btn'); // hold to whisper (pointer, or Space/Enter on the focused button)
  wb.addEventListener('pointerdown', (e) => { e.preventDefault(); wb.setPointerCapture(e.pointerId); startWhisper(p); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) wb.addEventListener(type, () => stopWhisper(p));
  wb.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startWhisper(p); } });
  wb.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopWhisper(p); });
  t.addEventListener('pointerenter', () => (hoverTile = p));
  t.addEventListener('pointerleave', () => { if (hoverTile === p) hoverTile = null; });
  t.querySelector('.ink-tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('ink' in b.dataset) setInkTool(b.dataset.ink);
    else if (b.classList.contains('ink-clear')) {
      const everyone = p === L; // the sharer clears everything, viewers clear their own marks
      inkApply(p.surface, { op: 'clear', all: everyone }, me.id);
      send({ type: 'ink', s: `share:${idOf(p)}`, op: 'clear', all: everyone });
    } else if (b.classList.contains('ink-allow')) {
      me.ink = !me.ink;
      if (!me.ink) L.surface.strokes.clear();
      L.surface.dirty = true;
      syncState();
      toast(me.ink ? 'Viewers can annotate your screen' : 'Annotation turned off for viewers', 'pencil');
    } else if (b.classList.contains('ink-pop')) popOut(L);
  });
  $('#stage').append(t);
}
function paint(p) {
  const t = p.tile, s = p.state;
  if (!t) return;
  const inkOk = !!(s.screen && s.ink);
  t.classList.toggle('cam-off', !s.cam && !s.screen);
  t.classList.toggle('muted', !s.mic);
  t.classList.toggle('hand', !!s.hand);
  t.classList.toggle('screen', !!s.screen);
  t.classList.toggle('ink-ok', inkOk || (p === L && !!s.screen));
  t.classList.toggle('annotating', (inkOk || !!p.tmView) && !!inkTool);
  t.classList.toggle('whisper', whisperTo === p.id || whisperFrom.has(p.id) || (p === L && (!!whisperTo || whisperFrom.size > 0)));
  t.classList.toggle('verified', !!p.verified);
  t.querySelectorAll('[data-ink]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.ink || null) === inkTool)));
  t.querySelector('.ink-allow')?.setAttribute('aria-pressed', String(!!me.ink));
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let stageFocus, gliding = false;
function layout() {
  if (!L.tile) return;
  const list = all().filter((p) => p.tile.ownerDocument === document); // popped-out tiles stay in their window
  const sharer = [...peers.values()].find((p) => p.state.screen); // only remote shares take the stage (no hall of mirrors)
  const auto = me.auto && list.some((p) => p.id === autoFocusId) ? autoFocusId : null; // Auto-Mode stages only the director's dwelled choice
  const manual = sharer?.id ?? (view === 'speaker' ? active ?? list[1]?.id : null);
  const focus = list.length < 2 ? null : pinned ?? (me.auto ? auto : manual);
  const place = () => {
    $('#room').classList.toggle('speaker', !!focus);
    for (const p of list) {
      const box = focus && p.id !== focus ? $('#strip') : $('#stage');
      if (p.tile.parentElement !== box) box.append(p.tile);
      p.tile.classList.toggle('pinned', pinned === p.id);
    }
    fit();
    $('#alone').hidden = peers.size > 0;
    $('#viewBtn use').setAttribute('href', view === 'speaker' ? '#i-speaker' : '#i-grid');
    $('#viewBtn span').textContent = view === 'speaker' ? 'Speaker' : 'Gallery';
  };
  const moved = stageFocus !== undefined && focus !== stageFocus;
  stageFocus = focus;
  if (!moved || gliding || !CAPS.transitions || document.hidden || reducedMotion.matches) return place();
  // Every change of who holds the stage glides: tiles morph from their old box to the new one.
  gliding = true;
  const vt = document.startViewTransition(place);
  vt.ready.catch(() => {}); // a skipped transition (e.g. tab hidden mid-way) is fine, not an error
  vt.finished.catch(() => {}).finally(() => { gliding = false; });
}
function fit() {
  // Largest 16:9 tile size that fits every stage tile into the available area.
  const st = $('#stage'), n = st.children.length, gap = 12;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    best = Math.max(best, Math.min((st.clientWidth - gap * (cols - 1)) / cols, ((st.clientHeight - gap * (rows - 1)) / rows) * 16 / 9));
  }
  st.style.setProperty('--tile-w', `${Math.floor(best)}px`);
}
function renderPeople() {
  const ul = $('#peopleList');
  ul.replaceChildren();
  const list = all().sort((a, b) => !!b.state.hand - !!a.state.hand);
  for (const p of list) {
    const id = idOf(p);
    const li = document.createElement('li');
    li.innerHTML = `<div class="row-main"><span class="avatar sm" style="--hue:${hue(p.name)}"><span></span></span><span class="who"></span><span class="icons">${
      p.verified ? icon('shield') : ''}${p.state.hand ? icon('hand') : ''}${id && id === host ? icon('crown') : ''}${p.state.mic ? '' : icon('mic-off')}${p.state.cam || p.state.screen ? '' : icon('video-off')}</span></div>`;
    li.querySelector('.avatar span').textContent = initials(p.name);
    li.querySelector('.who').textContent = p === L ? `${p.name} (You)` : p.name;
    const main = li.firstElementChild;
    if (p !== L) {
      const v = Object.assign(document.createElement('button'), { className: 'btn ghost xs', textContent: p.verified ? 'Verified' : 'Verify' });
      v.onclick = async () => { p.code ??= await safetyCode(p); p.showCode = !p.showCode; renderPeople(); };
      main.append(v);
    }
    if (host === me.id && p !== L) {
      const b = Object.assign(document.createElement('button'), { className: 'btn ghost xs', textContent: 'Remove' });
      b.onclick = () => (b.textContent === 'Confirm' ? send({ type: 'kick', target: p.id }) : (b.textContent = 'Confirm'));
      main.append(b);
    }
    if (p.showCode) {
      const box = document.createElement('div');
      box.className = 'code';
      box.innerHTML = '<span>Safety code</span><b class="mono"></b><p></p>';
      box.querySelector('b').textContent = p.code ?? 'Connecting…';
      box.querySelector('p').textContent = `Read it aloud. If ${p.name}’s screen shows the same code, nobody is intercepting your call.`;
      if (p.code && !p.verified) {
        const ok = Object.assign(document.createElement('button'), { className: 'btn primary xs', textContent: 'It matches' });
        ok.onclick = () => { p.verified = true; p.showCode = false; paint(p); renderPeople(); toast(`Connection with ${p.name} verified`, 'shield'); };
        box.append(ok);
      }
      li.append(box);
    }
    ul.append(li);
  }
  $('#peopleCount').textContent = list.length;
  paintTlStatus(); // who's here decides which caption languages need translating
  $('#hostTools').hidden = !me.id || host !== me.id;
  renderTalk();
}
function renderTalk() {
  // Talk-time balance, measured locally from audio levels (no data leaves this browser); host only.
  const box = $('#talkTime');
  box.hidden = !me.id || host !== me.id || !all().some((p) => p.talk > 0);
  if (box.hidden) return;
  const list = all().sort((a, b) => b.talk - a.talk), total = list.reduce((n, p) => n + p.talk, 0) || 1;
  box.querySelector('ul').replaceChildren(...list.map((p) => {
    const li = document.createElement('li'), pct = Math.round((p.talk / total) * 100);
    li.innerHTML = '<span class="who"></span><span class="bar"><i></i></span><span class="mono"></span>';
    li.querySelector('.who').textContent = p === L ? 'You' : p.name;
    li.querySelector('i').style.width = `${pct}%`;
    li.querySelector('.mono').textContent = `${pct}% · ${duration(p.talk)}`;
    return li;
  }));
}
function renderKnocks() {
  $('#knocks').replaceChildren(...[...knocks.values()].map((k) => {
    const card = document.createElement('div');
    card.className = 'knock glass';
    card.innerHTML = `<span class="avatar sm" style="--hue:${hue(k.name)}"><span></span></span><span class="who"></span><button class="btn ghost xs">Deny</button><button class="btn primary xs">Admit</button>`;
    card.querySelector('.avatar span').textContent = initials(k.name);
    card.querySelector('.who').textContent = `${k.name} wants to join`;
    const [deny, admit] = card.querySelectorAll('button');
    deny.onclick = () => { send({ type: 'deny', target: k.id }); knocks.delete(k.id); renderKnocks(); };
    admit.onclick = () => { send({ type: 'admit', target: k.id }); knocks.delete(k.id); renderKnocks(); };
    return card;
  }));
}
function paintLock() {
  $('#lockChip').hidden = !locked;
  $('#lockBtn span').textContent = locked ? 'Unlock' : 'Lock';
  $('#lockBtn use').setAttribute('href', locked ? '#i-unlock' : '#i-lock');
  $('#waitToggle').checked = waitingRoom;
  $('#waitChip').hidden = !waitingRoom;
}
function paintRec() {
  const who = all().filter((p) => p.state.rec).map((p) => (p === L ? 'You' : p.name));
  $('#recChip').hidden = !who.length;
  $('#recChip').title = `Recording: ${who.join(', ')}`;
}
function setPanel(next) {
  $('#panel').hidden = !next;
  if (next) {
    tab = next;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((el) => (el.hidden = el.id !== `tab-${tab}`));
    if (tab === 'chat') { unread = 0; $('#unread').hidden = true; $('#chatInput').focus(); }
  }
  $('#chatBtn').classList.toggle('on', next === 'chat');
  $('#peopleBtn').classList.toggle('on', next === 'people');
}
const togglePanel = (t) => setPanel(!$('#panel').hidden && tab === t ? null : t);

// Presenter view: a floating always-on-top window (Document Picture-in-Picture) with a live tile,
// including viewers' laser pointers and drawings, visible while you present another app.
async function popOut(p = me.screen ? L : peers.get(active) ?? peers.values().next().value ?? L) {
  const dpip = window.documentPictureInPicture;
  if (!CAPS.popout) return toast('Pop-out isn’t supported in this browser', 'pip');
  if (!dpip) {
    try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await p.video.requestPictureInPicture(); }
    catch { toast('Pop-out needs someone with video on', 'pip'); }
    return;
  }
  if (dpip.window) return dpip.window.close();
  let w;
  try { w = await dpip.requestWindow({ width: 560, height: 340 }); } catch { return toast('Couldn’t open the presenter window — click the button again', 'pip'); }
  w.document.head.append(...[...document.querySelectorAll('link[rel="stylesheet"]')].map((n) => n.cloneNode()));
  w.document.body.className = 'pip';
  w.document.body.append($('body > svg').cloneNode(true), p.tile);
  p.video.play().catch(() => {});
  w.addEventListener('pagehide', () => {
    if (L.tile === p.tile || peers.get(p.id)?.tile === p.tile) { $('#stage').append(p.tile); p.video.play().catch(() => {}); }
    layout();
  });
  layout();
}

// ---------- Flow ----------
const newCode = () => {
  const abc = 'bcdfghjkmnpqrstvwxz'; // no vowels, so codes never spell words
  const part = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
};
function go(path) { history.pushState(null, '', path); route(); }
function route() {
  const code = location.pathname.slice(1).toLowerCase();
  if (/^[a-z0-9-]{3,40}$/.test(code)) return openLobby(code);
  stopMedia();
  show('home');
}
async function openLobby(code) {
  if (code !== room) {
    transcript.length = chatLog.length = highlights.length = 0;
    seen.clear();
    pinLog.clear();
    $('#chatList').replaceChildren();
    $('#transcript').replaceChildren();
    board.strokes.clear();
    board.pins.clear();
    board.cards.clear();
    proposals.clear();
    witnessChains.length = 0;
  }
  room = code;
  show('lobby');
  $('#lobbyRoom').textContent = code;
  $('#roomName').textContent = code;
  $('#roomTitle').textContent = `Meeting ${code}`;
  $('#name').value ||= store.get('truemeet-name') ?? '';
  joining(false);
  caughtUp = false;
  $('#lobbyErr').textContent = window.isSecureContext ? '' : 'Camera and microphone need HTTPS (or localhost).';
  if (!micTrack && !camTrack) await initMedia();
  await fillDevices();
  renderLocal();
  paintControls();
}
function enterRoom() {
  started = Date.now();
  L.talk = 0;
  show('room');
  makeTile(L, true);
  renderLocal();
  setPanel(null);
}
function leave(reason = 'You left the meeting') {
  if (!L.tile) return;
  stopWhisper();
  whisperFrom.clear();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  voiceDuck = 0;
  me.id = null; // stop sending before tearing down
  chime(false);
  window.documentPictureInPicture?.window?.close();
  es?.close();
  es = null;
  resetPeers();
  if (recorder?.state === 'recording') recorder.stop();
  if (recognizer) { const r = recognizer; recognizer = null; r.stop(); }
  stopShare();
  stopMedia();
  L.tile.remove();
  dropSurface(L.surface);
  L.tile = L.video = L.surface = null;
  pinned = active = inkTool = null;
  stageFocus = undefined; // the next meeting starts without an entrance glide
  me.hand = false;
  knocks.clear();
  renderKnocks();
  closePinPop();
  $('#notices').replaceChildren();
  $('#copilot').replaceChildren();
  autoFocusId = null;
  setBoard(false);
  $('#endTitle').textContent = reason;
  $('#endMeta').textContent = `${room} · ${duration(Date.now() - started)}`;
  $('#endNotes').hidden = !transcript.length && !chatLog.length && !highlights.length && !witnessChains.length;
  show('end');
}

// ---------- Recording ----------
async function toggleRecord() {
  if (recorder) return recorder.stop();
  let display;
  try { display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' }); }
  catch (e) { if (e instanceof TypeError) toast('Recording isn’t supported on this device'); return; }
  ac ??= new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  mix = { add: (t) => ac.createMediaStreamSource(new MediaStream([t])).connect(dest) }; // everyone's audio, mixed locally
  [micTrack, ...[...peers.values()].flatMap((p) => p.stream.getAudioTracks())].filter(Boolean).forEach(mix.add);
  const type = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const r = (recorder = new MediaRecorder(new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: type, videoBitsPerSecond: 4_000_000 }));
  const chunks = []; // ponytail: buffered in memory; stream to disk via the File System Access API for multi-hour recordings
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = () => {
    display.getTracks().forEach((t) => t.stop());
    save(new Blob(chunks, { type: r.mimeType }), `truemeet-${room}-${stamp()}.${r.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
    recorder = mix = null;
    me.rec = false;
    syncState();
    toast('Recording saved to your downloads', 'download');
  };
  display.getVideoTracks()[0].onended = () => r.state !== 'inactive' && r.stop();
  r.start(1000);
  recStarted = Date.now();
  me.rec = true;
  syncState();
  toast('Recording — everyone can see the REC badge. Highlights get recording timestamps.', 'record');
}

// ---------- Loops ----------
setInterval(() => {
  const lv = L.level?.() ?? 0;
  $('#meter').style.transform = `scaleX(${Math.min(1, lv * 10)})`;
  if (!heard && lv > SPEAKING) { heard = true; paintChecks(); }
  if (!L.tile) return;
  mutedFrames = !me.mic && micTrack && lv > SPEAKING * 1.5 ? mutedFrames + 1 : 0;
  if (mutedFrames > 5 && Date.now() - lastHint > 20_000) { lastHint = Date.now(); toast('You’re muted — press M to unmute', 'mic-off'); }
  let loudest = null, max = SPEAKING;
  for (const p of all()) {
    const l = p.state.mic ? p.level?.() ?? 0 : 0;
    p.tile.classList.toggle('speaking', l > SPEAKING);
    p.tile.style.setProperty('--lvl', Math.min(1, l * 14).toFixed(2));
    if (l > SPEAKING) { p.talk += 150; p.lastSpoke = Date.now(); }
    if (p !== L && p.state.mic) hesitation.tick(p.id, l > SPEAKING ? 150 : 0, othersTalking(p));
    if (p !== L && l > max) { max = l; loudest = p.id; }
  }
  if (loudest && loudest !== active) { active = loudest; if (view === 'speaker' && !pinned && !me.auto) layout(); }
  if (me.auto) direct();
}, 150);

function direct() {
  const now = Date.now();
  const share = [...peers.values()].find((p) => p.state.screen && p.tile.ownerDocument === document);
  let speaker = null, speakerAt = 0;
  for (const p of peers.values()) if (p !== share && p.lastSpoke > speakerAt) { speaker = p.id; speakerAt = p.lastSpoke; }
  const want = chooseFocus({ share: share?.id ?? null, shareActiveAt: share ? Math.max(share.shareAt, share.inkAt) : 0, speaker, speakerAt, now, count: all().length });
  const next = dwell(want, now);
  if (next !== autoFocusId) { autoFocusId = next; layout(); }
  const talking = [...peers.values()].some((p) => now - p.lastSpoke < 2000);
  if (boardAuto && !$('#board').hidden && now - boardAt > 10_000 && talking) setBoard(false);
  if (isDirector() && crosstalk(all().filter((p) => now - p.lastSpoke < 400).length, now)) autoMark('crosstalk', 'Lively discussion — several people talking at once');
  const collided = isDirector() && collision(all().filter((p) => now - p.lastSpoke < 250).map(idOf).filter(Boolean), now);
  if (collided) {
    const order = turnOrder(collided, Object.fromEntries(all().map((p) => [idOf(p), p.talk])));
    send({ type: 'turn-queue', order });
    showTurnQueue(order);
  }
}

setInterval(async () => {
  for (const p of peers.values()) {
    const stats = await p.pc.getStats().catch(() => null);
    if (!stats) continue;
    let rtt;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) rtt ??= stats.get(s.selectedCandidatePairId)?.currentRoundTripTime;
      else if (s.type === 'candidate-pair' && s.selected) rtt ??= s.currentRoundTripTime;
    });
    p.tile.dataset.q = rtt == null ? 0 : rtt < 0.15 ? 3 : rtt < 0.4 ? 2 : 1;
    p.tile.querySelector('.q').title = rtt == null ? 'Connecting…' : `${Math.round(rtt * 1000)} ms round trip`;
  }
}, 3000);

setInterval(() => {
  if (!L.tile) return;
  $('#timer').textContent = duration(Date.now() - started);
  if (!$('#panel').hidden && tab === 'people') renderTalk();
  recordShares(Date.now());
  for (const p of peers.values()) if (p.tmView) paintTimeline(p);
  if (!me.auto) return;
  sampleMotion();
  const now = Date.now();
  const r = away({ now, micOn: me.mic && !!micTrack, speaking: now - L.lastSpoke < 1500, active: now - lastInput < 1500 || now - motionAt < 1500 });
  if (r === 'prompt') awayPrompt();
  if (r === 'away') {
    $('#notices [data-key="away"]')?.remove();
    if (me.mic) { toggleMic(); toast('Auto-muted — you seemed to be away. Press M to unmute.', 'mic-off'); }
  }
}, 1000);
setInterval(trackPins, 1000 / TRACK.hz);
setInterval(sampleShares, WITNESS.sampleMs);
setInterval(witnessTick, WITNESS.intervalMs);
new ResizeObserver(fit).observe($('#stage'));

// ---------- Wiring ----------
on('.new-meeting', () => go(`/${newCode()}`));
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const raw = $('#joinCode').value.trim();
  let code = raw;
  try { code = new URL(raw).pathname.slice(1); } catch {}
  code = code.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (code.length >= 3) go(`/${code}`); else toast('Enter a meeting code like abc-defg-hij');
};
$('#lobbyForm').onsubmit = (e) => {
  e.preventDefault();
  me.name = $('#name').value.trim().slice(0, 40) || 'Guest';
  store.set('truemeet-name', me.name);
  ac?.resume();
  joining(true);
  $('#lobbyErr').textContent = '';
  connect();
};
$('#name').oninput = renderLocal;
$('#camSel').onchange = async () => { if (!me.cam) return; camTrack?.stop(); camTrack = await getCam(); me.cam = !!camTrack; pushVideo(); paintControls(); };
$('#micSel').onchange = async () => {
  micTrack?.stop();
  micTrack = await getMic();
  if (micTrack) micTrack.enabled = me.mic; else me.mic = false;
  setProbe();
  paintControls();
  paintChecks();
};
$('#nsToggle').onchange = () => micTrack?.applyConstraints(audioOpts()).catch(() => toast('Noise suppression unavailable'));
$('#blurToggle').onchange = (e) => camTrack?.applyConstraints({ backgroundBlur: e.target.checked }).catch(() => toast('Background blur unavailable'));
me.lang = (() => { // remembered, else the browser's language if offered, else the same language anywhere, else en-US
  const want = (store.get('truemeet-speak') || navigator.language || 'en-US').toLowerCase();
  return (SPEAK.find(([t]) => t.toLowerCase() === want) ?? SPEAK.find(([t]) => baseLang(t) === baseLang(want)) ?? SPEAK[0])[0];
})();
$('#speakSel').append(...SPEAK.map(([v, label]) => new Option(label, v)));
$('#speakSel').value = me.lang;
$('#speakSel').onchange = (e) => setSpeak(e.target.value);
$('#tlSel').append(...LANGS.map(([v, label]) => new Option(label, v)));
$('#tlSel').value = target;
$('#tlSel').onchange = (e) => setTarget(e.target.value);
$('#tlPill').onclick = (e) => { // a click is the gesture a model download needs; otherwise it opens the language picker
  e.stopPropagation();
  const waiting = [...engines.values()].filter((x) => x.dst === target && x.state === 'needs-click');
  if (waiting.length) waiting.forEach((x) => engine(x.src, x.dst, true)); else $('#langBtn').click();
};
$('#waitToggle').onchange = (e) => send({ type: 'waiting', on: e.target.checked });
$('#copilotToggle').checked = copilotOn;
$('#copilotToggle').onchange = (e) => {
  copilotOn = e.target.checked;
  store.set('truemeet-copilot', copilotOn ? '1' : '0');
  if (!copilotOn) $('#copilot').replaceChildren();
  toast(copilotOn ? 'Co-Pilot on — private reply suggestions when someone asks you something' : 'Co-Pilot off', 'wand');
};
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  $('#chatInput').value = '';
  send({ type: 'chat', text });
  addChat(me.name, text, true);
};
$('#reactPop').append(...EMOJI.map((emoji) => Object.assign(document.createElement('button'), {
  textContent: emoji,
  ariaLabel: `React ${emoji}`,
  onclick: () => { send({ type: 'reaction', emoji }); burst(L, emoji); directorReaction(me.id); },
})));
on('.mic-ctl', toggleMic);
on('.cam-ctl', toggleCam);
on('#shareBtn', toggleShare);
on('#boardBtn', toggleBoard);
on('#autoBtn', toggleAuto);
on('#handBtn', toggleHand);
on('#ccBtn', toggleCaptions);
on('#recBtn', toggleRecord);
on('.mark-btn', mark);
on('#chatBtn', () => togglePanel('chat'));
on('#peopleBtn', () => togglePanel('people'));
on('[data-tab]', (e) => setPanel(e.currentTarget.dataset.tab));
on('#closePanel', () => setPanel(null));
on('.copy-link', copyLink);
on('.dl-notes', downloadNotes);
on('#leaveBtn', () => leave());
on('#viewBtn', () => { view = view === 'gallery' ? 'speaker' : 'gallery'; pinned = null; layout(); });
on('#muteAll', () => { send({ type: 'mute-all' }); toast('Everyone else was muted', 'mic-off'); });
on('#lockBtn', () => send({ type: 'lock', locked: !locked }));
on('#rejoin', () => openLobby(room));
on('#homeBtn', () => go('/'));
on('#pipBtn', () => popOut());
on('[data-board-tool]', (e) => { boardTool = e.currentTarget.dataset.boardTool; paintBoardTools(); });
on('[data-color]', (e) => { boardColor = e.currentTarget.dataset.color; boardTool = 'pen'; paintBoardTools(); });
on('#boardUndo', () => { const sid = boardMine.pop(); if (sid) { inkApply(board, { op: 'undo', sid }, me.id); send({ type: 'ink', s: 'board', op: 'undo', sid }); } });
on('#boardClear', () => { inkApply(board, { op: 'clear', all: true }, me.id); send({ type: 'ink', s: 'board', op: 'clear', all: true }); boardMine.length = 0; });
on('#boardExport', async () => save(await exportPng(board, BOARD_BG), `truemeet-board-${stamp()}.png`));
on('#boardClose', toggleBoard);
paintBoardTools();
paintCaps();
function paintCaps() {
  const badge = (sel, text) => { $(sel).textContent = text || 'Not supported'; $(sel).classList.toggle('ok', !!text); };
  badge('#tlCap', CAPS.translate || 'Dictionary only');
  $('#tlCap').classList.toggle('ok', !!CAPS.translate);
  badge('#popCap', CAPS.popout);
  $('#pipBtn').disabled = !CAPS.popout;
  if (!SR) { $('#ccBtn').classList.add('unsupported'); $('#ccBtn').dataset.tip = 'Live captions · not supported in this browser'; }
}

const closePops = () => document.querySelectorAll('.pop').forEach((p) => (p.hidden = true));
document.querySelectorAll('[data-pop]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $(b.dataset.pop), open = pop.hidden;
  closePops();
  pop.hidden = !open;
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.pop')) closePops();
  if (!e.target.closest('.pin-pop, canvas')) closePinPop();
});
for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel']) addEventListener(type, () => (lastInput = Date.now()), { passive: true });
document.addEventListener('pointerdown', () => { if (ac?.state === 'suspended') ac.resume(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Alt' && !e.repeat && hoverTile && hoverTile !== L && !$('#room').hidden) { e.preventDefault(); startWhisper(hoverTile); return; }
  if (e.key === 'Escape') { closePops(); if (inkTool) setInkTool(null); return; }
  if ($('#room').hidden || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  const keys = { m: toggleMic, v: toggleCam, s: toggleShare, h: toggleHand, l: toggleCaptions, w: toggleBoard, b: mark, a: toggleAuto, c: () => togglePanel('chat'), p: () => togglePanel('people') };
  keys[e.key.toLowerCase()]?.();
});
document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && whisperTo) { e.preventDefault(); stopWhisper(); } });
addEventListener('blur', () => stopWhisper()); // never leave a whisper stuck on
addEventListener('popstate', () => { if (L.tile) leave(); route(); });

$('#boot').remove(); // started: the fallback message in index.html is no longer needed
route();
