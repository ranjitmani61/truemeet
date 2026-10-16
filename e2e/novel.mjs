// The five first-of-their-kind capabilities, end to end with three real Chrome participants:
//  1. Screen Time Machine: rewind a live share locally, mark the past frame privately, beam it to the
//     presenter (stack card + real pop-out presenter window) and open the comparison.
//  2. Snip a region of a live share onto the shared whiteboard.
//  3. Decision ledger: promote a highlight, sign with device keys, export and verify offline (+ tamper).
//  4. Lean-in whisper: the third person really stops hearing the whisperer; the partner still does.
import { parseLedger, verifyLedger } from '../public/ledger.js';
import { assert, downloadNotes, drawOn, join, liveVideo, openPanel, suite } from './lib.mjs';

const t = await suite('novel capabilities');
const url = `${t.base}/tst-novel-${Date.now().toString(36)}`;
const [a, b, c] = [await t.page('A'), await t.page('B'), await t.page('C')];
for (const [p, name] of [[a, 'Ada'], [b, 'Bo'], [c, 'Cy']]) { await join(p, url, name); await p.waitForSelector('#room:not([hidden])'); }
await Promise.all([liveVideo(a), liveVideo(b), liveVideo(c)]);
t.step('three participants connected');

// ===== 1. Screen Time Machine =================================================================
const share = '#stage .tile.screen';
await b.click('#shareBtn');
for (const p of [a, c]) await p.waitForFunction((sel) => document.querySelector(sel)?.querySelector('video').videoWidth > 0, share, { timeout: 10_000 });
await a.waitForFunction((sel) => Number(document.querySelector(`${sel} .tm-range`).max) >= 3, share, { timeout: 15_000 });
t.step('A has a local rewind buffer of B’s screen');
await a.hover(share);
await a.focus(`${share} .tm-range`);
await a.keyboard.press('ArrowLeft');
await a.keyboard.press('ArrowLeft');
await a.waitForFunction((sel) => document.querySelector(sel).classList.contains('rewound'), share);
assert.match(await a.textContent(`${share} .tm-badge`), /^Viewing -\d+s$/, '“Viewing -Ns” badge');
assert.ok(await a.isVisible(`${share} .tm-live`), '“Jump to live” offered');
await a.waitForFunction((sel) => document.querySelector(`${sel} .tm-frame`).naturalWidth > 0, share); // past frame decoded and shown

await a.click(`${share} [data-ink="pen"]`);
await drawOn(a, `${share} .ink-past`);
await a.click(`${share} [data-ink="pin"]`);
const past = await a.locator(`${share} .ink-past`).boundingBox();
await a.mouse.click(past.x + past.width * 0.62, past.y + past.height * 0.3);
await a.fill(`${share} .pin-pop input`, 'Was this the bug?');
await a.press(`${share} .pin-pop input`, 'Enter');
assert.equal(await a.textContent(`${share} .pins-past .pin-dot b`), '1', 'private pin #1 on the past frame');
await b.waitForTimeout(400);
assert.equal(await b.locator('.tile.local .pin-dot').count(), 0, 'marks on a rewound frame are never sent live');
await t.shot(a, 'n0-rewound.png');

await a.click(`${share} .tm-beam`);
await b.waitForSelector('#notices .notice.beam');
assert.match(await b.textContent('#notices .notice.beam b'), /^Ada is referencing your screen from \d+s ago$/);
assert.ok(await b.evaluate(() => document.querySelector('#notices .notice.beam canvas').width > 0), 'thumbnail with overlay rendered');
await b.click('#notices .notice.beam .beam-thumb');
await b.waitForSelector('.compare');
await b.waitForFunction(() => document.querySelector('.compare canvas').width > 0 && document.querySelector('.compare video').videoWidth > 0); // past frame vs. live screen, both rendering
await b.waitForTimeout(500);
await t.shot(b, 'n1-compare.png');
await b.click('.compare .icon-btn');
t.step('beamed past frame → presenter card → side-by-side comparison');

const pipPage = b.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
await b.click('.tile.local .ink-pop');
await b.waitForFunction(() => window.documentPictureInPicture?.window?.document.querySelector('.tile.local'));
await a.click(`${share} .tm-beam`);
await b.waitForFunction(() => window.documentPictureInPicture.window?.document.querySelector('.pip-cards .notice.beam canvas')?.width > 0, null, { timeout: 8000 });
assert.match(await b.evaluate(() => window.documentPictureInPicture.window.document.querySelector('.pip-cards .notice.beam b').textContent), /referencing your screen from \d+s ago/);
await b.evaluate(() => window.documentPictureInPicture.window.document.querySelector('.pip-cards .beam-thumb').click());
await b.waitForFunction(() => window.documentPictureInPicture.window.document.querySelector('.compare canvas')?.width > 0);
const pip = await pipPage;
if (pip) { await pip.waitForTimeout(400); if (process.env.E2E_OUT) await pip.screenshot({ path: `${process.env.E2E_OUT}/n2-pip-beam.png` }).catch(() => {}); }
await b.evaluate(() => window.documentPictureInPicture.window.close());
t.step('beam card + comparison inside the real pop-out presenter window');

await a.click(`${share} .tm-live`);
await a.waitForFunction((sel) => !document.querySelector(sel).classList.contains('rewound'), share);
assert.equal(await a.textContent(`${share} .tm-badge`), 'Live');
await a.keyboard.press('Escape');

// ===== 2. Snip a live region onto the whiteboard ==============================================
await c.click(`${share} [data-ink="snip"]`);
const live = await c.locator(`${share} .ink`).boundingBox();
await c.mouse.move(live.x + live.width * 0.25, live.y + live.height * 0.25);
await c.mouse.down();
await c.mouse.move(live.x + live.width * 0.5, live.y + live.height * 0.5, { steps: 6 });
await c.mouse.move(live.x + live.width * 0.7, live.y + live.height * 0.7, { steps: 6 });
await c.mouse.up();
await c.keyboard.press('Escape');
await a.keyboard.press('w');
await a.waitForFunction(() => {
  const cv = document.querySelector('#boardCanvas');
  if (!cv.width) return false; // first frame not rendered yet
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let green = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i] < 110 && d[i + 2] < 110) green++;
  return green > 3000; // the fake screen is green; the empty board is navy
}, null, { timeout: 8000 });
await a.waitForTimeout(500); // let the board's entrance animation finish before the screenshot
await t.shot(a, 'n3-snip-board.png');
await a.keyboard.press('w');
t.step('C snipped a region of B’s live screen onto everyone’s whiteboard');

// ===== 3. Decision ledger ======================================================================
await a.keyboard.press('b');
await openPanel(a, 'notes');
await a.click('#transcript .note .propose');
await a.fill('#notices [data-key="propose"] textarea', 'Ship v2 on Friday');
await a.click('#notices [data-key="propose"] .btn.primary');
for (const p of [a, b, c]) await p.waitForFunction(() => document.querySelector('#notices .notice.proposal blockquote')?.textContent === 'Ship v2 on Friday');
await a.click('#notices .notice.proposal .sign-btn');
await b.click('#notices .notice.proposal .sign-btn');
await c.waitForFunction(() => /Signed by (Ada, Bo|Bo, Ada) · 2 of 3/.test(document.querySelector('#notices .notice.proposal .signers')?.textContent ?? ''), null, { timeout: 8000 });
await a.waitForFunction(() => document.querySelector('#notices .notice.proposal .sign-btn').disabled);
await t.shot(c, 'n4-proposal.png');
const notes = await downloadNotes(a);
assert.match(notes, /DECISION LEDGER/);
assert.match(notes, /VALID +Ada · key [0-9a-f]{32}/);
assert.match(notes, /VALID +Bo · key [0-9a-f]{32}/);
const ledger = parseLedger(notes);
const verdict = await verifyLedger(ledger);
assert.equal(verdict.valid, true, 'exported ledger verifies offline');
assert.deepEqual(verdict.proposals[0].signatures.map((x) => x.name).sort(), ['Ada', 'Bo']);
const tampered = structuredClone(ledger);
tampered.proposals[0].text = 'Ship v2 on Monday';
assert.equal((await verifyLedger(tampered)).valid, false, 'a changed decision no longer verifies');
t.step('proposal signed by Ada and Bo; exported ledger verifies, tampered copy fails');

// ===== 4. Lean-in whisper: real privacy, measured at the third person =========================
const loudness = (p, who, ms) => p.evaluate(async ([who, ms]) => {
  const tile = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.name')?.textContent === who);
  let max = 0;
  for (const end = Date.now() + ms; Date.now() < end;) { max = Math.max(max, Number(tile.style.getPropertyValue('--lvl') || 0)); await new Promise((r) => setTimeout(r, 100)); }
  return max;
}, [who, ms]);
assert.ok((await loudness(c, 'Ada', 3000)) > 0.05, 'before: Cy hears Ada');
await a.click('#closePanel').catch(() => {});
await a.hover(`${share} .whisper-btn`); // waits for the stage to settle after the panel closed
await a.mouse.down();
await b.waitForFunction(() => /Ada is whispering to you/.test(document.querySelector('#notices [data-key="whisper"]')?.textContent ?? ''));
assert.ok(await a.isVisible('#notices [data-key="whisper"]'), 'whisperer sees the tether notice');
assert.ok(await b.evaluate(() => [...document.querySelectorAll('.tile:not(.local) video')].every((v) => v.muted)), 'Bo’s audio now flows through the spatial mix');
assert.ok(await b.evaluate(() => [...document.querySelectorAll('.tile.whisper .name')].some((n) => n.textContent === 'Ada')), 'glowing tether on Ada’s tile');
await c.waitForTimeout(700); // audio already in flight (network + jitter buffer) plays out first
const cyDuring = await loudness(c, 'Ada', 3000);
const boDuring = await loudness(b, 'Ada', 3000);
await t.shot(b, 'n5-whisper.png');
await a.mouse.up();
await b.waitForFunction(() => !document.querySelector('#notices [data-key="whisper"]'));
assert.equal(cyDuring, 0, 'during: Cy hears nothing from Ada');
assert.ok(boDuring > 0.05, 'during: Bo still hears Ada');
assert.ok(await b.evaluate(() => [...document.querySelectorAll('.tile:not(.local) video')].every((v) => !v.muted)), 'normal audio restored on release');
assert.ok((await loudness(c, 'Ada', 4000)) > 0.05, 'after: Cy hears Ada again');
t.step(`whisper was private: Cy heard ${cyDuring}, Bo heard ${boDuring.toFixed(2)}`);

await t.finish();
