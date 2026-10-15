// Messaggi vocali: lettura del WAV, divisione dei messaggi lunghi, filtro delle frasi inventate, preparazione del
// modello (scarico ed estrazione) e il percorso completo nel vero server fino a Orion. Il riconoscimento vero
// (564 MB) non serve: un finto motore (helpers/fake-sherpa.cjs) prende il posto di sherpa-onnx-node.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { sendClaudeMessage } from "./helpers/claude-reply.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, tempDir } from "./helpers/server.js";

const FAKE_ENGINE = fileURLToPath(new URL("./helpers/fake-sherpa.cjs", import.meta.url));
const FILES = ["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt"];

// ---------- audio di prova ----------
function wav16(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return b;
}
const tone = (sec, rate = 16000, amp = 0.3) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));
const silence = (sec, rate = 16000) => new Float32Array(Math.round(sec * rate));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
function fakeModel(dir) {
  const m = path.join(dir, "models", "whisper-turbo");
  fs.mkdirSync(m, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(m, f), `finto ${f}`);
  fs.writeFileSync(path.join(m, "pronto.json"), "{}");
  return m;
}

// ---------- finto archivio del modello, servito da un finto GitHub ----------
const work = tempDir("voice-model-");
fs.mkdirSync(path.join(work, "sherpa-onnx-whisper-turbo", "test_wavs"), { recursive: true });
for (const f of FILES) fs.writeFileSync(path.join(work, "sherpa-onnx-whisper-turbo", f), `contenuto di ${f}`);
fs.writeFileSync(path.join(work, "sherpa-onnx-whisper-turbo", "test_wavs", "0.wav"), "non serve");
execFileSync("tar", ["-cjf", path.join(work, "model.tar.bz2"), "-C", work, "sherpa-onnx-whisper-turbo"]);
const archive = fs.readFileSync(path.join(work, "model.tar.bz2"));
const archiveSha = crypto.createHash("sha256").update(archive).digest("hex");
const github = http.createServer((req, res) => {
  if (req.url === "/release/model.tar.bz2") {
    res.writeHead(302, { location: "/objects/model.tar.bz2" }); // GitHub rimanda a un altro indirizzo
    return res.end();
  }
  if (req.url === "/objects/model.tar.bz2") {
    res.writeHead(200, { "content-length": archive.length });
    return res.end(archive);
  }
  res.writeHead(404).end();
});
await new Promise((r) => github.listen(0, "127.0.0.1", r));
const MODEL_URL = `http://127.0.0.1:${github.address().port}/release/model.tar.bz2`;

// ---------- finta API di Claude per Orion ----------
const claudeRequests = [];
const claude = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    claudeRequests.push(JSON.parse(body || "{}"));
    setTimeout(() => {
      sendClaudeMessage(res, {
        id: `msg_${claudeRequests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: "Ricevuto il tuo vocale." }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 10 },
      }, claudeRequests.at(-1));
    }, Number(process.env.FAKE_CLAUDE_DELAY_MS) || 0);
  });
});
await new Promise((r) => claude.listen(0, "127.0.0.1", r));

const running = [];
after(async () => {
  await Promise.all(running.map((s) => s.stop()));
  github.close();
  claude.close();
});

// Il modulo si importa con un modello "pronto" e il finto motore.
const DATA = tempDir("voice-unit-");
// VOICE_MODEL_URL: le prove non scaricano mai il modello vero.
Object.assign(process.env, { AGENTI_DATA_DIR: DATA, MARKET_MODE: "demo", VOICE_ENGINE: FAKE_ENGINE, VOICE_IDLE_MS: "300", VOICE_MODEL_URL: MODEL_URL });
const voice = await import("../lib/voice.js");
after(() => voice.shutdownVoice());

test("WAV: 16 bit mono, float stereo (media dei canali), file non validi rifiutati", () => {
  const a = voice.parseWav(wav16(Float32Array.of(0, 0.5, -0.5, 1)));
  assert.equal(a.rate, 16000);
  assert.deepEqual([...a.samples].map((x) => Math.round(x * 100) / 100), [0, 0.5, -0.5, 1]);

  const st = Buffer.alloc(44 + 2 * 2 * 4);
  st.write("RIFF", 0);
  st.writeUInt32LE(36 + 16, 4);
  st.write("WAVE", 8);
  st.write("fmt ", 12);
  st.writeUInt32LE(16, 16);
  st.writeUInt16LE(3, 20); // float
  st.writeUInt16LE(2, 22);
  st.writeUInt32LE(44100, 24);
  st.writeUInt32LE(44100 * 8, 28);
  st.writeUInt16LE(8, 32);
  st.writeUInt16LE(32, 34);
  st.write("data", 36);
  st.writeUInt32LE(16, 40);
  st.writeFloatLE(0.2, 44);
  st.writeFloatLE(0.4, 48);
  st.writeFloatLE(-1, 52);
  st.writeFloatLE(1, 56);
  const b = voice.parseWav(st);
  assert.equal(b.rate, 44100);
  assert.deepEqual([...b.samples].map((x) => Math.round(x * 100) / 100), [0.3, 0]);

  for (const bad of [Buffer.from("niente"), Buffer.alloc(100), wav16(Float32Array.of(0)).fill(0, 20, 22)]) {
    assert.throws(() => voice.parseWav(bad), (e) => e.status === 400);
  }
});

test("ricampionamento a 16 kHz e misura della voce", () => {
  const r = voice.resample(tone(1, 48000), 48000);
  assert.equal(r.length, 16000);
  assert.ok(voice.voicedSeconds(r) > 0.9);
  assert.equal(voice.voicedSeconds(silence(2)), 0);
});

test("messaggi lunghi divisi in pezzi da al massimo 28 s, nelle pause", () => {
  const audio = join(tone(25), silence(0.5), tone(24.5), silence(0.6), tone(10));
  const parts = voice.splitForWhisper(audio);
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length <= 28 * 16000, `pezzo da ${p.length / 16000} s`);
  assert.equal(parts.reduce((n, p) => n + p.length, 0), audio.length, "non si perde niente");
  const firstCut = parts[0].length / 16000;
  assert.ok(firstCut > 24.9 && firstCut < 25.6, `primo taglio nella pausa (${firstCut} s)`);
  assert.equal(voice.splitForWhisper(tone(10)).length, 1);
});

test("frasi inventate da Whisper tolte dal testo", () => {
  assert.equal(voice.cleanTranscript(" Sottotitoli creati dalla comunità Amara.org "), "");
  assert.equal(voice.cleanTranscript("Compra oro. Sottotitoli e revisione a cura di QTSS"), "Compra oro.");
  assert.equal(voice.cleanTranscript("[Musica] Ciao   Orion (musica)"), "Ciao Orion");
  assert.equal(voice.cleanTranscript("Vendi metà posizione a 2.350"), "Vendi metà posizione a 2.350");
});

test("trascrizione: testo, pezzi uniti, audio corto, muto o con frasi inventate", async () => {
  fakeModel(DATA);
  assert.equal(voice.publicStatus().state, "ready");
  assert.equal(await voice.transcribe(wav16(tone(2))), "pezzo di 2.0 secondi");
  // 60 s: tre pezzi trascritti dal processo a parte e uniti
  const long = await voice.transcribe(wav16(join(tone(25), silence(0.5), tone(24.5), silence(0.6), tone(10))));
  assert.match(long, /^pezzo di 25\.\d secondi pezzo di 2\d\.\d secondi pezzo di 1\d\.\d secondi$/);
  await assert.rejects(voice.transcribe(wav16(tone(0.3))), (e) => e.status === 422 && /troppo corto/.test(e.message));
  await assert.rejects(voice.transcribe(wav16(silence(3))), (e) => e.status === 422 && /Non ho sentito/.test(e.message));
  await assert.rejects(voice.transcribe(wav16(tone(3))), (e) => e.status === 422 && /Non ho capito/.test(e.message));
  await assert.rejects(voice.transcribe(wav16(tone(126))), (e) => e.status === 400 && /2 minuti/.test(e.message));
  // Due messaggi insieme: uno per volta, entrambi trascritti.
  const both = await Promise.all([voice.transcribe(wav16(tone(4))), voice.transcribe(wav16(tone(5)))]);
  assert.deepEqual(both, ["pezzo di 4.0 secondi", "pezzo di 5.0 secondi"]);
  // Dopo un po' senza messaggi il processo si chiude; il messaggio dopo lo riavvia.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(await voice.transcribe(wav16(tone(2))), "pezzo di 2.0 secondi");
});

test("modello rovinato: errore chiaro, e il messaggio dopo riprova", async () => {
  voice.shutdownVoice();
  process.env.FAKE_SHERPA_FAIL = "load";
  await assert.rejects(voice.transcribe(wav16(tone(2))), /non è partito/);
  delete process.env.FAKE_SHERPA_FAIL;
  assert.equal(await voice.transcribe(wav16(tone(2))), "pezzo di 2.0 secondi");
});

test("modello mancante: 409 e preparazione (scarico con rimando, controllo, estrazione)", async () => {
  // Altre copie del modulo con un altro indirizzo del modello (la cartella dati resta la stessa: paths.js è già
  // caricato), una con l'impronta sbagliata e una con quella giusta.
  process.env.VOICE_MODEL_SHA256 = "0".repeat(64);
  const wrong = await import(`../lib/voice.js?sha=sbagliato`);
  process.env.VOICE_MODEL_SHA256 = archiveSha;
  const v = await import(`../lib/voice.js?sha=giusto`);
  delete process.env.VOICE_MODEL_SHA256;
  const waitFor = async (mod, states) => {
    for (let i = 0; i < 200; i++) {
      const st = mod.publicStatus();
      if (states.includes(st.state)) return st;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`stato rimasto ${mod.publicStatus().state}`);
  };
  const ready = path.join(DATA, "models", "whisper-turbo");
  fs.rmSync(ready, { recursive: true, force: true });
  assert.equal(v.publicStatus().state, "missing");
  await assert.rejects(v.transcribe(wav16(tone(2))), (e) => e.status === 409);

  wrong.prepare();
  const bad = await waitFor(wrong, ["error"]);
  assert.match(bad.error, /integrità/);
  assert.equal(fs.existsSync(ready), false);

  // Avanzi di un tentativo interrotto: si tolgono prima di controllare lo spazio.
  fs.mkdirSync(path.join(DATA, "models", ".whisper-turbo-tmp"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "models", ".whisper-turbo-tmp", "pezzo"), "x");
  fs.writeFileSync(path.join(DATA, "models", "whisper-turbo.tar.bz2.part"), "mezzo archivio");
  const started = v.prepare();
  assert.equal(started.state, "downloading");
  assert.equal(v.prepare().state, "downloading", "una sola preparazione alla volta");
  const st = await waitFor(v, ["ready", "error"]);
  assert.equal(st.state, "ready", st.error ?? "");
  for (const f of FILES) assert.equal(fs.readFileSync(path.join(ready, f), "utf8"), `contenuto di ${f}`);
  assert.equal(fs.existsSync(path.join(ready, "test_wavs")), false, "solo i file che servono");
  assert.deepEqual(fs.readdirSync(path.join(DATA, "models")), ["whisper-turbo"], "archivio e cartella temporanea tolti");
  assert.equal(await v.transcribe(wav16(tone(2))), "pezzo di 2.0 secondi");
  v.shutdownVoice();
  wrong.shutdownVoice();
});

test("motore che non funziona su questo computer: niente download, stato «unsupported»", async () => {
  process.env.VOICE_ENGINE = path.join(os.tmpdir(), "non-esiste-sherpa.cjs"); // letto dal processo di prova
  const v = await import(`../lib/voice.js?motore=assente`);
  fs.rmSync(path.join(DATA, "models"), { recursive: true, force: true });
  v.prepare();
  for (let i = 0; i < 100 && v.publicStatus().state === "downloading"; i++) await new Promise((r) => setTimeout(r, 50));
  process.env.VOICE_ENGINE = FAKE_ENGINE;
  const st = v.publicStatus();
  assert.equal(st.state, "unsupported");
  assert.match(st.error, /^Su questo computer il riconoscimento della voce non funziona: /);
  assert.doesNotMatch(st.error, /tastiera/, "il consiglio lo aggiunge l'app, una volta sola");
  assert.equal(fs.existsSync(path.join(DATA, "models", "whisper-turbo")), false);
  fakeModel(DATA);
});

// ---------- nel vero server ----------
const PASSWORD = "cavallo-batteria-graffetta";

async function startVoiceServer(env = {}) {
  const dataDir = tempDir("voice-server-");
  fakeModel(dataDir);
  const s = await startServer(
    {
      VOICE_ENGINE: FAKE_ENGINE,
      ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}`,
      ...env,
    },
    { dataDir },
  );
  running.push(s);
  return s;
}
const wavReq = (buf, headers = {}) => ({ body: buf, headers: { "content-type": "audio/wav", ...headers } });

test("server: vocale → trascrizione → Orion (con l'avviso di trascrizione) → risposta", async () => {
  const s = await startVoiceServer();
  const st = await s.req("GET", "/api/voice");
  assert.equal(st.json.state, "ready");

  const before = claudeRequests.length;
  const r = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.text, "pezzo di 2.0 secondi");
  assert.equal(r.json.reply, "Ricevuto il tuo vocale.");

  const sent = claudeRequests[before].messages.find((m) => m.role === "user");
  assert.match(sent.content, /Messaggio vocale trascritto in automatico/);
  assert.match(sent.content, /pezzo di 2\.0 secondi$/);

  const chat = await s.req("GET", "/api/chat");
  const mine = chat.json.transcript.filter((m) => m.role === "user");
  assert.equal(mine.at(-1).text, "pezzo di 2.0 secondi");
  assert.equal(mine.at(-1).voice, true);
  // Un messaggio scritto resta un messaggio normale.
  await s.req("POST", "/api/chat", { body: { message: "scritto" } });
  const after2 = await s.req("GET", "/api/chat");
  assert.equal(after2.json.transcript.filter((m) => m.role === "user").at(-1).voice, undefined);
});

test("server: errori chiari (formato, audio muto, troppo grande, Orion occupato)", async () => {
  const s = await startVoiceServer();
  const json = await s.req("POST", "/api/chat/voice", { body: { audio: "no" } });
  assert.equal(json.status, 400);
  assert.match(json.json.error, /formato/);

  const notWav = await s.req("POST", "/api/chat/voice", wavReq(Buffer.from("ciao")));
  assert.equal(notWav.status, 400);
  assert.match(notWav.json.error, /WAV/);

  const mute = await s.req("POST", "/api/chat/voice", wavReq(wav16(silence(3))));
  assert.equal(mute.status, 422);
  assert.match(mute.json.error, /Non ho sentito/);

  const huge = await s.req("POST", "/api/chat/voice", wavReq(Buffer.alloc(7 * 1024 * 1024)));
  assert.equal(huge.status, 413);

  // Orion occupato con un altro messaggio: risposta subito, senza trascrivere.
  process.env.FAKE_CLAUDE_DELAY_MS = "1500";
  const first = s.req("POST", "/api/chat", { body: { message: "lavoro lungo" } });
  await new Promise((r) => setTimeout(r, 300));
  const busy = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /sta ancora rispondendo/);
  await first;
  delete process.env.FAKE_CLAUDE_DELAY_MS;
});

test("server: un vocale rimandato mentre il primo è in trascrizione non arriva due volte", async () => {
  const s = await startVoiceServer({ FAKE_SHERPA_DELAY_MS: "1500" });
  const before = claudeRequests.length;
  const first = s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  await new Promise((r) => setTimeout(r, 400));
  const again = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  assert.equal(again.status, 409);
  assert.match(again.json.error, /Sto ancora trascrivendo/);
  assert.equal((await first).status, 200);
  assert.equal(claudeRequests.length - before, 1, "Orion riceve il messaggio una volta sola");
});

test("server: senza chiave di Claude non si trascrive; modello mancante → 409 con lo stato", async () => {
  const noKey = await startVoiceServer({ ANTHROPIC_API_KEY: "" });
  const r = await noKey.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /chiave di Claude/);

  const s = await startVoiceServer();
  fs.rmSync(path.join(s.dataDir, "models"), { recursive: true, force: true });
  const missing = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2))));
  assert.equal(missing.status, 409);
  assert.equal(missing.json.voice.state, "missing");
  assert.equal((await s.req("GET", "/api/voice")).json.state, "missing");
});

test("server in cloud: i messaggi vocali richiedono l'accesso", async () => {
  const s = await startVoiceServer({ APP_PASSWORD: PASSWORD, PUBLIC_URL: "https://agenti.example.test", HOST: "127.0.0.1" });
  for (const [m, p] of [["GET", "/api/voice"], ["POST", "/api/voice/prepare"], ["POST", "/api/chat/voice"]]) {
    const r = await s.req(m, p, wavReq(wav16(tone(1))));
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const login = await s.req("POST", "/api/login", { body: { password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const ok = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2)), { cookie }));
  assert.equal(ok.status, 200, ok.body);
  const evil = await s.req("POST", "/api/chat/voice", wavReq(wav16(tone(2)), { cookie, origin: "https://evil.example" }));
  assert.equal(evil.status, 403, "richiesta da un altro sito bloccata");
});
