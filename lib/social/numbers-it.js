// Numeri, percentuali, date e ore scritti in lettere, come si dicono in italiano, prima di darli alla voce.
// Le voci (ElevenLabs, Google, quella del server) leggono male le cifre italiane: «314.824» diventa «314 punto 824»,
// «8,9%» «otto nove» o in inglese. Qui il testo da leggere è già in parole; i sottotitoli restano con le cifre.

const U = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici",
  "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
const T = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const ORDINALS = ["", "primo", "secondo", "terzo", "quarto", "quinto", "sesto", "settimo", "ottavo", "nono", "decimo"];

function under100(n) {
  if (n < 20) return U[n];
  const t = T[Math.floor(n / 10)];
  const u = n % 10;
  if (!u) return t;
  return (u === 1 || u === 8 ? t.slice(0, -1) : t) + (u === 3 ? "tré" : U[u]); // ventuno, ventotto, ventitré
}

function under1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let head = h === 0 ? "" : h === 1 ? "cento" : `${U[h]}cento`;
  if (!r) return head || "zero";
  if (head && Math.floor(r / 10) === 8) head = head.slice(0, -1); // centottanta
  return head + under100(r);
}

const plain = (s) => s.replace(/tré$/, "tre"); // ventitremila, ventitré milioni → senza accento davanti a «mila»

/** Numero intero (fino a 999 miliardi) in lettere: 314824 → «trecentoquattordicimila ottocentoventiquattro». */
export function numberToWords(n) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n) || n >= 1e12) return String(n);
  if (n === 0) return "zero";
  const parts = [];
  const b = Math.floor(n / 1e9);
  const m = Math.floor((n % 1e9) / 1e6);
  const k = Math.floor((n % 1e6) / 1e3);
  const r = n % 1e3;
  if (b) parts.push(b === 1 ? "un miliardo" : `${plain(under1000(b))} miliardi`);
  if (m) parts.push(m === 1 ? "un milione" : `${plain(under1000(m))} milioni`);
  let tail = "";
  if (k) tail = k === 1 ? "mille" : `${plain(under1000(k))}mila`;
  if (r) tail = tail ? `${tail}${r < 100 ? "" : " "}${under1000(r)}` : under1000(r); // duemilaventicinque, ma «…mila ottocento…»
  if (tail) parts.push(tail);
  return parts.join(" ");
}

/** Cifre dopo la virgola: «9» → «nove», «75» → «settantacinque», «05» o «125» → una cifra per volta. */
function decimals(d) {
  if (d.length <= 2 && d[0] !== "0") return numberToWords(Number(d));
  return [...d].map((c) => U[Number(c)]).join(" ");
}

/** «314.824», «8,9», «1.250.000,50», «2.5» (punto decimale all'inglese) → parole. */
function numeral(raw) {
  let int = raw;
  let dec = null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) [int, dec = null] = raw.replace(/\./g, "").split(",");
  else if (/^\d+,\d+$/.test(raw)) [int, dec] = raw.split(",");
  else if (/^\d+\.\d+$/.test(raw)) [int, dec] = raw.split(".");
  if (int.length > 12 || (int.length > 1 && int[0] === "0")) return [...int].map((c) => U[Number(c)]).join(" "); // codici, telefoni
  const words = numberToWords(Number(int));
  return dec ? `${words} virgola ${decimals(dec)}` : words;
}

function ordinal(n) {
  if (n <= 10) return ORDINALS[n];
  const w = plain(numberToWords(n));
  if (/tre$/.test(w)) return `${w}esimo`; // ventitreesimo
  if (/sei$/.test(w)) return `${w}esimo`; // ventiseiesimo
  return `${w.slice(0, -1)}esimo`; // undicesimo, trentesimo
}

/**
 * Testo da dare alla voce: numeri, percentuali, date, ore, ordinali e «mld/mln» in lettere.
 * Il testo dei sottotitoli resta quello originale.
 */
export function spokenNumbers(text) {
  return String(text ?? "")
    // Date: 18/10/2026 → diciotto ottobre duemilaventisei (1/10 → primo ottobre)
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (all, d, m, y) => {
      const mi = Number(m) - 1;
      if (!MONTHS[mi] || Number(d) < 1 || Number(d) > 31) return all;
      return `${Number(d) === 1 ? "primo" : numberToWords(Number(d))} ${MONTHS[mi]} ${numberToWords(Number(y))}`;
    })
    // Ore: 18:30 → diciotto e trenta; 9:00 → nove
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (all, h, m) => `${numberToWords(Number(h))}${Number(m) ? ` e ${numberToWords(Number(m))}` : ""}`)
    // Ordinali: 1° → primo, 3ª → terza
    .replace(/\b(\d{1,3})\s?([°ºª])/g, (all, n, s) => {
      const w = ordinal(Number(n));
      return s === "ª" ? w.replace(/o$/, "a") : w;
    })
    // Segni davanti ai numeri: +15% → più quindici per cento; -3,2% → meno tre virgola due per cento
    .replace(/(^|[\s(])[+](?=\d)/g, "$1più ")
    .replace(/(^|[\s(])[-−–](?=\d)/g, "$1meno ")
    // Intervalli: 2015-2025 → 2015 2025 con una pausa
    .replace(/(\d)[-–](\d)/g, "$1, $2")
    // Numeri
    .replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g, (raw) => numeral(raw))
    // Abbreviazioni dopo i numeri; «un milione di euro», non «un milione euro»
    .replace(/\b(\p{L}+)\s+(mld|mrd)\b\.?/giu, (all, w) => (/^uno?$/i.test(w) ? "un miliardo" : `${w} miliardi`))
    .replace(/\b(\p{L}+)\s+(mln|mio)\b\.?/giu, (all, w) => (/^uno?$/i.test(w) ? "un milione" : `${w} milioni`))
    .replace(/\b(\p{L}+)\s+k\b/giu, "$1mila")
    .replace(/\b(miliard[oi]|milion[ei])\s+(euro|dollari)\b/giu, "$1 di $2")
    .replace(/\buno (milion[ei]|miliard[oi])\b/giu, "un $1")
    .replace(/\s+/g, " ")
    .trim();
}
