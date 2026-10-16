// Private Co-Pilot: what is being asked (in any of 7 languages), which meeting facts answer it, and
// two ranked replies rendered natively in both the listener's and the speaker's language.
// Pure and deterministic (unit-tested in copilot.test.js), so it works offline and in tests; the app
// can optionally refine wording with Chrome's on-device LanguageModel.
// Meeting facts (pins, highlights, proposals…) are quoted verbatim, never machine-translated:
// a commitment should read exactly as it was written.

export const LANGS = ['en', 'es', 'fr', 'de', 'hi', 'pt', 'it'];
export const KINDS = ['objection', 'price', 'deadline', 'status', 'question']; // priority order
const lang = (l) => (LANGS.includes(l) ? l : 'en');

// Whole-word matching that works for every script (\b only understands ASCII).
const words = (alts) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alts})(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
const lead = (alts) => new RegExp(`^\\s*(?:${alts})(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
const CUES = {
  objection: {
    en: words("i don'?t think|i disagree|not sure (?:that|about)|i'?m (?:worried|concerned)|concerned (?:about|that)|my concern|too (?:expensive|late|risky|slow|much)|that won'?t work|problem with|but what about|doesn'?t make sense"),
    es: words('no creo|no estoy de acuerdo|me preocupa|demasiado (?:caro|tarde|arriesgado)|eso no va a funcionar|pero qué pasa con'),
    fr: words("je ne pense pas|pas d'accord|je m'inquiète|trop (?:cher|tard|risqué)|ça ne marchera pas|et pour"),
    de: words('ich glaube nicht|nicht einverstanden|bedenken|zu (?:teuer|spät|riskant)|das funktioniert nicht'),
    hi: words('मुझे नहीं लगता|सहमत नहीं|चिंता|बहुत महंगा'),
    pt: words('não acho|não concordo|me preocupa|caro demais'),
    it: words("non credo|non sono d'accordo|mi preoccupa|troppo caro"),
  },
  price: {
    en: words('price|pricing|cost|costs|budget|quote|discount|how much|fee|rate'),
    es: words('precio|coste|costo|presupuesto|descuento|cuánto'),
    fr: words('prix|coût|budget|remise|combien'),
    de: words('preis|kosten|budget|rabatt|wie viel'),
    hi: words('कीमत|लागत|बजट|कितना|कितने'),
    pt: words('preço|custo|orçamento|quanto'),
    it: words('prezzo|costo|budget|quanto'),
  },
  deadline: {
    en: words('deadline|due (?:date|by|on)|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|end of \\w+)|ship date|launch date|when (?:can|will|do) we (?:ship|launch|deliver|finish)|eta'),
    es: words('fecha límite|plazo|para el (?:lunes|martes|miércoles|jueves|viernes)|cuándo (?:podemos|vamos a) (?:lanzar|entregar|terminar)'),
    fr: words("date limite|échéance|d'ici (?:lundi|mardi|mercredi|jeudi|vendredi|demain)|quand (?:pouvons|allons)-nous"),
    de: words('frist|deadline|bis (?:montag|dienstag|mittwoch|donnerstag|freitag|morgen)|wann (?:können|werden) wir'),
    hi: words('समय सीमा|डेडलाइन|कब तक'),
    pt: words('prazo|data limite|até (?:segunda|sexta|amanhã)'),
    it: words('scadenza|entro (?:lunedì|venerdì|domani)'),
  },
  status: {
    en: words("status|any updates?|progress on|where are we|how(?:'s| is) .{1,40} going|are we on track"),
    es: words('estado|novedades|avance|cómo va|en qué punto'),
    fr: words("où en est|avancement|statut|des nouvelles"),
    de: words('stand|status|fortschritt|wie läuft'),
    hi: words('स्थिति|अपडेट|प्रगति'),
    pt: words('status|andamento|como está'),
    it: words('stato|aggiornamento|come procede'),
  },
  question: {
    en: lead('what|when|how|why|who|where|which|can|could|would|will|do|does|did|is|are|should|shall|may|have|has'),
    es: lead('qué|cuándo|cómo|por qué|quién|dónde|cuál|puedes|podemos|hay|es|está'),
    fr: lead("quoi|quand|comment|pourquoi|qui|où|quel|quelle|est-ce|peux|pouvons|avez"),
    de: lead('was|wann|wie|warum|wer|wo|welche|kannst|können|ist|sind|haben'),
    hi: words('क्या|कब|कैसे|क्यों|कौन|कहाँ|कहां'),
    pt: lead('o que|quando|como|por que|quem|onde|qual|pode|podemos'),
    it: lead('cosa|quando|come|perché|chi|dove|quale|puoi|possiamo'),
  },
};

// ---------- Entities ----------
const DATE_WORDS = [
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next week|end of (?:the )?(?:day|week|month|quarter)|eod|eow',
  'lunes|martes|miércoles|jueves|viernes|sábado|domingo|hoy|mañana|la próxima semana|fin de mes',
  'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|aujourd’hui|demain|la semaine prochaine',
  'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|heute|morgen|nächste woche',
  'सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|आज|कल',
  'segunda|terça|quarta|quinta|sexta|sábado|domingo|amanhã',
  'lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|domani',
].join('|');
const DATE_RE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${DATE_WORDS}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2}|q[1-4])(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
const MONEY_RE = /[$€£₹]\s?\d[\d,.]*(?:\s?(?:k|m|bn|thousand|million|billion)(?![\p{L}]))?|\d[\d,.]*\s?(?:k|m)?\s?(?:dollars|usd|euros?|eur|pounds|gbp|rupees|inr|rupaye|रुपये)(?![\p{L}])/giu;
const PERCENT_RE = /\d+(?:[.,]\d+)?\s?(?:%|percent|por ciento|pour cent|prozent|प्रतिशत)/giu;
const uniq = (xs) => [...new Set(xs.map((x) => x.trim()))];

export function extractEntities(text) {
  const s = String(text);
  return { dates: uniq(s.match(DATE_RE) ?? []), money: uniq(s.match(MONEY_RE) ?? []), percents: uniq(s.match(PERCENT_RE) ?? []) };
}

// What kind of moment is this? null when it's just talk.
export function detectIntent(text, l = 'en') {
  const s = String(text).trim();
  if (s.length < 4) return null;
  const L = lang(l), cues = (kind) => [CUES[kind][L], ...(L === 'en' ? [] : [CUES[kind].en])];
  const e = extractEntities(s);
  const asked = /[?¿]/.test(s) || cues('question').some((re) => re.test(s));
  for (const kind of KINDS) {
    let hit = kind === 'question' ? asked : cues(kind).some((re) => re.test(s));
    if (kind === 'price') hit ||= e.money.length > 0; // an amount on the table is a pricing moment
    if (kind === 'deadline') hit ||= asked && e.dates.length > 0; // "can we ship Friday?"
    if (!hit) continue;
    if (kind === 'price' && !asked && !e.money.length) continue; // "cost" in passing isn't a pricing moment
    if (kind === 'deadline' && !asked && !e.dates.length) continue;
    return { kind, entities: e };
  }
  return null;
}

// ---------- Context retrieval ----------
const STOP = new Set(('the and for are was were with that this have has had you your our not but can could would will what when where which who why how does did about from into they them then than there their just also its it\'s let\'s lets get got any some more most very really should shall may might ' +
  'que por para con una los las del como pero más qué cuándo está este esta ' +
  'les des une est pour dans avec pas sur qui quoi quand ' +
  'der die das und ist mit für nicht wir wie was wann ' +
  'uma com não por mais como ' +
  'che per con non una come ' +
  'क्या है हैं का की के में और यह वह कब कैसे').split(/\s+/));
const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);
export const keywords = (text) => uniq((String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map(stem));

const WEIGHTS = { // which sources best answer which kind of moment
  status: { pin: 1.3, highlight: 1.2, proposal: 1, card: 0.6, caption: 0.8 },
  price: { proposal: 1.3, highlight: 1.1, pin: 1, card: 0.5, caption: 0.8 },
  deadline: { proposal: 1.4, highlight: 1.1, pin: 1, card: 0.5, caption: 0.8 },
  objection: { proposal: 1.3, highlight: 1.1, pin: 1, card: 0.5, caption: 0.9 },
  question: { proposal: 1.1, highlight: 1.1, pin: 1.1, card: 0.6, caption: 0.9 },
};
// Strip "Name: “…”" wrappers so a quoted fact reads naturally inside an answer.
export const clean = (t) => String(t).replace(/^[^:“"]{1,40}:\s*/, '').replace(/[“”"«»]/g, '').replace(/[.。।!\s]+$/u, '').trim();

// state: { highlights:[{context,auto,reason,t}], pins:[{n,note,resolved,t}], proposals:[{text,proposer,t}], cards:[{caption,t}], captions:[{name,text,t}] }
export function relevantFacts(question, kind, state = {}, limit = 3) {
  const q = new Set(keywords(question)), w = WEIGHTS[kind] ?? WEIGHTS.question;
  const items = [
    ...(state.proposals ?? []).map((p) => ({ kind: 'proposal', text: p.text, t: p.t ?? 0 })),
    ...(state.pins ?? []).filter((p) => !p.resolved && p.note).map((p) => ({ kind: 'pin', n: p.n, text: p.note, t: p.t ?? 0 })),
    ...(state.highlights ?? []).filter((h) => h.context).map((h) => ({ kind: 'highlight', text: h.context, t: h.t ?? 0 })),
    ...(state.cards ?? []).filter((c) => c.caption).map((c) => ({ kind: 'card', text: c.caption, t: c.t ?? 0 })),
    ...(state.captions ?? []).map((c) => ({ kind: 'caption', name: c.name, text: c.text, t: c.t ?? 0 })),
  ];
  const newest = Math.max(1, ...items.map((x) => x.t));
  return items
    .map((x) => {
      const overlap = keywords(x.text).filter((k) => q.has(k)).length;
      const money = kind === 'price' && extractEntities(x.text).money.length ? 1 : 0;
      return { ...x, text: clean(x.text).slice(0, 120), score: overlap ? overlap * (w[x.kind] ?? 1) + money + 0.3 * (x.t / newest) : 0 };
    })
    .filter((x) => x.score > 0 && x.text)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- Suggestions ----------
const T = {
  en: {
    intent: { question: '{name} is asking: “{gist}”', status: '{name} wants a status update: “{gist}”', price: '{name} raised pricing: “{gist}”', deadline: '{name} proposed a deadline: “{gist}”', objection: '{name} has a concern: “{gist}”' },
    answers: {
      status: ['Quick status: {fact}. Next step: {next}.', 'We’re on track — I’ll send a written update by {date}.'],
      price: ['On pricing: we discussed {amount} — {fact}.', 'Let me confirm {amount} and get back to you by {date}.'],
      deadline: ['{date} works if we lock the scope today — {fact}.', 'Let me check {next} and confirm {date} by end of day.'],
      objection: ['Fair point. {fact} — could we try that and review it together?', 'I hear you. Let’s log it as an open item and decide by {date}.'],
      question: ['Good question — {fact}.', 'Let me check and come back to you by {date}.'],
    },
    fallback: { fact: 'I’ll confirm the details', next: 'the open items', date: 'tomorrow', amount: 'the agreed budget' },
    labels: { pin: 'pin #{n}', proposal: 'proposal', highlight: 'highlight', card: 'whiteboard snip', caption: '{name} earlier' },
    basedOn: 'Based on', none: 'No matching meeting context yet',
  },
  es: {
    intent: { question: '{name} pregunta: «{gist}»', status: '{name} pide una actualización: «{gist}»', price: '{name} habla de precio: «{gist}»', deadline: '{name} propone una fecha: «{gist}»', objection: '{name} tiene una objeción: «{gist}»' },
    answers: {
      status: ['Estado rápido: {fact}. Siguiente paso: {next}.', 'Vamos según lo previsto; enviaré una actualización por escrito para {date}.'],
      price: ['Sobre el precio: hablamos de {amount}; {fact}.', 'Déjame confirmar {amount} y te respondo para {date}.'],
      deadline: ['{date} nos sirve si cerramos el alcance hoy; {fact}.', 'Déjame revisar {next} y confirmo {date} hoy mismo.'],
      objection: ['Buen punto. {fact}; ¿lo probamos y lo revisamos juntos?', 'Te entiendo. Lo dejamos como tema abierto y decidimos para {date}.'],
      question: ['Buena pregunta: {fact}.', 'Déjame comprobarlo y te respondo para {date}.'],
    },
    fallback: { fact: 'confirmaré los detalles', next: 'los temas abiertos', date: 'mañana', amount: 'el presupuesto acordado' },
    labels: { pin: 'pin n.º {n}', proposal: 'propuesta', highlight: 'momento destacado', card: 'recorte de la pizarra', caption: 'lo que dijo {name}' },
    basedOn: 'Basado en', none: 'Aún no hay contexto de la reunión relacionado',
  },
  fr: {
    intent: { question: '{name} demande : « {gist} »', status: '{name} veut un point d’avancement : « {gist} »', price: '{name} parle du prix : « {gist} »', deadline: '{name} propose une échéance : « {gist} »', objection: '{name} a une réserve : « {gist} »' },
    answers: {
      status: ['Point rapide : {fact}. Prochaine étape : {next}.', 'Nous sommes dans les temps ; j’enverrai un point écrit d’ici {date}.'],
      price: ['Sur le prix : nous avons parlé de {amount} ; {fact}.', 'Je confirme {amount} et je reviens vers vous d’ici {date}.'],
      deadline: ['{date}, c’est possible si on fige le périmètre aujourd’hui ; {fact}.', 'Je vérifie {next} et je confirme {date} avant ce soir.'],
      objection: ['Bonne remarque. {fact} ; on essaie et on fait le point ensemble ?', 'Je comprends. Notons-le comme point ouvert et décidons d’ici {date}.'],
      question: ['Bonne question : {fact}.', 'Je vérifie et je reviens vers vous d’ici {date}.'],
    },
    fallback: { fact: 'je confirmerai les détails', next: 'les points ouverts', date: 'demain', amount: 'le budget convenu' },
    labels: { pin: 'épingle n° {n}', proposal: 'proposition', highlight: 'moment clé', card: 'capture du tableau', caption: 'propos de {name}' },
    basedOn: 'Basé sur', none: 'Pas encore de contexte de réunion correspondant',
  },
  de: {
    intent: { question: '{name} fragt: „{gist}“', status: '{name} möchte einen Statusbericht: „{gist}“', price: '{name} spricht den Preis an: „{gist}“', deadline: '{name} schlägt eine Frist vor: „{gist}“', objection: '{name} hat Bedenken: „{gist}“' },
    answers: {
      status: ['Kurzer Stand: {fact}. Nächster Schritt: {next}.', 'Wir liegen im Plan – ich schicke bis {date} ein schriftliches Update.'],
      price: ['Zum Preis: Wir hatten {amount} besprochen – {fact}.', 'Ich bestätige {amount} und melde mich bis {date}.'],
      deadline: ['{date} klappt, wenn wir den Umfang heute festlegen – {fact}.', 'Ich prüfe {next} und bestätige {date} noch heute.'],
      objection: ['Guter Punkt. {fact} – sollen wir das ausprobieren und gemeinsam prüfen?', 'Verstehe. Nehmen wir es als offenen Punkt auf und entscheiden bis {date}.'],
      question: ['Gute Frage – {fact}.', 'Ich prüfe das und melde mich bis {date}.'],
    },
    fallback: { fact: 'ich bestätige die Details', next: 'die offenen Punkte', date: 'morgen', amount: 'das vereinbarte Budget' },
    labels: { pin: 'Pin Nr. {n}', proposal: 'Vorschlag', highlight: 'Highlight', card: 'Whiteboard-Ausschnitt', caption: 'Aussage von {name}' },
    basedOn: 'Basierend auf', none: 'Noch kein passender Meeting-Kontext',
  },
  hi: {
    intent: { question: '{name} पूछ रहे हैं: “{gist}”', status: '{name} स्थिति की जानकारी चाहते हैं: “{gist}”', price: '{name} ने कीमत की बात की: “{gist}”', deadline: '{name} ने समय सीमा सुझाई: “{gist}”', objection: '{name} को आपत्ति है: “{gist}”' },
    answers: {
      status: ['संक्षिप्त स्थिति: {fact}। अगला कदम: {next}।', 'हम समय पर हैं — {date} तक लिखित अपडेट भेजा जाएगा।'],
      price: ['कीमत पर: हमने {amount} की बात की थी — {fact}।', '{amount} की पुष्टि करके {date} तक जवाब दिया जाएगा।'],
      deadline: ['अगर आज दायरा तय कर लें तो {date} संभव है — {fact}।', '{next} देखकर आज ही {date} की पुष्टि की जाएगी।'],
      objection: ['सही बात है। {fact} — क्या हम इसे आज़माकर साथ में देखें?', 'बात समझ में आती है। इसे खुले मुद्दे के रूप में रखते हैं और {date} तक फ़ैसला करते हैं।'],
      question: ['अच्छा सवाल — {fact}।', 'जाँच करके {date} तक जवाब दिया जाएगा।'],
    },
    fallback: { fact: 'विवरण की पुष्टि की जाएगी', next: 'खुले मुद्दे', date: 'कल', amount: 'तय बजट' },
    labels: { pin: 'पिन #{n}', proposal: 'प्रस्ताव', highlight: 'मुख्य बिंदु', card: 'व्हाइटबोर्ड स्निप', caption: '{name} की बात' },
    basedOn: 'आधार', none: 'अभी कोई मिलता-जुलता संदर्भ नहीं',
  },
  pt: {
    intent: { question: '{name} pergunta: “{gist}”', status: '{name} quer uma atualização: “{gist}”', price: '{name} falou de preço: “{gist}”', deadline: '{name} propôs um prazo: “{gist}”', objection: '{name} tem uma objeção: “{gist}”' },
    answers: {
      status: ['Status rápido: {fact}. Próximo passo: {next}.', 'Estamos no prazo; envio uma atualização por escrito até {date}.'],
      price: ['Sobre o preço: falamos de {amount}; {fact}.', 'Vou confirmar {amount} e retorno até {date}.'],
      deadline: ['{date} funciona se fecharmos o escopo hoje; {fact}.', 'Vou verificar {next} e confirmo {date} ainda hoje.'],
      objection: ['Bom ponto. {fact}; podemos testar e revisar juntos?', 'Entendo. Vamos registrar como ponto em aberto e decidir até {date}.'],
      question: ['Boa pergunta: {fact}.', 'Vou verificar e retorno até {date}.'],
    },
    fallback: { fact: 'vou confirmar os detalhes', next: 'os pontos em aberto', date: 'amanhã', amount: 'o orçamento combinado' },
    labels: { pin: 'pin nº {n}', proposal: 'proposta', highlight: 'destaque', card: 'recorte do quadro', caption: 'fala de {name}' },
    basedOn: 'Com base em', none: 'Ainda não há contexto da reunião relacionado',
  },
  it: {
    intent: { question: '{name} chiede: «{gist}»', status: '{name} vuole un aggiornamento: «{gist}»', price: '{name} parla di prezzo: «{gist}»', deadline: '{name} propone una scadenza: «{gist}»', objection: '{name} ha un’obiezione: «{gist}»' },
    answers: {
      status: ['Stato rapido: {fact}. Prossimo passo: {next}.', 'Siamo nei tempi; invierò un aggiornamento scritto entro {date}.'],
      price: ['Sul prezzo: abbiamo parlato di {amount}; {fact}.', 'Confermo {amount} e ti rispondo entro {date}.'],
      deadline: ['{date} va bene se fissiamo il perimetro oggi; {fact}.', 'Controllo {next} e confermo {date} entro oggi.'],
      objection: ['Giusta osservazione. {fact}; proviamo e lo rivediamo insieme?', 'Capisco. Segniamolo come punto aperto e decidiamo entro {date}.'],
      question: ['Bella domanda: {fact}.', 'Controllo e ti rispondo entro {date}.'],
    },
    fallback: { fact: 'confermerò i dettagli', next: 'i punti aperti', date: 'domani', amount: 'il budget concordato' },
    labels: { pin: 'pin n. {n}', proposal: 'proposta', highlight: 'momento chiave', card: 'ritaglio della lavagna', caption: 'detto da {name}' },
    basedOn: 'In base a', none: 'Ancora nessun contesto della riunione collegato',
  },
};
const fill = (tpl, slots) => tpl.replace(/\{(\w+)\}/g, (_, k) => slots[k] ?? '');

// The full analysis of one caption: null if it isn't a moment worth answering.
export function analyze({ text, lang: l = 'en', speaker = '', state = {} }) {
  const intent = detectIntent(text, l);
  if (!intent) return null;
  const facts = relevantFacts(text, intent.kind, state);
  const factEntities = facts.map((f) => extractEntities(f.text));
  const [top, second] = facts;
  // Slots hold meeting facts verbatim; a null slot falls back to the rendering language's phrasing.
  const slots = {
    fact: top?.text ?? null,
    next: second?.text ?? null,
    date: intent.entities.dates[0] ?? factEntities.flatMap((e) => e.dates)[0] ?? null,
    amount: intent.entities.money[0] ?? factEntities.flatMap((e) => e.money)[0] ?? null,
  };
  // Grounded answer first when we found something relevant; otherwise the honest "let me check".
  const order = top ? [0, 1] : [1, 0];
  return { kind: intent.kind, gist: String(text).trim().slice(0, 160), speaker, lang: lang(l), facts, slots, answers: order.map((i) => ({ kind: intent.kind, i })) };
}

export function renderAnswer(analysis, answer, l) {
  const t = T[lang(l)], s = analysis.slots;
  return fill(t.answers[answer.kind][answer.i], { fact: s.fact ?? t.fallback.fact, next: s.next ?? t.fallback.next, date: s.date ?? t.fallback.date, amount: s.amount ?? t.fallback.amount });
}
export const renderIntent = (analysis, l, gist = analysis.gist) => fill(T[lang(l)].intent[analysis.kind], { name: analysis.speaker, gist: gist.slice(0, 140) });
export function renderBasis(analysis, l) {
  const t = T[lang(l)];
  if (!analysis.facts.length) return t.none;
  return `${t.basedOn}: ${analysis.facts.map((f) => fill(t.labels[f.kind], { n: f.n ?? '', name: f.name ?? '' })).join(' · ')}`;
}

// ---------- Saying it out loud ----------
const SPOKEN = {
  cur: { '$': { en: 'dollars', es: 'dólares', fr: 'dollars', de: 'Dollar', hi: 'डॉलर', pt: 'dólares', it: 'dollari' }, '€': { en: 'euros', es: 'euros', fr: 'euros', de: 'Euro', hi: 'यूरो', pt: 'euros', it: 'euro' }, '£': { en: 'pounds', es: 'libras', fr: 'livres', de: 'Pfund', hi: 'पाउंड', pt: 'libras', it: 'sterline' }, '₹': { en: 'rupees', es: 'rupias', fr: 'roupies', de: 'Rupien', hi: 'रुपये', pt: 'rúpias', it: 'rupie' } },
  mult: { k: { en: 'thousand', es: 'mil', fr: 'mille', de: 'tausend', hi: 'हज़ार', pt: 'mil', it: 'mila' }, m: { en: 'million', es: 'millones', fr: 'millions', de: 'Millionen', hi: 'मिलियन', pt: 'milhões', it: 'milioni' } },
  pct: { en: 'percent', es: 'por ciento', fr: 'pour cent', de: 'Prozent', hi: 'प्रतिशत', pt: 'por cento', it: 'per cento' },
  and: { en: 'and', es: 'y', fr: 'et', de: 'und', hi: 'और', pt: 'e', it: 'e' },
};
// Clear, speakable phrasing: symbols and shorthand expanded into words of that language.
export function speakable(text, l = 'en') {
  const L = lang(l);
  return String(text)
    .replace(/[“”«»„"]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/([$€£₹])\s?(\d[\d,.]*)\s?([kKmM])?(?![\p{L}])/gu, (_, c, n, m) => `${n}${m ? ` ${SPOKEN.mult[m.toLowerCase()][L]}` : ''} ${SPOKEN.cur[c][L]}`)
    .replace(/(\d+(?:[.,]\d+)?)\s?%/g, (_, n) => `${n} ${SPOKEN.pct[L]}`)
    .replace(/\s+&\s+/g, ` ${SPOKEN.and[L]} `)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Devanagari → Latin pronunciation guide (so a non-Hindi reader can say a Hindi reply aloud).
const DV = {
  vowel: { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri' },
  sign: { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ृ': 'ri', 'ॅ': 'e', 'ॉ': 'o' },
  cons: { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f' },
  other: { 'ं': 'n', 'ँ': 'n', 'ः': 'h', '।': '.', '॥': '.' },
};
export const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);
export function transliterate(text) {
  let out = '';
  for (const word of String(text).split(/(\s+)/)) {
    if (!hasDevanagari(word)) { out += word; continue; }
    const ch = [...word.normalize('NFC')];
    let w = '', inherent = false, syllables = 0;
    for (let i = 0; i < ch.length; i++) {
      let c = ch[i];
      if (ch[i + 1] === '़' && DV.cons[c + '़']) { c += '़'; i++; }
      if (DV.cons[c]) {
        w += DV.cons[c];
        syllables++;
        const next = ch[i + 1];
        if (DV.sign[next]) { w += next === 'ा' && i + 2 >= ch.length ? 'a' : DV.sign[next]; i++; inherent = false; }
        else if (next === '्') { i++; syllables--; inherent = false; }
        else { w += 'a'; inherent = true; }
      } else if (DV.vowel[c]) { w += DV.vowel[c]; syllables++; inherent = false; }
      else if (DV.other[c]) { w += DV.other[c]; }
      else if (c >= '०' && c <= '९') { w += String(c.charCodeAt(0) - 0x0966); inherent = false; }
      else { w += c; inherent = false; }
    }
    if (inherent && syllables > 1 && w.endsWith('a')) w = w.slice(0, -1); // Hindi drops the final schwa: कब → kab
    out += w;
  }
  return out;
}
