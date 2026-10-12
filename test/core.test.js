import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sma, rsi, summary } from "../lib/indicators.js";
import { normalize, validate } from "../lib/config.js";
import { DEFAULTS_DIR } from "../lib/paths.js";

const defaultRooms = JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, "building.json"), "utf8")).rooms;

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

test("tutti gli agenti di esempio sono validi nel palazzo di partenza", () => {
  const dir = path.join(DEFAULTS_DIR, "agents");
  for (const f of fs.readdirSync(dir)) {
    const a = normalize(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), f);
    assert.deepEqual(validate(a, defaultRooms), [], a.id);
  }
});

test("validazione rifiuta config errate", () => {
  const errs = validate(normalize({ id: "X Y", room: "nope", mode: "llm" }), defaultRooms);
  assert.equal(errs.length, 3);
});
