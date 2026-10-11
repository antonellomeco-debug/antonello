import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, rsi, summary } from "../lib/indicators.js";
import { normalize, validate, loadRooms, loadAgents } from "../lib/config.js";

test("sma e rsi", () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 5), 100);
});

test("summary su serie crescente", () => {
  const candles = Array.from({ length: 70 }, (_, i) => ({ close: 100 + i }));
  const s = summary(candles);
  assert.ok(s.sma20 > s.sma50);
  assert.ok(s.return20d > 0);
});

test("tutti gli agenti di esempio sono validi", () => {
  const rooms = loadRooms();
  for (const a of loadAgents()) assert.deepEqual(validate(a, rooms), [], a.id);
});

test("validazione rifiuta config errate", () => {
  const errs = validate(normalize({ id: "X Y", room: "nope", mode: "llm" }), loadRooms());
  assert.equal(errs.length, 3);
});
