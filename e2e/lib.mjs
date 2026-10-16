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
const fakeSpeech = (lines) => {
  window.SpeechRecognition = class {
    start() {
      lines.forEach((text, i) => setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }), 500 + i * 400));
    }
    stop() {}
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
    async page(label, { speech, viewport = VIEWPORT, browser: b = browser } = {}) {
      const ctx = await b.newContext({ viewport, permissions: ['camera', 'microphone'], acceptDownloads: true });
      if (speech) await ctx.addInitScript(fakeSpeech, speech);
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
