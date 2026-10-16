import test from 'node:test';
import assert from 'node:assert/strict';
import { gloss, glossable } from './public/glossary.js';

test('caption dictionary: instant approximate translation, longest phrase first', () => {
  assert.equal(gloss('What is the status of the launch deck?', 'en', 'es'), '¿Cuál es el estado del lanzamiento presentación?', 'phrases, contraction, Spanish question mark');
  assert.equal(gloss('¿Cuál es el estado del proyecto?', 'es', 'en'), 'What is the status of the project?');
  assert.match(gloss('What is the status of the launch deck?', 'en', 'hi'), /^क्या है स्थिति का लॉन्च/, 'Devanagari out; Hindi drops articles');
  assert.equal(gloss('लॉन्च की स्थिति क्या है?', 'hi', 'en'), 'launch of status what is?', 'Devanagari in (word order stays the speaker’s: a gloss)');
  assert.equal(gloss('Can we send the report by Friday?', 'en', 'de'), 'Kann wir senden der Bericht bis Freitag?', 'German nouns keep their capitals');
  assert.equal(gloss('I don’t think Friday is realistic', 'en', 'es'), 'Yo no creo viernes es realista', 'curly apostrophes; weekdays not capitalised mid-sentence');
  assert.equal(gloss('Él no está listo', 'es', 'en'), 'He no is ready', 'accented “él” is “he”, plain “el” is “the”');
  assert.equal(gloss('Next step: ship it. Thanks!', 'en', 'fr'), 'Prochaine étape: lancer ça. Merci!', 'sentence starts capitalised');
  assert.equal(gloss('Ship v2 on Friday, 20% off', 'en', 'it'), 'Lanciare v2 su venerdì, 20% off', 'unknown tokens and numbers pass through');
});

test('caption dictionary: honest about what it can’t do', () => {
  assert.equal(gloss('Xyzzy plugh', 'en', 'es'), null, 'nothing recognised: no fake translation');
  assert.equal(gloss('Hello Ada', 'en', 'ja'), null, 'pair not covered');
  assert.equal(glossable('en', 'en'), false);
  assert.equal(glossable('hi', 'pt'), true, 'any pair of the seven, through the shared meaning table');
  assert.equal(gloss('Hola equipo', 'es', 'pt'), 'Olá equipe');
});
