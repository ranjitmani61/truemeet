// Real-browser capability suite: the features that unit tests and fake devices alone can't prove.
//  1. Away protection with a genuinely silent mic and a still camera, driven by Playwright's fake
//     clock (minutes in seconds); a moving camera must keep you "present".
//  2. Real on-device caption translation (Chrome Translator API with downloaded models).
//  3. The sliding layout transition (View Transitions), captured frame by frame at 1/10 speed.
//  4. Numbered pins rendering live inside the real Document Picture-in-Picture presenter window.
// Translation needs network once to install Chrome's TranslateKit + language pack into a cached
// test profile (TRUEMEET_PROFILE, default: <tmp>/truemeet-e2e-profile). Offline, that part is
// reported as skipped with the reason — never silently passed.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as path } from 'node:path';
import { assert, downloadNotes, join, liveVideo, suite, translationReady } from './lib.mjs';

const t = await suite('real-browser capabilities');
const media = path(tmpdir(), 'truemeet-e2e-media');
await mkdir(media, { recursive: true });

// --- Fake capture files: 1 s of digital silence (WAV) and a perfectly still camera (Y4M)
const silence = (() => {
  const rate = 48_000, n = rate, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
})();
const still = (() => {
  const w = 320, h = 240, y = Buffer.alloc(w * h), uv = Buffer.alloc((w * h) / 4, 128);
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) y[i * w + j] = 40 + ((i * 3 + j) % 160); // a static gradient "room"
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`), ...Array(30).fill(frame)]);
})();
await writeFile(path(media, 'silence.wav'), silence);
await writeFile(path(media, 'still.y4m'), still);
const silentMic = `--use-file-for-fake-audio-capture=${path(media, 'silence.wav')}`;
const stillCam = `--use-file-for-fake-video-capture=${path(media, 'still.y4m')}`;
const awayNotice = '#notices [data-key="away"]';

// ===== 1. Away protection =====================================================================
{
  const p = await t.page('Away', { browser: await t.launch([silentMic, stillCam]) });
  await p.clock.install(); // time still flows naturally until we fast-forward it
  await join(p, `${t.base}/tst-away-${Date.now().toString(36)}`, 'Dee');
  await p.waitForSelector('#room:not([hidden])');
  await p.keyboard.press('a'); // Auto-Mode on; also the last "input" before going idle
  assert.ok(await p.isVisible('#autoChip'));
  await p.clock.runFor('01:50');
  assert.equal(await p.isVisible(awayNotice), false, 'no prompt before 2 minutes');
  await p.clock.runFor('00:15');
  await p.waitForSelector(awayNotice);
  assert.match(await p.textContent(awayNotice), /Still there\?.*mic is on/s);
  await t.shot(p, 'r1-away-prompt.png');
  t.step('silent mic + still camera: “Still there?” prompt at 2 min');
  assert.equal(await p.evaluate(() => document.querySelector('.dock .mic-ctl').classList.contains('off')), false, 'prompt does not mute by itself');
  await p.clock.runFor('03:00');
  await p.waitForFunction(() => document.querySelector('.dock .mic-ctl').classList.contains('off'));
  assert.ok(await p.isHidden(awayNotice), 'prompt replaced by the auto-mute');
  assert.ok((await p.textContent('#toasts')).includes('Auto-muted'));
  t.step('still away at 5 min: auto-muted');
  await p.context().close();
}
{
  // Same silence, but the default fake camera moves: presence must be detected from motion alone.
  const p = await t.page('Present', { browser: await t.launch([silentMic]) });
  await p.clock.install();
  await join(p, `${t.base}/tst-present-${Date.now().toString(36)}`, 'Eve');
  await p.waitForSelector('#room:not([hidden])');
  await p.keyboard.press('a');
  for (let s = 0; s < 150; s++) { await p.clock.runFor(1000); await p.waitForTimeout(120); } // real frames between samples
  assert.equal(await p.isVisible(awayNotice), false, 'camera movement counts as being present');
  assert.equal(await p.evaluate(() => document.querySelector('.dock .mic-ctl').classList.contains('off')), false);
  t.step('silent mic + moving camera for 2½ min: no prompt');
  await p.context().close();
}

// ===== 2–4. Two people: A on a translation-ready profile, B speaking English captions ==========
const profile = process.env.TRUEMEET_PROFILE ?? path(tmpdir(), 'truemeet-e2e-profile');
const ctxA = await t.persistent(profile);
await ctxA.addInitScript(() => { // count View Transitions the app starts and finishes
  const start = Document.prototype.startViewTransition;
  if (!start) return;
  window.__vt = { started: 0, ready: 0, finished: 0 };
  Document.prototype.startViewTransition = function (...args) {
    const vt = start.apply(this, args);
    window.__vt.started++;
    vt.ready.then(() => window.__vt.ready++, () => {});
    vt.finished.then(() => window.__vt.finished++, () => {});
    return vt;
  };
});

const translation = await translationReady(t, ctxA);
t.step(translation === true ? 'on-device translation models ready' : `translation unavailable here: ${translation}`);

const room = `${t.base}/tst-real-${Date.now().toString(36)}`;
const a = t.wire(await ctxA.newPage(), 'A');
await join(a, room, 'Ada');
await a.waitForSelector('#room:not([hidden])');
const b = await t.page('B', { speech: ['Action item: Bo sends the launch deck by Friday'] });
await join(b, room, 'Bo');
await b.waitForSelector('#room:not([hidden])');
await Promise.all([liveVideo(a), liveVideo(b)]);

// ===== 2. Real translation ====================================================================
if (translation === true) {
  assert.equal(await a.textContent('#tlCap'), 'On-device');
  await a.click('#langBtn');
  await a.focus('#tlSel');
  for (let i = 0; i < 2 && (await a.inputValue('#tlSel')) !== 'es'; i++) await a.keyboard.press('ArrowDown'); // a real user gesture
  if ((await a.inputValue('#tlSel')) !== 'es') await a.selectOption('#tlSel', 'es');
  await a.keyboard.press('Escape');
  await a.waitForTimeout(500);
  await b.keyboard.press('l');
  await a.waitForFunction(() => [...document.querySelectorAll('#transcript li:not(.note) small')].some((s) => s.textContent.includes('translated')), null, { timeout: 30_000 });
  const translated = await a.evaluate(() => { const li = [...document.querySelectorAll('#transcript li:not(.note)')].at(-1); return { text: li.querySelector('p').textContent, original: li.title }; });
  assert.match(translated.text, /viernes/i, 'Spanish text shown');
  assert.equal(translated.original, 'Action item: Bo sends the launch deck by Friday', 'original kept as the tooltip');
  assert.match(await downloadNotes(a), /Bo: Action item: Bo sends the launch deck by Friday\n\s+→ .*viernes/i, 'notes keep original + translation');
  await a.click('#closePanel');
  t.step(`real on-device translation: “${translated.text}”`);
} else {
  console.log(`  ↷ translation SKIPPED: ${translation}`);
}

// ===== 3. Sliding transition, captured at 1/10 speed =========================================
await a.keyboard.press('a'); // Auto-Mode: B's share will glide onto the stage
await a.waitForTimeout(400);
const cdp = await ctxA.newCDPSession(a);
await cdp.send('Animation.enable');
await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
const before = await a.evaluate(() => window.__vt.ready);
await b.click('#shareBtn');
await a.waitForFunction((n) => window.__vt.ready > n, before, { timeout: 10_000 });
// The browser's own animations prove the glide: each tile's group morphs from its old box to its new one.
const morphs = await a.evaluate(() => document.getAnimations()
  .filter((an) => an.effect?.pseudoElement?.startsWith('::view-transition-group(tile-'))
  .map((an) => { const kf = an.effect.getKeyframes(); return { from: `${kf[0].width}×${kf[0].height}`, to: `${kf.at(-1).width}×${kf.at(-1).height}`, ms: an.effect.getTiming().duration }; }));
assert.ok(morphs.length >= 2, `both tiles take part in the transition: ${JSON.stringify(morphs)}`);
assert.ok(morphs.some((m) => m.from !== m.to), `a tile changes size while gliding: ${JSON.stringify(morphs)}`);
for (let i = 0; i < 12; i++) {
  await t.shot(a, `r3-transition-${String(i).padStart(2, '0')}.png`);
  await a.waitForTimeout(250);
}
await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
await a.waitForFunction(() => window.__vt.finished >= window.__vt.started, null, { timeout: 10_000 });
assert.ok(await a.evaluate(() => document.querySelector('#stage .tile').classList.contains('screen')), 'share ends on the stage');
t.step(`share glided onto the stage: ${morphs.map((m) => `${m.from} → ${m.to}`).join(', ')} (${morphs[0].ms} ms)`);

// ===== 4. Pins inside the real Document Picture-in-Picture presenter window ==================
await a.waitForFunction(() => document.querySelector('#stage .tile.screen video')?.videoWidth > 0, null, { timeout: 10_000 });
const pipPage = b.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
await b.click('.tile.local .ink-pop');
await b.waitForFunction(() => window.documentPictureInPicture?.window?.document.querySelector('.tile.local'), null, { timeout: 8000 });
assert.equal(await b.evaluate(() => document.querySelector('#stage .tile.local, #strip .tile.local')), null, 'tile moved out of the main window');
await a.click('#stage .tile.screen [data-ink="pin"]');
const box = await a.locator('#stage .tile.screen .ink').boundingBox();
await a.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.35);
await a.fill('#stage .tile.screen .pin-pop input', 'Ship this screen');
await a.press('#stage .tile.screen .pin-pop input', 'Enter');
const inPip = await b.waitForFunction(() => {
  const dot = window.documentPictureInPicture.window?.document.querySelector('.tile.local .pin-dot');
  return dot && dot.isConnected && dot.offsetWidth > 0 && { n: dot.querySelector('b').textContent, note: dot.querySelector('span').textContent, left: dot.style.left };
}, null, { timeout: 8000 }).then((h) => h.jsonValue());
assert.deepEqual([inPip.n, inPip.note], ['1', 'Ship this screen'], 'pin rendered live inside the presenter window');
const pip = await pipPage;
if (pip) await pip.screenshot({ path: process.env.E2E_OUT ? `${process.env.E2E_OUT}/r4-pip.png` : undefined }).catch(() => {});
t.step(`pin #${inPip.n} rendered inside the pop-out presenter window${pip ? ' (screenshot taken)' : ''}`);
await b.evaluate(() => window.documentPictureInPicture.window.close());
await b.waitForFunction(() => document.querySelector('.tile.local')?.ownerDocument === document && document.querySelector('.tile.local .pin-dot'), null, { timeout: 5000 });
t.step('presenter window closed: tile and pin returned to the meeting');

await t.finish();
