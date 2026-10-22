// Scrivere come una persona: regole e controllo dei «segni da IA» nei testi che escono a nome dell'utente
// (post, didascalie, risposte ai commenti, voce dei video). Adattato all'italiano da Humanizer
// (github.com/blader/humanizer, licenza MIT, © 2025 Siqi Chen), che a sua volta si basa sulla guida di Wikipedia
// «Signs of AI writing».

/** Regole per il prompt di chi scrive testi pubblici (agenti dei contenuti e Orion). */
export const WRITING_RULES = `SCRIVERE COME UNA PERSONA (post, didascalie, risposte, testi dei video e dei report)
I testi escono a nome dell'utente: devono sembrare scritti da una persona competente, non da un'IA. Ogni frase deve dare
un'informazione nuova. Niente di inventato: nomi, numeri, date e citazioni solo dalle fonti.
Da evitare (il programma blocca il post la prima volta e te lo fa riscrivere):
- il contrasto finto: «non è solo X, è Y», «non si tratta di X ma di Y», «Non è X. È Y.» → di' direttamente la cosa;
- la frase a effetto in chiusura o da sola: «E questo cambia tutto.», «Pensaci.», «Il messaggio è chiaro.», righe di
  frammenti («Niente scuse. Niente attese.») → togli, o metti un fatto concreto;
- le massime: «la vera domanda è», «ciò che conta davvero», «il cuore della questione», «in un mondo in cui», «nell'era di»;
- gli annunci prima del punto: «Facciamo chiarezza», «Ecco cosa devi sapere», «Scopriamolo insieme», «Parliamoci chiaro»,
  «La verità?», «Spoiler:» → parti dal fatto;
- rispondere a obiezioni che nessuno ha fatto: «Non fraintendermi», «Sia chiaro», «Non sto dicendo che…»;
- i trattini lunghi (— e –) come collante: usa punto, virgola, due punti o parentesi;
- le parole gonfiate: cruciale, fondamentale, rivoluzionario, svolta epocale, pietra miliare, panorama, ecosistema,
  sinergia, a 360 gradi, potenziare, mettere in luce, sottolineare, testimonianza, imperdibile, incredibile, «gioca un ruolo
  chiave», «il futuro è luminoso» → il fatto con parole semplici;
- elenchi sempre da tre per suonare completi, grassetti ed emoji su ogni riga, frasi che iniziano tutte allo stesso modo;
- i resti da chat: «Certo!», «Ottima domanda», «Spero ti sia utile», «Fammi sapere se…», «Ecco il post:».
Scrivi frasi di lunghezza diversa (corte e lunghe alternate), verbi semplici («è», «ha» invece di «rappresenta»,
«vanta»), soggetto chiaro, il dettaglio specifico (la cifra, il luogo, il nome) al posto dell'aggettivo.`;

// \b di JavaScript conosce solo le lettere inglesi (sbaglia con «è», «più»…): confine di parola per l'italiano.
const B = String.raw`(?:(?<![\p{L}\p{N}])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?![\p{L}\p{N}]))`;
const it = (re) => new RegExp(re.source.replaceAll("\\b", B), re.flags.includes("u") ? re.flags : `${re.flags}u`);

// Segni FORTI: ne basta uno. Segni DEBOLI: contano solo se sono almeno 3 diversi nello stesso testo.
const STRONG = [
  ["contrasto finto («non è solo X, è Y»)", /\bnon (?:è|sono|era) (?:solo|soltanto|semplicemente|solamente|più) [^.!?\n]{1,70}?[,;:—–]\s*(?:è|sono|ma|bensì)\b/iu],
  ["contrasto finto («non si tratta di X ma di Y»)", /\bnon si tratta (?:solo |soltanto |semplicemente )?di [^!?\n]{1,90}?(?:[,;:—–.]\s*|\s)(?:ma|bensì|si tratta)\b/iu],
  ["contrasto finto («Non è X. È Y.»)", /\bnon è [^.!?\n]{1,60}\.\s+è\b/iu],
  ["frase a effetto in chiusura", /(?:^|[.!?\n]\s*)(?:pensaci(?: bene)?|rileggilo|rileggi bene|fermati un attimo|e questo cambia tutto|questo cambia tutto|cambia tutto|il messaggio è chiaro|la lezione è chiara|fine della storia|lascia che (?:questo )?ti entri in testa)\s*[.!]/iu],
  ["massima che suona profonda", /\b(?:la vera domanda è|ciò che conta davvero|quello che conta davvero|il cuore della questione|al centro di tutto c'è|in un mondo in cui|nell'era (?:di|del|della|dell'|degli|delle))/iu],
  ["annuncio prima del punto", /(?:^|[.!?\n]\s*)(?:facciamo chiarezza|ecco (?:tutto )?(?:quello |ciò )?(?:che|cosa) devi sapere|scopriamolo insieme|scopriamo insieme|vediamo insieme|andiamo a vedere|senza (?:troppi )?giri di parole|parliamoci chiaro|diciamocelo|siamo onesti|sinceramente\?|la verità\?|spoiler:)/iu],
  ["risposta a un'obiezione che nessuno ha fatto", /\b(?:non fraintendermi|non fraintendetemi|non sto dicendo che|sia chiaro[,:]|qualcuno (?:potrebbe|potrà) pensare|potresti pensare che)/iu],
  ["resto da chat", /(?:^|[.!?\n]\s*)(?:certo!|certamente!|ottima domanda|spero (?:ti|vi) sia (?:stato )?utile|fammi sapere se|ecco (?:a te|il (?:post|testo|thread)|la (?:didascalia|risposta))\b|ecco una (?:versione|proposta)\b)/iu],
];

const WEAK = [
  ["parola gonfiata", /\b(?:cruciale|cruciali|fondamentale|fondamentali|rivoluzionari[oaie]|svolta epocale|pietra miliare|panorama|ecosistema|sinergi[ae]|a 360 gradi|potenziare|mette(?:re)? in luce|sottolinea(?:re|no)?|testimonianza|imperdibile|incredibil[ei]|straordinari[oaie]|all'avanguardia|cambio di paradigma|game ?changer|valore aggiunto|meticolos[oaie]|vibrant[ei]|a tutto tondo)\b/giu],
  ["importanza gonfiata", /\b(?:segna una svolta|momento cruciale|gioca(?:no)? un ruolo (?:chiave|fondamentale|cruciale|centrale)|il futuro è (?:luminoso|roseo)|tempi entusiasmanti|un passo nella giusta direzione|lascia(?:re)? il segno|nonostante le sfide)\b/giu],
  ["«non solo… ma anche»", /\bnon (?:solo|soltanto) [^.!?\n]{1,70}?,? ma anche\b/giu],
  ["verbo gonfiato al posto di «è» o «ha»", /\b(?:rappresenta un[ao']?|si configura come|funge da|vanta)\b/giu],
];
for (const list of [STRONG, WEAK]) for (const row of list) row[1] = it(row[1]);

/** Problemi di stile del testo: [] se va bene. Ogni voce: { tipo, frase }. */
export function styleProblems(text) {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const out = [];
  for (const [tipo, re] of STRONG) {
    const m = t.match(re);
    if (m) out.push({ tipo, frase: m[0].trim().slice(0, 90) });
  }
  const dashes = (t.match(/[—–]/g) ?? []).length;
  if (dashes >= 2) out.push({ tipo: "trattini lunghi (— –) come collante", frase: `${dashes} trattini` });
  const weak = [];
  for (const [tipo, re] of WEAK) {
    for (const m of t.matchAll(re)) weak.push({ tipo, frase: m[0].trim().slice(0, 90) });
  }
  if (dashes === 1) weak.push({ tipo: "trattino lungo", frase: "—" });
  const distinct = new Set(weak.map((w) => w.frase.toLowerCase()));
  if (distinct.size >= 3) out.push(...weak.filter((w, i) => weak.findIndex((x) => x.frase.toLowerCase() === w.frase.toLowerCase()) === i));
  return out;
}


// Testi già respinti una volta: se l'agente li rimanda uguali (una citazione, una scelta voluta) passano.
const rejected = new Map(); // chiave → scadenza
const REJECT_TTL = 3 * 3600_000;
const keyOf = (who, text) => {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) | 0;
  return `${who}:${h}:${String(text).length}`;
};

/**
 * Controllo prima di pubblicare: la prima volta che un testo ha segni da IA lancia un errore con le frasi da riscrivere;
 * se lo stesso testo torna identico entro 3 ore passa (l'agente ha deciso di tenerlo così).
 */
export function assertHumanText(who, text, what = "Il testo") {
  const problems = styleProblems(text);
  if (!problems.length) return;
  const now = Date.now();
  for (const [k, exp] of rejected) if (exp < now) rejected.delete(k);
  const key = keyOf(who, text);
  if (rejected.has(key)) {
    rejected.delete(key);
    return;
  }
  rejected.set(key, now + REJECT_TTL);
  const list = problems.map((p) => `${p.tipo}: «${p.frase}»`).join("; ");
  throw new Error(
    `${what} NON è stato inviato: sembra scritto da un'IA (${list}). Riscrivilo come lo scriverebbe una persona: di' il fatto ` +
      "direttamente, con parole semplici, senza queste frasi, e richiama lo strumento. Se una di queste frasi è voluta (per esempio " +
      "una citazione), rimanda lo stesso testo identico e passerà.",
  );
}

/** Tutti i testi scritti dentro un input (scene di un video, titoli, voce), per controllarli insieme. */
export function textsOf(input, skip = new Set(["media", "music", "theme", "format", "type", "id", "voice_id", "color", "src", "svg"])) {
  const out = [];
  const walk = (v, key) => {
    if (skip.has(key)) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input, "");
  return out.join("\n");
}
