// Original two-person meeting: lobby → join → live video both ways → hand, chat, reactions →
// host mute-all → camera off → speaker view → phone layout → host removes guest.
import { assert, join, liveVideo, openPanel, suite } from './lib.mjs';

const t = await suite('two-person meeting');
const a = await t.page('A');
await a.goto(t.base);
await a.waitForSelector('#home:not([hidden])');
await t.shot(a, '1-home.png');
await a.click('.new-meeting >> nth=0');
await a.waitForSelector('#lobby:not([hidden])');
const room = new URL(a.url()).pathname;
await a.waitForTimeout(700);
await a.fill('#name', 'Ada Lovelace');
await t.shot(a, '2-lobby.png');
await a.click('#joinBtn');
await a.waitForSelector('#room:not([hidden])');

const b = await t.page('B');
await join(b, t.base + room, 'Grace Hopper');
await b.waitForSelector('#room:not([hidden])');
await Promise.all([liveVideo(a), liveVideo(b)]);
t.step('both sides see live video');

await b.click('#handBtn');
await b.click('#chatBtn');
await b.fill('#chatInput', 'Hey Ada — ready to ship TrueMeet? 🚀');
await b.press('#chatInput', 'Enter');
await a.waitForFunction(() => document.querySelector('.tile:not(.local)')?.classList.contains('hand'));
await a.click('[data-pop="#reactPop"]');
await a.click('#reactPop button >> nth=4');
await a.waitForTimeout(400);
await t.shot(a, '3-room.png');
await openPanel(a, 'people');
assert.match(await a.textContent('#chatList'), /ready to ship TrueMeet/, 'chat delivered');
assert.ok(await a.isVisible('#hostTools'), 'host tools visible to host');
assert.equal(await a.textContent('#unread'), '1', 'unread badge');
await a.waitForFunction(() => document.querySelector('.tile:not(.local)')?.dataset.q === '3', null, { timeout: 8000 });
t.step('hand, chat, reactions, quality bars');

await a.click('#muteAll');
await b.waitForFunction(() => document.querySelector('.dock .mic-ctl').classList.contains('off'));
await b.keyboard.press('Escape');
await b.click('#stage');
await b.keyboard.press('v');
await a.waitForFunction(() => document.querySelector('.tile:not(.local)')?.classList.contains('cam-off'));
await a.click('#closePanel');
await a.click('#viewBtn');
await a.waitForTimeout(400);
await t.shot(a, '4-speaker.png');
t.step('mute-all, camera off, speaker view');

await a.setViewportSize({ width: 390, height: 844 });
await a.waitForTimeout(300);
assert.equal(await a.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no horizontal scroll on a phone');
await t.shot(a, '5-mobile.png');
await a.setViewportSize({ width: 1440, height: 900 });

await openPanel(a, 'people');
await a.click('.people .btn.xs:has-text("Remove")');
await a.click('.people .btn.xs:has-text("Confirm")');
await b.waitForSelector('#end:not([hidden])', { timeout: 5000 });
assert.equal(await b.textContent('#endTitle'), 'The host removed you from the meeting');
t.step('host removed guest');
await t.finish();
