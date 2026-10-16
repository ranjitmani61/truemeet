// Live Polyglot + private Co-Pilot, end to end in real Chrome:
// Ada speaks English and asks for a status update; Bo has chosen Spanish. Bo sees the caption
// translated on-device, plus a Co-Pilot card that only Bo can see: the question in Spanish and two
// ranked replies grounded in this meeting's whiteboard pin and signed-off proposal, each in Spanish
// and in Ada's English. One click sends the reply into the meeting chat.
// Translation needs Chrome's on-device models in a cached profile (see translationReady); offline,
// the translation assertions are reported as skipped — the Co-Pilot itself works without them.
import { tmpdir } from 'node:os';
import { join as path } from 'node:path';
import { assert, join, liveVideo, openPanel, suite, translationReady } from './lib.mjs';

const t = await suite('live polyglot + private co-pilot');
const ctxB = await t.persistent(process.env.TRUEMEET_PROFILE ?? path(tmpdir(), 'truemeet-e2e-profile'));
const translation = await translationReady(t, ctxB);
t.step(translation === true ? 'on-device translation ready for Bo' : `translation unavailable: ${translation}`);

const url = `${t.base}/tst-copilot-${Date.now().toString(36)}`;
const a = await t.page('A', { speech: ['What is the status of the launch deck?'] });
await join(a, url, 'Ada');
await a.waitForSelector('#room:not([hidden])');
const b = t.wire(await ctxB.newPage(), 'B');
await join(b, url, 'Bo');
await b.waitForSelector('#room:not([hidden])');
await Promise.all([liveVideo(a), liveVideo(b)]);

// Bo speaks Spanish: pick it the way a user would (a real keyboard gesture on the select).
await b.click('[data-pop="#morePop"]');
await b.focus('#tlSel');
for (let i = 0; i < 2 && (await b.inputValue('#tlSel')) !== 'es'; i++) await b.keyboard.press('ArrowDown');
if ((await b.inputValue('#tlSel')) !== 'es') await b.selectOption('#tlSel', 'es');
await b.keyboard.press('Escape');

// Meeting context: a whiteboard pin and a proposal.
await a.keyboard.press('w');
await a.click('[data-board-tool="pin"]');
const board = await a.locator('#boardCanvas').boundingBox();
await a.mouse.click(board.x + board.width * 0.3, board.y + board.height * 0.4);
await a.fill('#board .pin-pop input', 'Launch deck v3 is in review');
await a.press('#board .pin-pop input', 'Enter');
await a.keyboard.press('w');
await a.keyboard.press('b');
await openPanel(a, 'notes');
await a.click('#transcript .note .propose');
await a.fill('#notices [data-key="propose"] textarea', 'Ship the launch deck on Friday');
await a.click('#notices [data-key="propose"] .btn.primary');
await b.waitForFunction(() => document.querySelector('#notices .notice.proposal blockquote')?.textContent === 'Ship the launch deck on Friday');
await b.waitForFunction(() => [...document.querySelectorAll('#transcript .note-pin p')].some((x) => x.textContent === 'Launch deck v3 is in review'));
await a.click('#closePanel');
t.step('meeting context: whiteboard pin #1 + proposal');

// Ada asks, in English.
await a.keyboard.press('l');
await b.waitForSelector('#copilot .copilot', { timeout: 15_000 });

if (translation === true) {
  await b.waitForFunction(() => [...document.querySelectorAll('#transcript li:not(.note) small')].some((x) => x.textContent.includes('translated')), null, { timeout: 15_000 });
  const line = await b.evaluate(() => { const li = [...document.querySelectorAll('#transcript li:not(.note)')].at(-1); return { shown: li.querySelector('p').textContent, original: li.title }; });
  assert.equal(line.original, 'What is the status of the launch deck?');
  assert.notEqual(line.shown, line.original, 'Bo reads it in Spanish');
  assert.match(line.shown, /estado/i);
  t.step(`Bo sees Ada’s caption translated on-device: “${line.shown}”`);
} else {
  console.log(`  ↷ caption translation SKIPPED: ${translation}`);
}

const card = await b.evaluate(() => {
  const el = document.querySelector('#copilot .copilot');
  const items = [...el.querySelectorAll('.cp-answers li')].map((li) => ({
    native: li.querySelector('.cp-text').textContent,
    spoken: li.querySelector('.cp-say').textContent,
    tags: [...li.querySelectorAll('.cp-tag')].map((x) => x.textContent),
  }));
  return { privacy: el.querySelector('small').textContent, intent: el.querySelector('.cp-intent').textContent, basis: el.querySelector('.cp-basis').textContent, items };
});
assert.match(card.privacy, /^Only you can see this/);
assert.match(card.intent, /^Ada pide una actualización: «.+»$/, 'what is being asked, in Bo’s language');
if (translation === true) assert.match(card.intent, /estado/i, 'the quoted question itself is translated');
assert.equal(card.items.length, 2, 'two ranked answers');
assert.deepEqual(card.items[0], {
  native: 'Estado rápido: Launch deck v3 is in review. Siguiente paso: Ship the launch deck on Friday.',
  spoken: 'Quick status: Launch deck v3 is in review. Next step: Ship the launch deck on Friday.',
  tags: ['ES', 'EN'],
}, 'best answer grounded in the pin and the proposal, in Spanish and in Ada’s English');
assert.match(card.items[1].spoken, /written update by Friday/, 'second answer reuses the agreed date');
assert.equal(card.basis, 'Basado en: pin n.º 1 · propuesta');
assert.equal(await a.locator('#copilot .copilot').count(), 0, 'Ada never sees Bo’s co-pilot');
await b.waitForTimeout(400);
await t.shot(b, 'c1-copilot.png');
t.step('private Co-Pilot card: Spanish intent + 2 grounded, bilingual answers');

await b.click('#copilot .cp-answers li:first-child .cp-send');
await a.waitForFunction(() => document.querySelector('#chatList').textContent.includes('Quick status: Launch deck v3 is in review. Next step: Ship the launch deck on Friday.'));
assert.equal(await b.locator('#copilot .copilot').count(), 0, 'card steps aside once used');
t.step('one click: the English reply reached Ada in the meeting chat');
await t.finish();
