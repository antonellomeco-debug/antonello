import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { cleanKey, friendlyError } from "../lib/claude.js";
import fs from "node:fs";
import path from "node:path";
import { normalize, validate } from "../lib/config.js";
import { DEFAULTS_DIR } from "../lib/paths.js";

const loadRooms = () => JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, "building.json"), "utf8")).rooms;

const apiError = (status, message) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("cleanKey toglie virgolette, spazi e caratteri invisibili", () => {
  assert.equal(cleanKey(' "sk-ant-abc​def" '), "sk-ant-abcdef");
  assert.equal(cleanKey("﻿sk-ant-xyz\n"), "sk-ant-xyz");
});

test("friendlyError traduce gli errori più comuni", () => {
  assert.match(friendlyError(apiError(401, "invalid x-api-key")), /scaduta o disattivata/);
  assert.match(friendlyError(apiError(400, "Your credit balance is too low to access the API")), /Credito di Claude esaurito/);
  assert.match(friendlyError(apiError(429, "rate limited")), /riprova tra un minuto/);
  assert.match(friendlyError(apiError(529, "Overloaded")), /sovraccarico/);
  assert.match(
    friendlyError(apiError(400, 'This organization has been disabled. An organization admin can appeal at https://console.anthropic.com/appeal')),
    /account Anthropic è sospeso/,
  );
  assert.equal(friendlyError(new Error("altro")), "altro");
});

test("la strategia non può puntare fuori da strategies/", () => {
  const errs = validate(normalize({ id: "x", room: "analisi", mode: "rule", strategy: "../../evil" }), loadRooms());
  assert.ok(errs.some((e) => e.startsWith("strategy")));
  assert.deepEqual(validate(normalize({ id: "x", room: "analisi", mode: "rule", strategy: "sma_cross" }), loadRooms()), []);
});
