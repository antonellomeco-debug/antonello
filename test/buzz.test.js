// «Ascolta la rete» (lib/buzz.js, strumento web_buzz): Reddit, Polymarket, Hacker News, StockTwits e YouTube contro il
// finto server di test/helpers/fake-social.js.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeSocial } from "./helpers/fake-social.js";

const fake = await startFakeSocial();
after(() => fake.close());
Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "buzz-test-")),
  MARKET_MODE: "demo",
  SOCIAL_API_BASE: fake.url,
  BUZZ_API_BASE: fake.url,
});
const { buzz, _reset } = await import("../lib/buzz.js");
const social = await import("../lib/social/index.js");
const { runTool, TOOL_DEFS } = await import("../lib/tools.js");
const { ALL_TOOLS } = await import("../lib/config.js");

beforeEach(() => {
  _reset();
  fake.opts.redditDown = false;
});
const hits = (host) => fake.calls.filter((c) => c.host === host);

test("senza fonti: Reddit, Polymarket e Hacker News in parallelo, ordinati per interesse, con l'avviso sui fatti", async () => {
  const r = await buzz({ query: "bandi startup", days: 7, limit: 5 });
  assert.equal(r.giorni, 7);
  assert.deepEqual(Object.keys(r.fonti).sort(), ["hackernews", "polymarket", "reddit"]);
  assert.equal(r.errori, undefined);
  const red = r.fonti.reddit.items;
  assert.equal(red.length, 2, "il post rimosso non conta");
  assert.equal(red[0].punti, 340);
  assert.equal(red[0].link, "https://www.reddit.com/r/x/comments/r1/bandi/");
  const call = hits("arctic-shift.photon-reddit.com").at(-1);
  assert.equal(call.query.title, "bandi startup", "senza subreddit cerca nei titoli");
  assert.match(call.query.after, /^\d{4}-\d{2}-\d{2}$/);
  const pm = r.fonti.polymarket.items;
  assert.equal(pm.length, 1, "l'evento chiuso no");
  assert.equal(pm[0].mercati.length, 2);
  assert.deepEqual(pm[0].mercati[0].probabilita, [{ esito: "Yes", pct: 72 }, { esito: "No", pct: 28 }]);
  assert.equal(pm[0].mercati[0].variazione_settimana_punti, 5);
  assert.equal(pm[0].link, "https://polymarket.com/event/fed-december");
  assert.equal(r.fonti.hackernews.items[0].punti, 300);
  assert.equal(r.fonti.hackernews.items[0].link, "https://news.ycombinator.com/item?id=12");
  assert.match(hits("hn.algolia.com").at(-1).query.numericFilters, /^created_at_i>\d+$/);
  assert.match(r.attenzione, /non fatti/);
});

test("subreddit italiani, StockTwits con l'umore dei trader, cache di 30 minuti, fonte che non risponde negli errori", async () => {
  const r = await buzz({ query: "mutuo", sources: ["reddit", "stocktwits"], subreddits: "r/ItaliaPersonalFinance, italy", symbol: "$aapl" });
  assert.deepEqual(hits("arctic-shift.photon-reddit.com").slice(-2).map((c) => c.query.subreddit), ["ItaliaPersonalFinance", "italy"]);
  assert.equal(hits("arctic-shift.photon-reddit.com").at(-1).query.query, "mutuo");
  const st = r.fonti.stocktwits;
  assert.equal(st.simbolo, "AAPL");
  assert.equal(st.messaggi_letti, 3, "i messaggi vecchi non contano");
  assert.equal(st.rialzo_pct, 67);
  assert.equal(st.ribasso_pct, 33);
  assert.equal(st.items[0].mi_piace, 9);
  const before = fake.calls.length;
  await buzz({ query: "mutuo", sources: ["reddit", "stocktwits"], subreddits: "r/ItaliaPersonalFinance, italy", symbol: "$aapl" });
  assert.equal(fake.calls.length, before, "seconda richiesta uguale: dalla cache");
  fake.opts.redditDown = true;
  const r2 = await buzz({ query: "altro", sources: ["reddit", "hackernews"] });
  assert.match(r2.errori.reddit, /HTTP 429/);
  assert.ok(r2.fonti.hackernews.items.length);
  await assert.rejects(buzz({}), /query/);
});

test("YouTube con il canale collegato: video più visti, al massimo 20 ricerche al giorno; senza collegamento non si usa", async () => {
  let r = await buzz({ query: "credito d'imposta" });
  assert.equal(r.fonti.youtube, undefined, "YouTube non collegato: non è tra le fonti di partenza");
  social.setApp("youtube", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-segreto" });
  const { url } = social.startAuth("youtube");
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location"));
  await social.finishAuth(back.searchParams.get("state"), back.searchParams.get("code"));
  _reset();
  r = await buzz({ query: "credito d'imposta", limit: 5 });
  const yt = r.fonti.youtube.items;
  assert.deepEqual(yt.map((v) => v.visualizzazioni), [54000, 1200]);
  assert.equal(yt[0].link, "https://www.youtube.com/watch?v=yt-s2");
  const search = hits("www.googleapis.com").filter((c) => c.path === "/youtube/v3/search").at(-1);
  assert.equal(search.query.order, "viewCount");
  assert.ok(Date.parse(search.query.publishedAfter));
  for (let i = 0; i < 19; i++) await buzz({ query: `tema ${i}`, sources: ["youtube"] });
  const over = await buzz({ query: "uno di troppo", sources: ["youtube"] });
  assert.match(over.errori.youtube, /limite di 20 ricerche/);
});

test("strumento web_buzz per gli agenti e per Orion", async () => {
  assert.ok(ALL_TOOLS.includes("web_buzz"));
  assert.ok(TOOL_DEFS.web_buzz.description.includes("polymarket"));
  const r = await runTool({ id: "trend", name: "Trend", tools: ["web_buzz"] }, "web_buzz", { query: "AI agents", sources: ["hackernews"] });
  assert.equal(r.fonti.hackernews.items.length, 2);
  await assert.rejects(runTool({ id: "x", name: "X", tools: [] }, "web_buzz", { query: "a" }), /non abilitato/);
});
