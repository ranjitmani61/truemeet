// Living anchors, proposed moves and Proof-of-Frame, end to end with three real Chrome participants.
// Bo shares a deterministic animated screen (a canvas stream through the real WebRTC encoder):
//  1. Ada pins an orange badge; as Bo's screen moves it, the pin follows it on every participant's
//     own decoded video, docks "Off-screen" when it vanishes, and re-locks when it reappears.
//  2. Cy lifts the magenta card and proposes a new spot; Bo sees the live move on his own tile and
//     in the pop-out presenter window: card pixels at the new place, the gradient where it was.
//  3. Ada's badge reaches "Witness Verified" across real compression; her exported notes list the
//     frames VALID, verify offline, and verify.html proves her saved frame matches a signed one.
import { readFile } from 'node:fs/promises';
import { parseWitness, verifyWitness } from '../public/witness.js';
import { assert, downloadNotes, join, liveVideo, suite } from './lib.mjs';

const t = await suite('deep tech: living anchors, proposed moves, proof-of-frame');
const url = `${t.base}/tst-deep-${Date.now().toString(36)}`;
const a = await t.page('A'), b = await t.page('B', { screen: 'scene' }), c = await t.page('C');
for (const [p, name] of [[a, 'Ada'], [b, 'Bo'], [c, 'Cy']]) { await join(p, url, name); await p.waitForSelector('#room:not([hidden])'); }
await Promise.all([liveVideo(a), liveVideo(b), liveVideo(c)]);
await b.click('#shareBtn');
const share = '#stage .tile.screen', mine = '.tile.local';
for (const p of [a, c]) await p.waitForFunction((sel) => document.querySelector(sel)?.querySelector('video').videoWidth > 0, share, { timeout: 10_000 });
await a.waitForTimeout(1500); // let the encoder ramp up past its first blurry frames
t.step('Bo is sharing a moving screen with Ada and Cy');

// Where things are, in normalised video coordinates of a tile (the same space as the scene).
const geometry = (p, sel) => p.evaluate((sel) => {
  const tile = document.querySelector(sel), v = tile.querySelector('video'), cv = tile.querySelector('.ink');
  const k = Math.min(cv.clientWidth / v.videoWidth, cv.clientHeight / v.videoHeight), w = v.videoWidth * k, h = v.videoHeight * k;
  const r = { x: (cv.clientWidth - w) / 2, y: (cv.clientHeight - h) / 2, w, h }, box = cv.getBoundingClientRect();
  const pin = tile.querySelector('.pins:not(.pins-past) .pin-dot');
  return {
    screen: { x: box.left + r.x, y: box.top + r.y, w: r.w, h: r.h }, // CSS px on the page
    pin: pin && { x: (parseFloat(pin.style.left) - r.x) / r.w, y: (parseFloat(pin.style.top) - r.y) / r.h, tracked: pin.classList.contains('tracked'), off: pin.classList.contains('occluded'), edge: pin.dataset.edge ?? null, text: pin.innerText },
  };
}, sel);
const everyone = [[a, share], [c, share], [b, mine]];
const pins = () => Promise.all(everyone.map(([p, sel]) => geometry(p, sel).then((g) => g.pin)));
const settled = async (check, what, ms = 8000) => {
  for (const end = Date.now() + ms; ;) {
    const all = await pins();
    if (all.every((pin) => pin && check(pin))) return all;
    if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(all)}`);
    await a.waitForTimeout(150);
  }
};
const near = (x, y, tol = 0.02) => (pin) => Math.abs(pin.x - x) <= tol && Math.abs(pin.y - y) <= tol;

// ===== 1. Living anchors ======================================================================
await a.click(`${share} [data-ink="pin"]`);
const { screen } = await geometry(a, share);
await a.mouse.click(screen.x + screen.w * 0.25, screen.y + screen.h * 0.45); // the badge's centre
await a.fill(`${share} .pin-pop input`, 'Watch this badge');
await a.press(`${share} .pin-pop input`, 'Enter');
await a.click(`${share} [data-ink=""]`);
await settled((pin) => pin.tracked && near(0.25, 0.45)(pin), 'everyone locks onto the badge');
t.step('Ada pinned the badge; all three lock onto it (template carried by the pin)');

// A pin can only move as often as the video it is locked to delivers frames: measure that rate.
const fps = await a.evaluate((sel) => new Promise((resolve) => {
  const v = document.querySelector(`${sel} video`), start = performance.now();
  let n = 0;
  const count = () => { n++; if (performance.now() - start < 1500) v.requestVideoFrameCallback(count); else resolve(n / 1.5); };
  v.requestVideoFrameCallback(count);
}), share);
await b.evaluate(() => { window.__scene.speed = 0.15; window.__scene.glide(0.55, 0.62); }); // ~2.3 s of motion
const path = [];
for (let i = 0; i < 28; i++) { path.push((await geometry(a, share)).pin); await a.waitForTimeout(100); }
const xs = path.map((pin) => pin.x), steps = new Set(xs.filter((x) => x > 0.255 && x < 0.545).map((x) => x.toFixed(3))).size;
assert.ok(steps >= 4, `the pin moves across frames (${steps} positions between start and end): ${xs.map((x) => x.toFixed(3))}`);
assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 0.004), 'and only forward, with the badge');
const glided = await settled((pin) => pin.tracked && near(0.55, 0.62)(pin), 'pins arrive with the badge');
t.step(`pin glided with the badge on every screen: x ${xs[0].toFixed(3)} → ${glided[0].x.toFixed(3)} through ${steps} intermediate positions (Ada decodes the share at ${fps.toFixed(1)} fps here)`);
await t.shot(a, 'd1-anchor-moved.png');

await b.evaluate(() => { window.__scene.visible = false; });
const docked = await settled((pin) => pin.off && pin.edge === 'bottom' && Math.abs(pin.y - 0.95) < 0.01, 'pins dock at the nearest edge');
assert.ok(docked.every((pin) => /Off-screen/.test(pin.text)), 'with an “Off-screen” pill');
await t.shot(c, 'd2-anchor-offscreen.png');
t.step('badge hidden: every pin docks at the bottom edge as “Off-screen”');

await b.evaluate(() => { window.__scene.jump(0.38, 0.28); window.__scene.visible = true; });
const back = await settled((pin) => pin.tracked && !pin.off && near(0.38, 0.28)(pin), 'pins re-lock when the badge returns elsewhere');
t.step(`badge back at (0.38, 0.28): re-locked everywhere, e.g. Cy (${back[1].x.toFixed(3)}, ${back[1].y.toFixed(3)})`);

// ===== 2. Proposed move =======================================================================
const px = (p, sel, x, y) => p.evaluate(([sel, x, y]) => { // the overlay pixel over normalised (x, y)
  const tile = document.querySelector(sel), v = tile.querySelector('video'), cv = tile.querySelector('.ink'), dpr = devicePixelRatio;
  const k = Math.min(cv.clientWidth / v.videoWidth, cv.clientHeight / v.videoHeight), w = v.videoWidth * k, h = v.videoHeight * k;
  const X = ((cv.clientWidth - w) / 2 + x * w) * dpr, Y = ((cv.clientHeight - h) / 2 + y * h) * dpr;
  return [...cv.getContext('2d').getImageData(Math.round(X), Math.round(Y), 1, 1).data];
}, [sel, x, y]);
const magenta = ([r, g, b, alpha]) => alpha > 200 && r > 170 && g < 90 && b > 110;
const gradient = ([r, g, b, alpha]) => alpha > 200 && b > 120 && r < 90; // the blue panel behind the card

await c.click(`${share} [data-ink="move"]`);
const cs = (await geometry(c, share)).screen, at = (x, y) => [cs.x + cs.w * x, cs.y + cs.h * y];
await c.mouse.move(...at(0.775, 0.135));
await c.mouse.down();
await c.mouse.move(...at(0.85, 0.25), { steps: 5 });
await c.mouse.move(...at(0.945, 0.325), { steps: 5 });
await c.mouse.up();
await c.waitForSelector(`${share} .patch-lift`);
assert.equal(await c.evaluate(() => document.activeElement?.className), 'patch-lift', 'the lifted region takes focus (arrow keys + Enter work too)');
await c.mouse.move(...at(0.86, 0.23));
await c.mouse.down();
await c.mouse.move(...at(0.86, 0.45), { steps: 6 });
await c.mouse.move(...at(0.86, 0.68), { steps: 6 });
await c.mouse.up();
await c.click(`${share} [data-ink=""]`);
for (const [p, sel] of [[b, mine], [a, share]]) {
  await p.waitForFunction((sel) => document.querySelector(`${sel} .patch-tag span`)?.textContent === 'Proposed move · Cy', sel);
  await p.waitForFunction(() => true);
  for (let i = 0; i < 40 && !(magenta(await px(p, sel, 0.86, 0.68)) && gradient(await px(p, sel, 0.86, 0.23))); i++) await p.waitForTimeout(100);
  assert.ok(magenta(await px(p, sel, 0.86, 0.68)), `card pixels drawn at the proposed spot: ${await px(p, sel, 0.86, 0.68)}`);
  assert.ok(gradient(await px(p, sel, 0.86, 0.23)), `background plate where the card was: ${await px(p, sel, 0.86, 0.23)}`);
}
await t.shot(b, 'd3-move-presenter.png');
t.step('Cy proposed moving the card: Bo (presenter) and Ada see it live — card at the new spot, gradient plate where it was');

const pipPage = b.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
await b.click(`${mine} .ink-pop`);
await b.waitForFunction(() => window.documentPictureInPicture?.window?.document.querySelector('.tile.local .patch-tag'));
const inPip = await b.evaluate(async () => {
  const doc = window.documentPictureInPicture.window.document, tile = doc.querySelector('.tile.local'), v = tile.querySelector('video'), cv = tile.querySelector('.ink');
  for (let i = 0; i < 30 && !(cv.width && v.videoWidth); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300)); // a couple of frames at the new size
  const dpr = window.documentPictureInPicture.window.devicePixelRatio, k = Math.min(cv.clientWidth / v.videoWidth, cv.clientHeight / v.videoHeight);
  const w = v.videoWidth * k, h = v.videoHeight * k, at = (x, y) => [...cv.getContext('2d').getImageData(Math.round(((cv.clientWidth - w) / 2 + x * w) * dpr), Math.round(((cv.clientHeight - h) / 2 + y * h) * dpr), 1, 1).data];
  return { tag: tile.querySelector('.patch-tag span').textContent, moved: at(0.86, 0.68), plate: at(0.86, 0.23) };
});
assert.equal(inPip.tag, 'Proposed move · Cy');
assert.ok(magenta(inPip.moved) && gradient(inPip.plate), `inside the pop-out presenter window too: ${JSON.stringify(inPip)}`);
const pip = await pipPage;
if (pip && process.env.E2E_OUT) await pip.screenshot({ path: `${process.env.E2E_OUT}/d4-move-pip.png` }).catch(() => {});
await b.evaluate(() => window.documentPictureInPicture.window.close());
t.step('…and inside Bo’s real pop-out presenter window');

// ===== 3. Proof-of-Frame ======================================================================
const badge = (p, sel) => p.waitForFunction((sel) => {
  const el = document.querySelector(`${sel} .witness`);
  return el && !el.hidden && /^(Witness Verified · Frame #\d+|Signing frames · #\d+)$/.test(el.textContent) && el.textContent;
}, sel, { timeout: 20_000 }).then((h) => h.jsonValue());
const [onAda, onCy, onBo] = await Promise.all([badge(a, share), badge(c, share), badge(b, mine)]);
assert.match(onAda, /^Witness Verified · Frame #\d+$/);
assert.match(onCy, /^Witness Verified · Frame #\d+$/);
assert.match(onBo, /^Signing frames · #\d+$/);
await t.shot(a, 'd5-witness-verified.png');
t.step(`Proof-of-Frame across real WebRTC compression: Ada “${onAda}”, Cy “${onCy}”, Bo “${onBo}”`);

const [shot] = await Promise.all([a.waitForEvent('download'), a.click(`${share} .witness`)]);
const evidence = await readFile(await shot.path());
await a.waitForTimeout(2500); // the frame just saved gets judged
const notes = await downloadNotes(a);
assert.match(notes, /SCREEN WITNESS/);
const valid = notes.match(/^ {4}VALID +#\d+ · .+ · \d+\/64 layout \+ \d+\/64 detail bits from what you saw$/gm) ?? [];
assert.ok(valid.length >= 2, `frames listed VALID in the notes:\n${notes.slice(notes.indexOf('SCREEN WITNESS'), notes.indexOf('Machine-verifiable copy (drop'))}`);
assert.doesNotMatch(notes, /^ {4}(INVALID|MISMATCH|REJECTED) /m);
const bands = valid.map((l) => l.match(/(\d+)\/64 layout \+ (\d+)\/64 detail/).slice(1).map(Number)), span = (k) => `${Math.min(...bands.map((b) => b[k]))}–${Math.max(...bands.map((b) => b[k]))}`;
const offline = await verifyWitness(parseWitness(notes));
assert.equal(offline.valid, true, 'the exported chain verifies offline (Node)');
assert.equal(offline.chains[0].name, 'Bo');
t.step(`notes: ${valid.length} frames VALID (layout ${span(0)}/64, detail ${span(1)}/64 bits across real compression); chain verifies offline`);

const v = t.wire(await a.context().newPage(), 'verify');
await v.goto(`${t.base}/verify.html`);
await v.setInputFiles('#notes', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(notes) });
await v.setInputFiles('#shot', { name: 'frame.png', mimeType: 'image/png', buffer: evidence });
await v.waitForFunction(() => /Screenshot matches/.test(document.querySelector('#out').textContent));
const results = await v.$$eval('#out .res', (els) => els.map((e) => ({ ok: e.classList.contains('ok'), text: e.querySelector('span').firstChild.textContent })));
assert.ok(results.some((r) => r.ok && /^Screen witness · Bo’s screen · \d+ signed frame\(s\) .* every signature and chain link valid$/.test(r.text)), JSON.stringify(results));
assert.ok(results.some((r) => r.ok && /^Screenshot matches signed frame #\d+ of Bo’s screen$/.test(r.text)), JSON.stringify(results));
await t.shot(v, 'd6-verify.png');
const other = await a.screenshot(); // the whole meeting window: not the shared screen
await v.setInputFiles('#shot', { name: 'other.png', mimeType: 'image/png', buffer: other });
await v.waitForFunction(() => /Screenshot matches no signed frame/.test(document.querySelector('#out').textContent));
const closest = await v.$eval('#out .res.bad small', (el) => el.textContent);
const tampered = notes.replace(/("digest": ")([0-9a-f])/, (_, k, d) => k + (d === '0' ? '1' : '0'));
await v.setInputFiles('#notes', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(tampered) });
await v.waitForFunction(() => /INVALID: #\d+/.test(document.querySelector('#out').textContent));
const proof = results.find((r) => /^Screenshot matches/.test(r.text));
t.step(`verify.html: saved frame → “${proof.text}”; the meeting window instead → no match (${closest}); an edited frame is flagged INVALID`);
await t.finish();
