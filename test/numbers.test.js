// Numeri in lettere per la voce dei video: le voci leggevano male le cifre italiane («314.824», «8,9%»).
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberToWords, spokenNumbers } from "../lib/social/numbers-it.js";
import { speakable, wordTimes } from "../lib/social/tts.js";

test("numeri interi in lettere, come si dicono", () => {
  const cases = {
    0: "zero", 1: "uno", 8: "otto", 17: "diciassette", 21: "ventuno", 23: "ventitré", 28: "ventotto", 70: "settanta", 100: "cento",
    108: "centootto", 180: "centottanta", 999: "novecentonovantanove", 1000: "mille", 1001: "milleuno", 2025: "duemilaventicinque",
    23000: "ventitremila", 50000: "cinquantamila", 314824: "trecentoquattordicimila ottocentoventiquattro", 1000000: "un milione",
    4600000: "quattro milioni seicentomila", 2000000000: "due miliardi",
  };
  for (const [n, w] of Object.entries(cases)) assert.equal(numberToWords(Number(n)), w, n);
});

test("le frasi del video sbagliato: cifre italiane, virgole e percentuali", () => {
  const say = (t) => spokenNumbers(speakable(t));
  assert.equal(say("314.824 imprenditori italiani hanno almeno 70 anni."), "trecentoquattordicimila ottocentoventiquattro imprenditori italiani hanno almeno settanta anni.");
  assert.equal(say("Dieci anni fa erano l'8,9%."), "Dieci anni fa erano l'otto virgola nove per cento.");
  assert.equal(say("Oggi sono il 10,7%."), "Oggi sono il dieci virgola sette per cento.");
  assert.equal(say("A giugno 2025 erano 314.824."), "A giugno duemilaventicinque erano trecentoquattordicimila ottocentoventiquattro.");
});

test("soldi, segni, abbreviazioni, date, ore, ordinali", () => {
  const say = (t) => spokenNumbers(speakable(t));
  assert.equal(say("Lo Stato regala 50.000 €"), "Lo Stato regala cinquantamila euro");
  assert.equal(say("2,5 mld €"), "due virgola cinque miliardi di euro");
  assert.equal(say("1 mln $"), "un milione di dollari");
  assert.equal(say("+15% e -3,2%"), "più quindici per cento e meno tre virgola due per cento");
  assert.equal(say("Il 18/10/2026 alle 18:30"), "Il diciotto ottobre duemilaventisei alle diciotto e trenta");
  assert.equal(say("Il 1/11/2026 alle 9:00"), "Il primo novembre duemilaventisei alle nove");
  assert.equal(say("1° posto, 3ª edizione, 21° secolo"), "primo posto, terza edizione, ventunesimo secolo");
  assert.equal(say("dal 2015-2025"), "dal duemilaquindici, duemilaventicinque");
  assert.equal(say("0,05 e 1.250.000,50"), "zero virgola zero cinque e un milione duecentocinquantamila virgola cinquanta");
  assert.equal(say("Senza numeri resta uguale."), "Senza numeri resta uguale.");
});

test("sottotitoli: le cifre restano, ma un numero lungo dura di più", () => {
  const w = wordTimes("Erano 314.824 titolari.", 0, 4);
  assert.deepEqual(w.map((x) => x.word), ["Erano", "314.824", "titolari."]);
  const len = (x) => x.end - x.start;
  assert.ok(len(w[1]) > len(w[0]) * 3, "il numero si dice con tante parole");
});
