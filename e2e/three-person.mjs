// Three-person advanced suite: waiting room, safety codes, Auto-Mode (caption + reaction
// auto-highlights, spotlight switching), whiteboard sync, time-travel catch-up card for a late
// joiner, live numbered pins on a shared screen, resolution, and exported notes.
import { assert, downloadNotes, drawOn, join, liveVideo, opaquePixels, openPanel, suite } from './lib.mjs';

const t = await suite('three-person advanced meeting');
const url = `${t.base}/tst-${Date.now().toString(36)}`;
const name = (sel) => (p) => p.evaluate((sel) => document.querySelector(sel)?.querySelector('.name')?.textContent ?? null, sel);
const stageName = name('#stage .tile');

// --- Host with Auto-Mode + waiting room
const a = await t.page('A');
await join(a, url, 'Ada');
await a.waitForSelector('#room:not([hidden])');
await a.keyboard.press('a');
assert.ok(await a.isVisible('#autoChip'), 'Auto-Mode chip shown');
await openPanel(a, 'people');
await a.check('#waitToggle');
assert.match(await a.textContent('#tlCap'), /On-device|Not supported/, 'translation capability badge');
assert.match(await a.textContent('#popCap'), /Floating window|Video only|Not supported/, 'pop-out capability badge');

const b = await t.page('B', { speech: ['Action item: Bo sends the launch deck by Friday'] });
await join(b, url, 'Bo');
await b.waitForFunction(() => /Waiting/.test(document.querySelector('#joinBtn .btn-text').textContent));
await a.waitForSelector('.knock');
await a.click('.knock .btn.primary');
await b.waitForSelector('#room:not([hidden])');
await Promise.all([liveVideo(a), liveVideo(b)]);
t.step('B admitted from the waiting room');

// --- Safety codes agree on both ends
const code = async (p) => {
  await openPanel(p, 'people');
  await p.click('.people .btn.xs:has-text("Verify")');
  await p.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('.code b')?.textContent ?? ''));
  return p.textContent('.code b');
};
assert.equal(await code(a), await code(b), 'safety codes match');
await a.click('#closePanel');
await b.click('#closePanel');

// --- Auto-highlights: a caption phrase and a reaction burst (A is the only Auto-Mode user → director)
await b.keyboard.press('l');
await b.waitForFunction(() => [...document.querySelectorAll('#transcript .note-auto small')].some((s) => s.textContent.includes('action item')), null, { timeout: 8000 });
t.step('caption phrase → [Auto] action item, relayed to everyone');
await b.click('[data-pop="#reactPop"]');
await b.click('#reactPop button >> nth=0');
await b.click('#reactPop button >> nth=1');
await a.click('[data-pop="#reactPop"]');
await a.click('#reactPop button >> nth=4');
await b.waitForFunction(() => [...document.querySelectorAll('#transcript .note-auto small')].some((s) => s.textContent.includes('reactions')), null, { timeout: 5000 });
await a.keyboard.press('Escape');
await a.keyboard.press('b'); // manual highlight
t.step('reaction burst → [Auto] reactions; manual highlight');

// --- Whiteboard drawing to be synced to the late joiner
await a.keyboard.press('w');
await drawOn(a, '#boardCanvas');
await a.keyboard.press('w');

// --- Late joiner from the waiting room gets the time-travel catch-up card
const c = await t.page('C');
await join(c, url, 'Cy');
await a.waitForSelector('.knock');
await a.click('.knock .btn.primary');
await c.waitForSelector('#room:not([hidden])');
await c.waitForSelector('#notices .notice.catchup');
const card = await c.textContent('#notices .notice.catchup');
assert.match(card, /You joined \d+:\d+ into the meeting/);
assert.match(card, /\[Auto · action item\]/, 'catch-up lists auto-highlights');
assert.match(card, /\[Auto · reactions\]/);
assert.match(card, /Ada: /, 'catch-up lists manual highlights');
assert.match(card, /Bo: Action item: Bo sends the launch deck by Friday/, 'catch-up shows recent conversation');
const layout = await c.evaluate(() => {
  const els = [...document.querySelectorAll('#notices > *, #knocks > *, #toasts > .toast')].filter((e) => e.offsetParent);
  const r = els.map((e) => e.getBoundingClientRect());
  const hit = (x, y) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
  const overlaps = r.flatMap((x, i) => r.slice(i + 1).filter((y) => hit(x, y)).map(() => i));
  const cardRect = document.querySelector('.notice.catchup').getBoundingClientRect();
  const fixed = ['.topbar', '.dock'].map((s) => document.querySelector(s).getBoundingClientRect());
  return { overlaps: overlaps.length, onChrome: fixed.some((f) => hit(cardRect, f)), inView: cardRect.top >= 0 && cardRect.bottom <= innerHeight && cardRect.left >= 0 && cardRect.right <= innerWidth };
});
assert.deepEqual(layout, { overlaps: 0, onChrome: false, inView: true }, 'catch-up card stacks cleanly');
await c.waitForTimeout(800); // let entrance animations finish before the screenshot
await t.shot(c, 'c1-catchup.png');
await c.click('.notice.catchup .cu-board');
await c.waitForSelector('#board:not([hidden])');
await c.waitForTimeout(300);
assert.ok((await opaquePixels(c, '#boardCanvas')) > 0, 'late joiner sees the existing whiteboard');
await c.keyboard.press('w');
t.step('C admitted late → catch-up card + whiteboard');

// --- B shares; Auto-Mode on A spotlights the share; A drops a numbered pin with a note
await b.click('#shareBtn');
await a.waitForFunction(() => document.querySelector('#stage .tile')?.classList.contains('screen'), null, { timeout: 10_000 });
await a.waitForFunction(() => document.querySelector('#stage .tile.screen video')?.videoWidth > 0, null, { timeout: 10_000 });
await a.click('#stage .tile.screen [data-ink="pin"]');
const box = await a.locator('#stage .tile.screen .ink').boundingBox();
await a.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
await a.fill('#stage .tile.screen .pin-pop input', 'Fix this <button> label');
await a.press('#stage .tile.screen .pin-pop input', 'Enter');
await b.waitForFunction(() => document.querySelector('.tile.local .pins .pin-dot b')?.textContent === '1', null, { timeout: 5000 });
assert.equal(await b.textContent('.tile.local .pins .pin-dot span'), 'Fix this <button> label', 'note rendered as text on the sharer’s side');
assert.equal(await b.locator('.tile.local .pins .pin-dot button').count(), 0, 'no markup injected');
await a.keyboard.press('Escape');
await t.shot(b, 'b1-pin-sharer.png');
t.step('A pinned #1 on B’s screen; B sees it');

// --- Spotlight: with no ink for 10s and C talking, A's stage moves to C; C drawing brings the share back
await a.waitForFunction(() => !document.querySelector('#stage .tile')?.classList.contains('screen'), null, { timeout: 20_000 });
assert.equal(await stageName(a), 'Cy', 'idle share yields the stage to the active speaker');
t.step('idle share → spotlight moved to speaker C');
await c.click('#stage .tile.screen [data-ink="pen"]');
await drawOn(c, '#stage .tile.screen .ink');
await a.waitForFunction(() => document.querySelector('#stage .tile')?.classList.contains('screen'), null, { timeout: 6000 });
t.step('C drew on the share → spotlight returned to the share');
await t.shot(a, 'a1-spotlight.png');

// --- Exported notes carry [Auto] highlights with timestamps, and the pin
const notes = await downloadNotes(a);
assert.match(notes, /\[\+\d+:\d+\] \[Auto\] action item — Bo: “Action item: Bo sends the launch deck by Friday”/);
assert.match(notes, /\[\+\d+:\d+\] \[Auto\] reactions/);
assert.match(notes, /#1 · Ada · .* · Bo’s screen — “Fix this <button> label”/);

// --- Sharer resolves the pin; it disappears for the author too
await b.click('.tile.local .pins .pin-dot');
await b.click('.tile.local .pin-pop .btn:has-text("Resolve")');
await a.waitForFunction(() => !document.querySelector('#stage .tile.screen .pin-dot'), null, { timeout: 5000 });
assert.match(await downloadNotes(a), /“Fix this <button> label” \(resolved by Bo\)/);
t.step('notes exported; sharer resolved the pin');
await t.finish();
