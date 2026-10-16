// Built-in caption dictionary: an instant, offline, approximate word-and-phrase translation for
// when Chrome's on-device translator is missing, still downloading, or has no model for a pair.
// It is a gloss, not a translator — word order and grammar stay the speaker's — so the UI always
// marks it "≈". Pure and unit-tested in glossary.test.js.
//
// One row per meaning: en | es | fr | de | hi | pt | it. "a/b" lists alternatives: the first is
// what gets written, all of them are recognised. An empty cell means "drop it" (Hindi has no
// articles). Matching is longest phrase first, so "next step" beats "next" + "step".
export const GLOSS_LANGS = ['en', 'es', 'fr', 'de', 'hi', 'pt', 'it'];
const ROWS = `
hello/hi/hey | hola | bonjour/salut | hallo | नमस्ते | olá/oi | ciao
good morning | buenos días | bonjour | guten Morgen | सुप्रभात | bom dia | buongiorno
thank you/thanks | gracias | merci | danke | धन्यवाद/शुक्रिया | obrigado/obrigada | grazie
please | por favor | s'il vous plaît | bitte | कृपया | por favor | per favore
sorry | perdón/lo siento | désolé/pardon | Entschuldigung | माफ़ कीजिए/सॉरी | desculpe | scusa/scusi
yes | sí | oui | ja | हाँ/हां | sim | sì
no | no | non | nein | नहीं | não | no
okay/ok | de acuerdo/vale | d'accord | okay/in Ordnung | ठीक है | tudo bem | va bene
welcome | bienvenidos/bienvenido | bienvenue | willkommen | स्वागत | bem-vindos | benvenuti
goodbye/bye | adiós | au revoir | tschüss/auf Wiedersehen | अलविदा | tchau | arrivederci
how are you | cómo estás | comment ça va | wie geht's | आप कैसे हैं | como vai | come stai
what is | cuál es/qué es | quel est/qu'est-ce que | was ist | क्या है | qual é/o que é | qual è/cos'è
what | qué | quoi/que | was | क्या | o que/que | cosa/che
when | cuándo | quand | wann | कब | quando | quando
where | dónde | où | wo | कहाँ/कहां | onde | dove
who | quién | qui | wer | कौन | quem | chi
why | por qué | pourquoi | warum | क्यों | por que/por quê | perché
how much | cuánto | combien | wie viel | कितना | quanto | quanto
how | cómo | comment | wie | कैसे | como | come
which | cuál | quel/quelle | welche/welcher | कौन सा | qual | quale
let's/let us | vamos a | allons | lass uns | चलो | vamos | andiamo
next step | siguiente paso/próximo paso | prochaine étape | nächster Schritt | अगला कदम | próximo passo | prossimo passo
action item | tarea pendiente | point d'action | Aufgabe | एक्शन आइटम | item de ação | azione
I | yo | je/j' | ich | मैं | eu | io
you | tú/usted | vous/tu | du/Sie | आप/तुम | você | tu
we | nosotros | nous | wir | हम | nós | noi
they | ellos | ils/elles | sie | वे/वो | eles | loro
he | él | il | er | वह | ele | lui
she | ella | elle | sie | वह | ela | lei
it | eso | ça/cela | es | यह | isso | esso
my | mi | mon/ma/mes | mein/meine | मेरा/मेरी | meu/minha | mio/mia
your | tu/su | votre/ton/ta | dein/Ihr | आपका/आपकी | seu/sua | tuo/tua
our | nuestro/nuestra | notre/nos | unser/unsere | हमारा/हमारी | nosso/nossa | nostro/nostra
this | este/esta/esto | ce/cette/ceci | dieser/diese/dies | यह/ये | este/esta/isto | questo/questa
that | ese/esa/eso | cela | das | वह/वो | esse/essa | quello/quella
is | es/está | est | ist | है | é/está | è
are | son/están | sont | sind | हैं | são/estão | sono
am | soy/estoy | suis | bin | हूँ/हूं | sou/estou | sono
was | era/fue/estaba | était | war | था/थी | era/foi | era
have | tengo/tenemos | ai/avons | habe/haben | पास है | tenho/temos | ho/abbiamo
has | tiene | a | hat | पास है | tem | ha
can | puede/puedo/podemos | peut/peux/pouvons | kann/können | सकते/सकता | pode/podemos | può/possiamo
need | necesitamos/necesito | besoin | brauchen/brauche | ज़रूरत/जरूरत | precisamos/preciso | bisogno
want | queremos/quiero | voulons/veux | wollen/möchte | चाहते/चाहिए | queremos/quero | vogliamo/voglio
do | hacer | faire | machen/tun | करना/करें | fazer | fare
send | enviar/envío | envoyer | senden/schicken | भेजना/भेजें | enviar | inviare
sends | envía | envoie | sendet/schickt | भेजता/भेजती | envia | invia
ship/release | lanzar | lancer | veröffentlichen | लॉन्च करना | lançar | lanciare
launch | lanzamiento | lancement | Launch/Start | लॉन्च | lançamento | lancio
share | compartir | partager | teilen | शेयर/साझा | compartilhar | condividere
see | ver | voir | sehen | देखना/देखें | ver | vedere
know | saber/sé | savoir/sais | wissen/weiß | पता/जानना | saber/sei | sapere/so
think | creo/pienso | pense/crois | denke/glaube | लगता/सोचता | acho/penso | penso/credo
agree | de acuerdo | d'accord | einverstanden | सहमत | concordo | d'accordo
finish | terminar | terminer/finir | beenden/fertig | पूरा/ख़त्म | terminar | finire
start | empezar/comenzar | commencer | anfangen/beginnen | शुरू | começar | iniziare
review | revisión/revisar | révision/revoir | Prüfung/prüfen | समीक्षा | revisão/revisar | revisione/rivedere
update | actualización | mise à jour | Update/Aktualisierung | अपडेट | atualização | aggiornamento
go | ir | aller | gehen | जाना/चलें | ir | andare
talk/speak | hablar | parler | sprechen/reden | बात/बोलना | falar | parlare
call | llamada | appel | Anruf | कॉल | chamada | chiamata
pay | pagar | payer | bezahlen | भुगतान | pagar | pagare
cost/costs | cuesta/costar | coûte/coûter | kostet/kosten | लागत | custa/custar | costa/costare
help | ayuda/ayudar | aide/aider | Hilfe/helfen | मदद | ajuda/ajudar | aiuto/aiutare
ready | listo | prêt | bereit/fertig | तैयार | pronto | pronto
done | hecho | fait/terminé | erledigt | हो गया | feito | fatto
try | intentar | essayer | versuchen | कोशिश | tentar | provare
work | trabajo/trabajar | travail/travailler | Arbeit/arbeiten | काम | trabalho/trabalhar | lavoro/lavorare
works | funciona | fonctionne/marche | funktioniert | काम करता | funciona | funziona
understand | entiendo/entender | comprends/comprendre | verstehe/verstehen | समझ/समझना | entendo/entender | capisco/capire
meeting | reunión | réunion | Besprechung/Meeting | मीटिंग/बैठक | reunião | riunione
team | equipo | équipe | Team | टीम | equipe | squadra
project | proyecto | projet | Projekt | प्रोजेक्ट/परियोजना | projeto | progetto
status | estado | statut/état | Status/Stand | स्थिति | situação/status | stato
deadline | fecha límite/plazo | date limite/échéance | Frist/Deadline | डेडलाइन/समय सीमा | prazo | scadenza
price | precio | prix | Preis | कीमत/दाम | preço | prezzo
budget | presupuesto | budget | Budget | बजट | orçamento | budget
plan | plan | plan | Plan | योजना/प्लान | plano | piano
step | paso | étape | Schritt | कदम | passo | passo
question | pregunta | question | Frage | सवाल/प्रश्न | pergunta | domanda
answer | respuesta | réponse | Antwort | जवाब/उत्तर | resposta | risposta
problem/issue | problema | problème | Problem | समस्या | problema | problema
idea | idea | idée | Idee | विचार | ideia | idea
customer/client | cliente | client | Kunde | ग्राहक | cliente | cliente
product | producto | produit | Produkt | प्रोडक्ट/उत्पाद | produto | prodotto
version | versión | version | Version | वर्ज़न/संस्करण | versão | versione
report | informe | rapport | Bericht | रिपोर्ट | relatório | rapporto
document | documento | document | Dokument | दस्तावेज़ | documento | documento
deck/slides/presentation | presentación/diapositivas | présentation | Präsentation | प्रेज़ेंटेशन/प्रस्तुति | apresentação | presentazione
screen | pantalla | écran | Bildschirm | स्क्रीन | tela | schermo
time | tiempo/hora | temps/heure | Zeit | समय | tempo/hora | tempo/ora
day | día | jour | Tag | दिन | dia | giorno
week | semana | semaine | Woche | हफ़्ता/सप्ताह | semana | settimana
month | mes | mois | Monat | महीना | mês | mese
year | año | année/an | Jahr | साल/वर्ष | ano | anno
today | hoy | aujourd'hui | heute | आज | hoje | oggi
tomorrow | mañana | demain | morgen | कल | amanhã | domani
yesterday | ayer | hier | gestern | बीता कल | ontem | ieri
now | ahora | maintenant | jetzt | अभी | agora | adesso/ora
later | más tarde/luego | plus tard | später | बाद में | mais tarde/depois | più tardi/dopo
soon | pronto | bientôt | bald | जल्द | em breve | presto
monday | lunes | lundi | Montag | सोमवार | segunda-feira | lunedì
tuesday | martes | mardi | Dienstag | मंगलवार | terça-feira | martedì
wednesday | miércoles | mercredi | Mittwoch | बुधवार | quarta-feira | mercoledì
thursday | jueves | jeudi | Donnerstag | गुरुवार | quinta-feira | giovedì
friday | viernes | vendredi | Freitag | शुक्रवार | sexta-feira | venerdì
saturday | sábado | samedi | Samstag | शनिवार | sábado | sabato
sunday | domingo | dimanche | Sonntag | रविवार | domingo | domenica
money | dinero | argent | Geld | पैसा/पैसे | dinheiro | soldi
dollars | dólares | dollars | Dollar | डॉलर | dólares | dollari
euros | euros | euros | Euro | यूरो | euros | euro
percent | por ciento | pour cent | Prozent | प्रतिशत | por cento | per cento
the | el/la/los/las | le/la/les/l' | der/die/das/den/dem | | o/a/os/as | il/la/lo/i/gli/le/l'
a/an | un/una | un/une | ein/eine/einen | एक | um/uma | un/una/uno
of | de | de/d' | von | का/की/के | de | di
to | a | à | zu/nach | को | para | a
in | en | dans/en | in/im | में | em | in
on | sobre | sur | auf/am | पर | sobre | su
for | para/por | pour | für | के लिए | para/por | per
with | con | avec | mit | के साथ | com | con
by | para | d'ici | bis | तक | até | entro
from | desde | depuis | von/aus | से | desde | da
and | y | et | und | और | e | e
or | o | ou | oder | या | ou | o
but | pero | mais | aber | लेकिन | mas | ma
not | no | pas/ne | nicht | नहीं | não | non
don't/do not/doesn't/does not | no | ne/pas | nicht | नहीं | não | non
can't/cannot/can not | no puede/no podemos | ne peut pas | kann nicht | नहीं सकते | não pode | non può
of the | del | du | des/vom | का | do/da | del
to the | al | au | zum/zur | को | ao | al
all | todo/todos | tout/tous | alle/alles | सब/सभी | todo/todos | tutto/tutti
everyone | todos | tout le monde | alle | सभी | todos | tutti
very | muy | très | sehr | बहुत | muito | molto
more | más | plus | mehr | ज़्यादा | mais | più
good | bueno/bien | bon/bien | gut | अच्छा | bom/bem | buono/bene
great | genial/excelente | génial/super | großartig/super | बढ़िया | ótimo | ottimo
bad | malo | mauvais | schlecht | बुरा | ruim | male
new | nuevo/nueva | nouveau/nouvelle | neu/neue | नया/नई | novo/nova | nuovo/nuova
first | primero | premier/première | erste | पहला/पहले | primeiro | primo
last | último | dernier | letzte | आख़िरी | último | ultimo
next | siguiente/próximo | prochain | nächste | अगला | próximo | prossimo
here | aquí | ici | hier | यहाँ/यहां | aqui | qui
there | allí | là | dort | वहाँ/वहां | lá | lì
also | también | aussi | auch | भी | também | anche
again | otra vez/de nuevo | encore | wieder/nochmal | फिर से | de novo | di nuovo
because | porque | parce que | weil | क्योंकि | porque | perché
if | si | si | wenn/falls | अगर | se | se
so | así que/entonces | donc/alors | also | तो | então | quindi
only | solo | seulement | nur | सिर्फ़/केवल | só/apenas | solo
some | algunos | quelques | einige | कुछ | alguns | alcuni
possible | posible | possible | möglich | संभव | possível | possibile
realistic | realista | réaliste | realistisch | व्यावहारिक | realista | realistico
important | importante | important | wichtig | ज़रूरी/महत्वपूर्ण | importante | importante
right/correct | correcto | correct | richtig | सही | certo/correto | giusto/corretto
wrong | incorrecto | faux | falsch | ग़लत/गलत | errado | sbagliato
late | tarde | en retard | spät | देर | atrasado | in ritardo
early | temprano | tôt | früh | जल्दी | cedo | presto
`;
// Native contractions after word-by-word substitution ("de el" → "del").
const CONTRACT = {
  es: [[/\bde el\b/gi, 'del'], [/\ba el\b/gi, 'al']],
  fr: [[/\bde le\b/gi, 'du'], [/\bà le\b/gi, 'au'], [/\bde les\b/gi, 'des'], [/\bà les\b/gi, 'aux']],
  pt: [[/\bde o\b/gi, 'do'], [/\bde a\b/gi, 'da'], [/\bem o\b/gi, 'no'], [/\bem a\b/gi, 'na']],
  it: [[/\bdi il\b/gi, 'del'], [/\ba il\b/gi, 'al'], [/\bin il\b/gi, 'nel']],
};
const MAX_WORDS = 4;
const WORD_RE = /[\p{L}\p{M}\p{N}'’-]+/gu;
// Lowercase, curly apostrophes straightened, Latin accents folded (users and recognisers disagree
// on them); Devanagari vowel signs are combining marks too, so only U+0300–036F is folded.
const fold = (s) => s.toLowerCase().replace(/’/g, "'").normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

const table = ROWS.trim().split('\n').map((row) => row.split('|').map((cell) => cell.trim().split('/').map((v) => v.trim()).filter(Boolean)));
// Per language: exact (lowercase) forms win over accent-folded ones, so "el" (the) never
// becomes "él" (he).
const index = Object.fromEntries(GLOSS_LANGS.map((lang, li) => {
  const exact = new Map(), folded = new Map();
  table.forEach((row, i) => {
    for (const form of row[li]) {
      if (!exact.has(form.toLowerCase())) exact.set(form.toLowerCase(), i);
      if (!folded.has(fold(form))) folded.set(fold(form), i);
    }
  });
  return [lang, { get: (phrase) => exact.get(phrase.toLowerCase().replace(/’/g, "'")) ?? folded.get(fold(phrase)) }];
}));

export const glossable = (src, dst) => src !== dst && GLOSS_LANGS.includes(src) && GLOSS_LANGS.includes(dst);

// Approximate translation of `text` from src to dst, or null if the pair isn't covered or no
// word was recognised. Unknown words (names, numbers, jargon) pass through unchanged.
export function gloss(text, src, dst) {
  if (!glossable(src, dst) || typeof text !== 'string') return null;
  const words = [...text.matchAll(WORD_RE)], from = index[src], to = GLOSS_LANGS.indexOf(dst);
  const out = [];
  let at = 0, hits = 0;
  for (let i = 0; i < words.length;) {
    let n = Math.min(MAX_WORDS, words.length - i), row;
    for (; n > 0; n--) {
      const span = words.slice(i, i + n);
      if (span.some((w, k) => k && text.slice(span[k - 1].index + span[k - 1][0].length, w.index).trim())) continue; // phrases don't cross punctuation
      row = from.get(span.map((w) => w[0]).join(' '));
      if (row !== undefined) break;
    }
    const first = words[i], last = words[i + Math.max(n, 1) - 1];
    out.push(text.slice(at, first.index));
    if (row === undefined) out.push(first[0]);
    else {
      hits++;
      const before = text.slice(0, first.index), opens = !/\p{L}/u.test(before) || /[.?!][^\p{L}]*$/u.test(before); // sentence start
      const word = table[row][to][0] ?? '', upper = opens && /^\p{Lu}/u.test(first[0]) && /^\p{Ll}/u.test(word);
      out.push(upper ? word[0].toUpperCase() + word.slice(1) : word);
    }
    at = last.index + last[0].length;
    i += Math.max(n, 1);
  }
  if (!hits) return null;
  let result = (out.join('') + text.slice(at)).replace(/ {2,}/g, ' ').replace(/ ([,.?!])/g, '$1').trim();
  for (const [re, rep] of CONTRACT[dst] ?? []) result = result.replace(re, rep);
  if (dst === 'es' && /\?$/.test(result) && !result.startsWith('¿')) result = `¿${result}`;
  if (dst !== 'es') result = result.replace(/[¿¡]/g, '');
  return result;
}
