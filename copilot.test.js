import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, clean, detectIntent, extractEntities, relevantFacts, renderAnswer, renderBasis, renderIntent, speakable, transliterate } from './public/copilot.js';

const kind = (text, lang) => detectIntent(text, lang)?.kind ?? null;

test('intent detection across languages, without needing punctuation', () => {
  assert.equal(kind('What is the status of the launch deck'), 'status');
  assert.equal(kind('any updates on the migration'), 'status');
  assert.equal(kind('I don’t think Friday is realistic'.replace('’', "'")), 'objection');
  assert.equal(kind('Can we do it for $5k?'), 'price');
  assert.equal(kind('We can offer it at 4,000 dollars'), 'price', 'a price proposal is a moment even without a question');
  assert.equal(kind('Let’s ship by Friday'.replace('’', "'")), 'deadline');
  assert.equal(kind('Who owns the onboarding flow'), 'question');
  assert.equal(kind('I will share my screen now'), null, 'plain talk is not a moment');
  assert.equal(kind('the cost of coffee went up'), null, 'pricing words in passing without an amount or a question');
  assert.equal(kind('¿Cuándo podemos lanzar la versión dos?', 'es'), 'deadline');
  assert.equal(kind('¿Cuál es el estado del proyecto?', 'es'), 'status');
  assert.equal(kind('क्या लॉन्च की स्थिति ठीक है?', 'hi'), 'status');
  assert.equal(kind("Je ne pense pas que ce soit possible", 'fr'), 'objection');
  assert.equal(kind('Was kostet das Paket?', 'de'), 'question');
  assert.equal(kind('Wie viel kostet das Paket?', 'de'), 'price');
});

test('entities: money, dates, percentages', () => {
  assert.deepEqual(extractEntities('Can we do $5k by Friday, or 20% off by March 3?'), { dates: ['Friday', 'March 3'], money: ['$5k'], percents: ['20%'] });
  assert.deepEqual(extractEntities('cerramos el viernes con 3.000 euros'), { dates: ['viernes'], money: ['3.000 euros'], percents: [] });
});

const state = {
  pins: [{ n: 1, note: 'Launch deck v3 is in review', t: 100 }, { n: 2, note: 'Old logo still on slide 4', t: 90, resolved: true }],
  proposals: [{ text: 'Ship the launch deck on Friday', proposer: 'Ada', t: 120 }],
  highlights: [{ context: 'Ada: “Budget stays at $40k for Q3”', auto: true, reason: 'decision', t: 80 }],
  cards: [{ caption: 'Bo’s screen · 10:42', t: 70 }],
  captions: [{ name: 'Cy', text: 'the onboarding emails are drafted', t: 60 }],
};

test('context retrieval: relevant, weighted by intent, resolved pins ignored', () => {
  const status = relevantFacts('What is the status of the launch deck', 'status', state);
  assert.deepEqual(status.map((f) => [f.kind, f.text]), [['pin', 'Launch deck v3 is in review'], ['proposal', 'Ship the launch deck on Friday']], 'for status, current-state pins beat decisions');
  const deadline = relevantFacts('When can we ship the launch deck', 'deadline', state);
  assert.equal(deadline[0].kind, 'proposal', 'for deadlines, decisions come first');
  const price = relevantFacts('What is the budget for this', 'price', state);
  assert.equal(price[0].text, 'Budget stays at $40k for Q3', 'wrappers stripped, money-bearing fact preferred');
  assert.deepEqual(relevantFacts('Something about logos', 'question', state), [], 'resolved pin does not count');
  assert.equal(clean('Ada: “Action item: send it.”'), 'Action item: send it');
});

test('grounded, ranked, bilingual answers', () => {
  const a = analyze({ text: 'What is the status of the launch deck', lang: 'en', speaker: 'Ada', state });
  assert.equal(a.kind, 'status');
  const [first, second] = a.answers;
  assert.equal(renderAnswer(a, first, 'en'), 'Quick status: Launch deck v3 is in review. Next step: Ship the launch deck on Friday.');
  assert.equal(renderAnswer(a, first, 'es'), 'Estado rápido: Launch deck v3 is in review. Siguiente paso: Ship the launch deck on Friday.', 'native phrasing, facts quoted verbatim');
  assert.equal(renderAnswer(a, second, 'en'), 'We’re on track — I’ll send a written update by Friday.', 'the date comes from the meeting’s own proposal');
  assert.equal(renderIntent(a, 'es', '¿Cuál es el estado del deck de lanzamiento?'), 'Ada pide una actualización: «¿Cuál es el estado del deck de lanzamiento?»');
  assert.equal(renderBasis(a, 'en'), 'Based on: pin #1 · proposal');
  assert.equal(renderBasis(a, 'de'), 'Basierend auf: Pin Nr. 1 · Vorschlag');

  const blank = analyze({ text: 'Can we do it for $5k?', lang: 'en', speaker: 'Bo', state: {} });
  assert.equal(blank.kind, 'price');
  assert.deepEqual(blank.answers.map((x) => x.i), [1, 0], 'no context → the honest “let me confirm” ranks first');
  assert.equal(renderAnswer(blank, blank.answers[0], 'en'), 'Let me confirm $5k and get back to you by tomorrow.');
  assert.equal(renderAnswer(blank, blank.answers[0], 'hi'), '$5k की पुष्टि करके कल तक जवाब दिया जाएगा।');
  assert.equal(renderBasis(blank, 'fr'), 'Pas encore de contexte de réunion correspondant');
  assert.equal(analyze({ text: 'I will share my screen now', state }), null);
});

test('read-aloud phrasing and pronunciation', () => {
  assert.equal(speakable('Let me confirm $5k — and 20% off', 'en'), 'Let me confirm 5 thousand dollars, and 20 percent off');
  assert.equal(speakable('Confirmo €3k y el 15%', 'es'), 'Confirmo 3 mil euros y el 15 por ciento');
  assert.equal(transliterate('क्या स्थिति है'), 'kya sthiti hai');
  assert.equal(transliterate('लॉन्च डेक कब तक'), 'lonch dek kab tak');
  assert.equal(transliterate('Pin #1 कल'), 'Pin #1 kal', 'Latin text untouched');
});
