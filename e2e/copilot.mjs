// Live Polyglot + private Co-Pilot, end to end in real Chrome:
// Ada speaks English and asks for a status update; Bo has chosen Spanish. Bo sees the caption
// translated on-device, plus a Co-Pilot card that only Bo can see: the question in Spanish and two
// ranked replies grounded in this meeting's whiteboard pin and signed-off proposal, each in Spanish
// and in Ada's English. "Speak to room" has every other browser say it aloud (Ada has a voice; Cy has
// none and gets the text-only fallback) and shows it on Bo's tile; "Send" posts it to the chat.
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
const a = await t.page('A', { speech: ['What is the status of the launch deck?'], tts: 'stub' });
await join(a, url, 'Ada');
await a.waitForSelector('#room:not([hidden])');
const b = t.wire(await ctxB.newPage(), 'B');
await join(b, url, 'Bo');
await b.waitForSelector('#room:not([hidden])');
const c = await t.page('C', { tts: 'mute' });
await join(c, url, 'Cy');
await c.waitForSelector('#room:not([hidden])');
await Promise.all([liveVideo(a), liveVideo(b), liveVideo(c)]);

// Bo speaks Spanish: pick it the way a user would (a real keyboard gesture on the select).
await b.click('#langBtn');
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

// Speak to room: Bo's chosen English reply is voiced by every other browser and shown on Bo's tile.
const loudness = (p, who, ms) => p.evaluate(async ([who, ms]) => {
  const tile = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.name')?.textContent === who);
  let max = 0;
  for (const end = Date.now() + ms; Date.now() < end;) { max = Math.max(max, Number(tile.style.getPropertyValue('--lvl') || 0)); await new Promise((r) => setTimeout(r, 100)); }
  return max;
}, [who, ms]);
assert.ok((await loudness(b, 'Ada', 3000)) > 0.05, 'before: Bo hears Ada’s microphone');
const reply = card.items[0].spoken;
await b.click('#copilot .cp-answers li:first-child .cp-speak');
const bannerOf = (p) => p.waitForFunction(() => {
  const tile = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.name')?.textContent.startsWith('Bo'));
  const el = tile?.querySelector('.spoken');
  return el && !el.hidden && el.querySelector('.sp-meta').textContent && { text: el.querySelector('p').textContent, meta: el.querySelector('.sp-meta').textContent };
}, null, { timeout: 8000 }).then((h) => h.jsonValue());
const [onAda, onCy, onBo] = await Promise.all([bannerOf(a), bannerOf(c), bannerOf(b)]);
assert.deepEqual(onAda, { text: reply, meta: 'TrueMeet voice · EN' }, 'Ada sees the reply on Bo’s tile while her browser speaks it');
assert.deepEqual(await a.evaluate(() => window.__spoken), [{ text: reply, lang: 'en-US', voice: 'Test voice' }], 'spoken aloud in English with an English voice');
assert.deepEqual(onCy, { text: reply, meta: 'Text only — no EN voice on this device' }, 'no voice installed: clean caption fallback');
assert.deepEqual(await c.evaluate(() => window.__spoken), []);
assert.deepEqual(onBo, { text: reply, meta: 'Spoken to the room — the others hear the voice' }, 'the sender’s browser stays silent');
for (const p of [a, c]) assert.ok(await p.evaluate(() => [...document.querySelectorAll('#transcript li small')].some((x) => x.textContent.startsWith('Bo · TrueMeet voice'))), 'in everyone’s notes');
assert.equal(await b.textContent('#copilot .cp-answers li:first-child .cp-speak span'), 'Spoken');
await t.shot(a, 'c2-spoken-on-tile.png'); // while the banner is up
// While Ada's speakers voice the reply, her mic is ducked, so the room doesn't hear it twice.
await b.waitForTimeout(500); // audio already in flight plays out first
const duringVoice = await loudness(b, 'Ada', 1800);
const afterVoice = await loudness(b, 'Ada', 5000);
assert.equal(duringVoice, 0, 'no echo: Ada’s mic is silent while her device speaks the reply');
assert.ok(afterVoice > 0.05, 'Ada’s mic comes back when the voice ends');
t.step(`echo-safe: Bo heard Ada’s mic at ${duringVoice} while the voice played, ${afterVoice.toFixed(2)} after`);
t.step('Speak to room: voiced on Ada’s device, text-only fallback on Cy’s, banner on Bo’s tile for all');

await b.click('#copilot .cp-answers li:first-child .cp-send');
await a.waitForFunction(() => document.querySelector('#chatList').textContent.includes('Quick status: Launch deck v3 is in review. Next step: Ship the launch deck on Friday.'));
assert.equal(await b.locator('#copilot .copilot').count(), 0, 'card steps aside once used');
t.step('one click: the English reply reached Ada in the meeting chat');
await t.finish();
