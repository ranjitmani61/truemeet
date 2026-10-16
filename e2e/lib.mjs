// Shared harness for the headless browser suites. Starts TrueMeet on a free port and drives
// Chrome with fake camera/mic (and, where asked, a fake SpeechRecognition) at the browser boundary.
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROME=/usr/bin/google-chrome node e2e/<suite>.mjs
// Set E2E_OUT=/some/dir to keep screenshots.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { server } from '../server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
export { assert };

const EXECUTABLE = process.env.CHROME ?? '/usr/bin/google-chrome';
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'];
const VIEWPORT = { width: 1440, height: 900 };

// Replaces the Web Speech API with a recogniser that "hears" the given lines once captions start.
// window.__say(text) makes the running recogniser hear more; window.__srLang is its language.
const fakeSpeech = (lines) => {
  const hear = (r, text) => r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  let live = null;
  window.SpeechRecognition = class {
    start() {
      live = this;
      window.__srLang = this.lang;
      lines.forEach((text, i) => setTimeout(() => hear(this, text), 500 + i * 400));
    }
    stop() { if (live === this) live = null; }
  };
  window.__say = (text) => live && hear(live, text);
};

// Replaces speech synthesis: 'stub' has one en-US voice and records what it was asked to say;
// 'mute' has no voices at all (like a bare headless or locked-down machine).
const fakeVoices = (mode) => {
  window.__spoken = [];
  const voices = mode === 'stub' ? [{ name: 'Test voice', lang: 'en-US', default: true, localService: true, voiceURI: 'test-voice' }] : [];
  window.SpeechSynthesisUtterance = class { constructor(text) { Object.assign(this, { text, lang: '', voice: null, rate: 1 }); } };
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speaking: false, getVoices: () => voices, cancel() {}, addEventListener() {}, removeEventListener() {},
      speak(u) {
        window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null });
        setTimeout(() => u.onstart?.(), 20);
        setTimeout(() => u.onend?.(), 4000); // long enough to observe what happens while a voice plays
      },
    },
  });
};

// Replaces screen capture with a deterministic animated "screen" (a canvas stream through the real
// WebRTC encoder): a document panel with text lines, a blue gradient panel with a magenta card, and
// a distinctive orange badge the suite can glide, hide and show via window.__scene.
const fakeScreen = () => {
  const W = 1280, H = 720;
  const scene = (window.__scene = { x: 0.25, y: 0.45, tx: 0.25, ty: 0.45, visible: true, speed: 0.4 });
  scene.glide = (x, y) => Object.assign(scene, { tx: x, ty: y });
  scene.jump = (x, y) => Object.assign(scene, { x, y, tx: x, ty: y });
  const backdrop = () => {
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d');
    g.fillStyle = '#e9edf5'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffffff'; g.fillRect(40, 40, 0.66 * W - 40, H - 80); // the document
    let seed = 3;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let y = 70; y < H - 60; y += 26) { g.fillStyle = y % 130 === 70 ? '#1f2937' : '#6b7280'; g.fillRect(70, y, 180 + r() * 520, 9); }
    const grad = g.createLinearGradient(0, 0, 0, H); // a smooth panel: what a Coons plate must reproduce
    grad.addColorStop(0, '#1e3a8a'); grad.addColorStop(1, '#0ea5e9');
    g.fillStyle = grad; g.fillRect(0.72 * W, 0, 0.28 * W, H);
    g.fillStyle = '#e11d9c'; g.fillRect(0.78 * W, 0.14 * H, 0.16 * W, 0.18 * H); // the card someone will propose moving
    return c;
  };
  const badge = (g, cx, cy) => { // asymmetric, so there's exactly one way to match it
    g.save(); g.translate(cx - 36, cy - 36);
    g.fillStyle = '#ff8a00'; g.fillRect(0, 0, 72, 72);
    g.fillStyle = '#111827'; g.beginPath(); g.arc(42, 40, 20, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.fillRect(8, 8, 20, 14); g.fillRect(48, 34, 8, 8);
    g.fillStyle = '#111827'; g.beginPath(); g.moveTo(6, 66); g.lineTo(30, 66); g.lineTo(6, 44); g.fill();
    g.restore();
  };
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d'), bg = backdrop();
    let last = performance.now();
    setInterval(() => {
      const now = performance.now(), step = (scene.speed * (now - last)) / 1000, dx = scene.tx - scene.x, dy = scene.ty - scene.y, d = Math.hypot(dx, dy);
      last = now;
      if (d <= step) { scene.x = scene.tx; scene.y = scene.ty; } else { scene.x += (dx / d) * step; scene.y += (dy / d) * step; }
      g.drawImage(bg, 0, 0);
      if (scene.visible) badge(g, scene.x * W, scene.y * H);
    }, 33);
    return c.captureStream(30);
  };
};

export async function suite(name) {
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const owned = []; // browsers/contexts this suite must close
  const errors = [];
  const out = process.env.E2E_OUT;
  const t0 = Date.now();
  const wire = (p, label) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    return p;
  };
  // Extra Chrome instances, e.g. with file-backed fake camera/mic: launch(['--use-file-for-fake-audio-capture=…'])
  const launch = async (args = []) => {
    const b = await chromium.launch({ executablePath: EXECUTABLE, headless: true, args: [...MEDIA_ARGS, ...args] });
    owned.push(b);
    return b;
  };
  const browser = await launch();

  return {
    base,
    errors,
    launch,
    wire,
    async page(label, { speech, tts, screen, viewport = VIEWPORT, browser: b = browser } = {}) {
      const ctx = await b.newContext({ viewport, permissions: ['camera', 'microphone'], acceptDownloads: true });
      if (speech) await ctx.addInitScript(fakeSpeech, speech);
      if (tts) await ctx.addInitScript(fakeVoices, tts);
      if (screen) await ctx.addInitScript(fakeScreen);
      return wire(await ctx.newPage(), label);
    },
    // A persistent profile (kept between runs) with background networking allowed, so Chrome can
    // install on-device components such as the translation models.
    async persistent(dir, { args = [] } = {}) {
      const ctx = await chromium.launchPersistentContext(dir, {
        executablePath: EXECUTABLE, headless: true, viewport: VIEWPORT, permissions: ['camera', 'microphone'], acceptDownloads: true,
        args: [...MEDIA_ARGS, ...args], ignoreDefaultArgs: ['--disable-component-update', '--disable-background-networking'],
      });
      owned.push(ctx);
      return ctx;
    },
    async shot(p, file) { if (out) await p.screenshot({ path: `${out}/${file}` }); },
    step(text) { console.log(`  · ${text} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); },
    async finish() {
      for (const b of owned.reverse()) await b.close();
      server.closeAllConnections();
      server.close();
      assert.deepEqual(errors, [], 'no console errors');
      console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    },
  };
}

export async function join(p, url, name) {
  await p.goto(url);
  await p.waitForSelector('#lobby:not([hidden])');
  await p.waitForTimeout(700);
  await p.fill('#name', name);
  await p.click('#joinBtn');
}
export const liveVideo = (p) => p.waitForFunction(() => [...document.querySelectorAll('.tile:not(.local) video')].some((v) => v.videoWidth > 0), null, { timeout: 15_000 });
export async function openPanel(p, tabName) {
  if (await p.isHidden('#panel')) await p.click(tabName === 'chat' ? '#chatBtn' : '#peopleBtn');
  if (await p.isHidden(`#tab-${tabName}`)) await p.click(`[data-tab="${tabName}"]`);
}
export async function drawOn(p, sel) {
  const b = await p.locator(sel).boundingBox();
  const x = b.x + b.width * 0.3, y = b.y + b.height * 0.45;
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(x + i * 16, y + Math.sin(i / 2) * 26);
  await p.mouse.up();
}
export async function downloadNotes(p) {
  await openPanel(p, 'notes');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#tab-notes .dl-notes')]);
  return readFile(await dl.path(), 'utf8');
}
export const opaquePixels = (p, sel) => p.evaluate((sel) => {
  const c = document.querySelector(sel), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
  return n;
}, sel);

// Make sure Chrome's on-device translation (TranslateKit + en→es pack) is installed in a persistent
// profile. Returns true, or the reason it isn't available (offline, unsupported).
export async function translationReady(t, ctx) {
  // A real user gesture → Translator.create(); first time this installs the language pack, and
  // Chrome's TranslateKit library is pulled via chrome://components if it's still missing.
  const p = t.wire(await ctx.newPage(), 'bootstrap');
  await p.goto(t.base);
  const tryCreate = async () => {
    await p.evaluate(() => {
      document.querySelector('#tm-boot')?.remove();
      const b = Object.assign(document.createElement('button'), { id: 'tm-boot', textContent: 'boot' });
      b.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:999';
      b.onclick = async () => {
        try { window.__boot = await (await Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' })).translate('Friday'); }
        catch (e) { window.__boot = `ERR ${e.message}`; }
      };
      document.body.append(b);
      window.__boot = null;
    });
    await p.click('#tm-boot');
    return p.waitForFunction(() => window.__boot, null, { timeout: 120_000 }).then((h) => h.jsonValue());
  };
  if (!(await p.evaluate(() => 'Translator' in self))) return 'Translator API missing';
  let r = await tryCreate();
  if (r.startsWith('ERR')) {
    await p.goto('chrome://components');
    await p.evaluate(() => [...document.querySelectorAll('.component')].find((c) => /Chrome TranslateKit -/.test(c.innerText))?.querySelector('button')?.click());
    await p.waitForFunction(() => /Chrome TranslateKit - Version: (?!0\.0\.0\.0)/.test(document.body.innerText), null, { timeout: 120_000 }).catch(() => {});
    await p.goto(t.base);
    r = await tryCreate();
  }
  // The bootstrap page logs Chrome's own "Built-In AI" banner/library errors; they aren't the app's.
  t.errors.splice(0, Infinity, ...t.errors.filter((e) => !e.startsWith('bootstrap:')));
  await p.close();
  return r.startsWith('ERR') ? r : true;
}
