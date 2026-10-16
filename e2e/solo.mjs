// Alone in a room, testing captions in your own voice — the first thing anyone does.
// Chrome's Translator API is replaced at the browser boundary by one that behaves like a fresh
// profile: the en→es model must be downloaded (only after a click, with progress events, finished
// when the test says so); there is no model at all for Hindi. The fake recogniser records the
// language it was started with, and window.__say(text) makes it hear a sentence.
//  1. Pick "I speak" and "Translate to" from the Caption languages control next to the CC button.
//  2. While the model downloads, your own captions are already translated by the built-in
//     dictionary (marked ≈) and the status pill shows the download; your own question gets a
//     Co-Pilot preview card.
//  3. Download done: the pill says ready, new captions use the model, and the transcript line
//     that used the dictionary is upgraded in place.
//  4. Hindi: no model for EN → HI, the dictionary keeps captions translated; switching
//     "I speak" to हिन्दी restarts recognition in hi-IN, and HI → EN works the same way.
import { assert, downloadNotes, join, suite } from './lib.mjs';

const fakeTranslator = () => {
  const MODEL = { 'What is the status of the launch?': '¿En qué estado está el lanzamiento?', 'Thanks everyone': 'Gracias a todos' };
  window.__creates = [];
  window.Translator = { // es: downloadable; hi: no model; fr/de/it/pt: downloadable too (and must never be downloaded here)
    availability: async ({ targetLanguage: t }) => (t === 'hi' ? 'unavailable' : t === 'es' && window.__downloaded ? 'available' : 'downloadable'),
    create: ({ targetLanguage, monitor }) => {
      window.__creates.push(targetLanguage);
      if (!window.__downloaded && !navigator.userActivation.isActive) return Promise.reject(new DOMException('A download needs a user gesture', 'NotAllowedError'));
      const m = new EventTarget(), progress = (loaded) => m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }));
      monitor?.(m);
      return new Promise((resolve) => {
        setTimeout(() => progress(0.45), 100);
        window.__finishDownload = () => { progress(1); window.__downloaded = true; resolve({ translate: async (text) => MODEL[text] ?? `(es) ${text}` }); };
      });
    },
  };
};

const t = await suite('solo: speak, translate yourself, preview the Co-Pilot');
const a = await t.page('A', { speech: [] });
await a.context().addInitScript(fakeTranslator);
await join(a, `${t.base}/tst-solo-${Date.now().toString(36)}`, 'Ada');
await a.waitForSelector('#room:not([hidden])');
assert.ok(await a.isVisible('#alone'), 'nobody else is here');

// 1. The two pickers sit next to the captions button.
const choose = async (sel, value) => { // a real keyboard gesture, like a user (a model download needs one)
  if (await a.isHidden('#langPop')) await a.click('#langBtn');
  await a.focus(sel);
  const options = await a.$$eval(`${sel} option`, (os) => os.map((o) => o.value));
  const from = options.indexOf(await a.inputValue(sel)), to = options.indexOf(value);
  for (let i = 0; i < Math.abs(to - from); i++) await a.keyboard.press(to > from ? 'ArrowDown' : 'ArrowUp');
  assert.equal(await a.inputValue(sel), value);
};
await choose('#speakSel', 'en-US');
await choose('#tlSel', 'es');
await a.waitForFunction(() => /^EN → ES · downloading model 45% · dictionary meanwhile$/.test(document.querySelector('#tlPill span').textContent));
assert.match(await a.textContent('#tlStatus'), /downloading model 45%/, 'the same status inside the picker');
await a.keyboard.press('Escape');
await t.shot(a, 's1-picker.png');
t.step('Caption languages next to CC: I speak English (US), translate to Español; pill: “EN → ES · downloading model 45%”');

// 2. Speak while the model downloads.
await a.click('#ccBtn');
assert.equal(await a.evaluate(() => window.__srLang), 'en-US', 'recognition listens in the chosen language');
const ownCaption = () => a.waitForFunction(() => {
  const el = [...document.querySelectorAll('#captions div')].find((d) => d.querySelector('b')?.textContent === 'You');
  return el?.querySelector('em').textContent && { text: el.querySelector('span').textContent, tag: el.querySelector('em').textContent, original: el.title };
}, null, { timeout: 8000 }).then((h) => h.jsonValue());
await a.evaluate(() => window.__say('What is the status of the launch?'));
assert.deepEqual(await ownCaption(), { text: '¿Cuál es el estado del lanzamiento?', tag: 'EN → ES ≈', original: 'What is the status of the launch?' }, 'my own caption, translated at once by the dictionary');
const lastLine = () => a.evaluate(() => { const li = [...document.querySelectorAll('#transcript li:not(.note)')].at(-1); return { text: li.querySelector('p').textContent, meta: li.querySelector('small').textContent, original: li.title }; });
await a.waitForFunction(() => /dictionary translation/.test([...document.querySelectorAll('#transcript li:not(.note) small')].at(-1)?.textContent ?? ''));
assert.equal((await lastLine()).text, '¿Cuál es el estado del lanzamiento?');
const shown = () => a.waitForFunction(() => getComputedStyle(document.querySelector('#copilot .copilot')).opacity === '1'); // entrance animation done: really visible
const card = await a.waitForFunction(() => {
  const el = document.querySelector('#copilot .copilot');
  return el && { privacy: el.querySelector('small').textContent, intent: el.querySelector('.cp-intent').textContent, answers: el.querySelectorAll('.cp-answers li').length };
}, null, { timeout: 8000 }).then((h) => h.jsonValue());
assert.deepEqual(card, { privacy: 'Only you can see this · preview on your own speech', intent: 'Ada pide una actualización: «¿Cuál es el estado del lanzamiento?»', answers: 2 }, 'Co-Pilot preview on my own question, in Spanish');
await shown();
await t.shot(a, 's2-dictionary-copilot.png');
t.step('alone, my own question: caption “¿Cuál es el estado del lanzamiento?” [EN → ES ≈] + a private Co-Pilot preview card in Spanish');

// 3. The model finishes downloading.
await a.evaluate(() => window.__finishDownload());
await a.waitForFunction(() => document.querySelector('#tlPill span').textContent === 'EN → ES · on-device translator ready' && document.querySelector('#tlPill').dataset.state === 'ready');
await a.waitForFunction(() => [...document.querySelectorAll('#transcript li:not(.note)')].some((li) => li.querySelector('p').textContent === '¿En qué estado está el lanzamiento?'));
const upgraded = [...await a.$$eval('#transcript li:not(.note)', (els) => els.map((li) => ({ text: li.querySelector('p').textContent, meta: li.querySelector('small').textContent })))].at(-1);
assert.match(upgraded.meta, / · translated$/, 'the dictionary line was upgraded in place by the model');
await a.evaluate(() => window.__say('Thanks everyone'));
await a.waitForFunction(() => [...document.querySelectorAll('#captions div')].some((d) => d.querySelector('span').textContent === 'Gracias a todos' && d.querySelector('em').textContent === 'EN → ES'));
t.step('model ready: pill “EN → ES · on-device translator ready”, transcript line upgraded, new captions translated by the model');

// 4. Hindi: no on-device model for EN → HI here, so the dictionary carries it.
await a.waitForTimeout(3100); // the Co-Pilot suggests at most every 3 s
await choose('#tlSel', 'hi'); // arrows through Français, Deutsch, Italiano, Português on the way
await a.waitForFunction(() => document.querySelector('#tlPill span').textContent === 'EN → HI · built-in dictionary (approximate)');
await a.waitForFunction(() => /translated to हिन्दी/.test(document.querySelector('#toasts').textContent));
assert.deepEqual(await a.evaluate(() => window.__creates), ['es'], 'only the language actually chosen was ever downloaded');
assert.doesNotMatch(await a.textContent('#toasts'), /Français|Deutsch|Italiano|Português/, 'one toast, for where the arrows stopped');
await a.evaluate(() => window.__say('What is the status of the launch?'));
const hindi = await ownCaption();
assert.equal(hindi.tag, 'EN → HI ≈');
assert.match(hindi.text, /स्थिति/, `Devanagari caption: ${hindi.text}`);
await a.waitForFunction(() => /स्थिति की जानकारी चाहते हैं/.test(document.querySelector('#copilot .cp-intent')?.textContent ?? ''), null, { timeout: 8000 }); // the card, in Hindi
await choose('#speakSel', 'hi-IN');
await a.waitForFunction(() => window.__srLang === 'hi-IN');
assert.ok(await a.isHidden('#tlPill'), 'I speak Hindi and read Hindi: nothing to translate');
await choose('#tlSel', 'en');
await a.keyboard.press('Escape');
await a.waitForTimeout(3100); // Co-Pilot rate limit
await a.evaluate(() => window.__say('लॉन्च की स्थिति क्या है?'));
const back = await ownCaption();
assert.deepEqual([back.text, back.tag], ['launch of status what is?', 'HI → EN ≈']);
await a.waitForFunction(() => /wants a status update/.test(document.querySelector('#copilot .cp-intent')?.textContent ?? ''));
await shown();
await t.shot(a, 's3-hindi.png');
t.step('Hindi: EN → HI by dictionary (“स्थिति”) + Co-Pilot card in Hindi; I speak हिन्दी restarts recognition in hi-IN; HI → EN caption + Co-Pilot card in English');

const notes = await downloadNotes(a);
assert.match(notes, /Ada: What is the status of the launch\?\n\s+→ ¿En qué estado está el lanzamiento\?\n/, 'notes: the upgraded model translation');
assert.match(notes, /→ .*स्थिति.*\(≈ dictionary\)/, 'notes: dictionary lines are marked');
t.step('notes keep originals, model translations, and mark dictionary ones “≈ dictionary”');
await t.finish();
