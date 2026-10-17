// Auto-Mode "meeting director": pure, DOM-free decision logic (unit-tested in director.test.js).
// The app feeds it observations (captions, reactions, audio levels, activity) and acts on the answers.

export const KEEP = Symbol('keep current focus');

// One shared election rule for the browser and the signaling authority.
export const electedDirector = (peers) => [...peers].filter((p) => p.state.auto === true && p.id).map((p) => p.id).sort()[0] ?? null;

// High-signal phrases → highlight reason. Matching is case-insensitive on whole words.
const TRIGGERS = [
  ['action item', /\baction items?\b/],
  ['deadline', /\bdeadlines?\b|\bdue (?:by|on|date)\b/],
  ['decision', /\blet'?s decide\b|\blet us decide\b|\bwe decided\b|\bdecision is\b/],
  ['next step', /\bnext steps?\b/],
  ['todo', /\bto-?dos?\b/],
  ['agreed', /\b(?:we )?agreed\b|\bwe agree\b/],
  ['follow-up', /\bfollow[ -]?ups?\b/],
];
export function phraseTrigger(text) {
  const t = String(text).toLowerCase().replace(/[’`]/g, "'");
  return TRIGGERS.find(([, re]) => re.test(t))?.[0] ?? null;
}

// N reactions from at least `people` distinct participants inside `windowMs` → one burst, then cool down.
export function burstDetector({ windowMs = 5000, min = 3, people = 2, cooldownMs = 30_000 } = {}) {
  let events = [], last = -Infinity;
  return (who, now) => {
    events = events.filter((e) => now - e.t < windowMs);
    events.push({ who, t: now });
    if (now - last < cooldownMs || events.length < min || new Set(events.map((e) => e.who)).size < people) return false;
    last = now;
    events = [];
    return true;
  };
}

// Two or more people talking continuously for `holdMs` → one crosstalk moment, then cool down.
export function crosstalkDetector({ holdMs = 1500, cooldownMs = 60_000 } = {}) {
  let since = null, last = -Infinity;
  return (speaking, now) => {
    if (speaking < 2) { since = null; return false; }
    since ??= now;
    if (now - since < holdMs || now - last < cooldownMs) return false;
    last = now;
    return true;
  };
}

// What deserves the stage right now. A share keeps the stage while it's being annotated (or freshly
// started); after `idleMs` without ink, a different active speaker takes over.
export function chooseFocus({ share, shareActiveAt, speaker, speakerAt, now, count, idleMs = 10_000 }) {
  const talking = speaker != null && now - speakerAt < 2000;
  if (share != null) return talking && speaker !== share && now - shareActiveAt >= idleMs ? speaker : share;
  if (count < 3) return null; // two people: the gallery already is the spotlight
  return talking ? speaker : KEEP;
}

// Debounce focus changes: a new choice must hold for `dwellMs` before it wins (no flapping).
export function focusDirector({ dwellMs = 1000 } = {}) {
  let current = null, candidate = null, since = 0;
  return (want, now) => {
    if (want === KEEP || want === current) { candidate = null; return current; }
    if (want !== candidate) { candidate = want; since = now; }
    if (now - since >= dwellMs) { current = want; candidate = null; }
    return current;
  };
}

// Unmuted but silent, with no input or camera motion: prompt after `promptMs`, auto-mute after `awayMs`.
export function awayMonitor({ promptMs = 120_000, awayMs = 300_000 } = {}) {
  let quietSince = null, idleSince = null, prompted = false;
  return ({ now, micOn, speaking, active }) => {
    if (!micOn || speaking) { quietSince = null; prompted = false; } else quietSince ??= now;
    if (active) idleSince = null; else idleSince ??= now;
    if (quietSince == null || idleSince == null) return null;
    const quiet = now - quietSince, idle = now - idleSince;
    if (quiet >= awayMs && idle >= awayMs) { quietSince = idleSince = null; prompted = false; return 'away'; }
    if (quiet >= promptMs && idle >= promptMs && !prompted) { prompted = true; return 'prompt'; }
    return null;
  };
}

// Mean absolute luminance difference between two equally sized grayscale frames.
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// ---------- Polite turn engine ----------
// A vocal collision: two or more people talk over each other for ≥ overlapMs, then everyone stops
// within abruptMs of each other and the silence holds for pauseMs (the awkward "you go — no, you go").
// If someone simply carries on, or talking resumes during the pause, it resolved itself: no signal.
// Feed it the ids speaking right now on every tick; it returns the colliding ids once, else null.
export function collisionDetector({ overlapMs = 350, abruptMs = 500, pauseMs = 700, cooldownMs = 15_000 } = {}) {
  let start = null, lastBoth = 0, members = new Set(), endedAt = null, silentSince = null, last = -Infinity;
  const reset = () => { start = null; members = new Set(); endedAt = null; silentSince = null; };
  return (speaking, now) => {
    if (speaking.length >= 2) {
      if (endedAt != null) reset();
      start ??= now;
      lastBoth = now;
      speaking.forEach((id) => members.add(id));
      return null;
    }
    if (start == null) return null;
    if (lastBoth - start < overlapMs) { reset(); return null; } // too brief to be a collision
    endedAt ??= now;
    if (speaking.length === 1) { if (silentSince != null || now - endedAt > abruptMs) reset(); return null; }
    silentSince ??= now;
    if (silentSince - endedAt > abruptMs) { reset(); return null; } // they didn't stop together
    if (now - silentSince < pauseMs) return null;
    const ids = [...members];
    reset();
    if (now - last < cooldownMs) return null;
    last = now;
    return ids;
  };
}

// Who goes first after a collision: least talk time so far, ties broken by id (same answer everywhere).
export const turnOrder = (ids, talk) => [...ids].sort((a, b) => (talk[a] ?? 0) - (talk[b] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));

// Unmute hesitation: someone unmutes, says almost nothing (< maxSpeechMs) while another person is
// talking, and mutes again within windowMs: they tried to jump in. mute() answers true exactly then.
export function hesitationDetector({ windowMs = 3000, maxSpeechMs = 200 } = {}) {
  const open = new Map();
  return {
    unmute(id, now, othersTalking) { open.set(id, { at: now, speech: 0, others: !!othersTalking }); },
    tick(id, speechMs, othersTalking) { const s = open.get(id); if (s) { s.speech += speechMs; s.others ||= !!othersTalking; } },
    mute(id, now) { const s = open.get(id); open.delete(id); return !!s && now - s.at <= windowMs && s.speech < maxSpeechMs && s.others; },
    forget(id) { open.delete(id); },
  };
}
