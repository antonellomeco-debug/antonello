// Immagini fatte con l'intelligenza artificiale: Gemini di Google ("Nano Banana"), con la chiave dell'utente
// (aistudio.google.com → Get API key). Si paga a immagine (circa 0,04–0,07 $ in qualità 1K, ottobre 2026): la
// stima si somma alla spesa mostrata nell'app. Senza chiave gli agenti usano le grafiche (create_graphic).
import { call } from "./http.js";
import { getSettings, updateSettings } from "../settings.js";
import { addImageBuffer, getMedia, mediaPath, getSharp } from "./media.js";

// Il primo modello è il più recente; se Google lo ritira (404) si passa al successivo.
const MODELS = (process.env.GEMINI_IMAGE_MODELS ?? "gemini-3.1-flash-image-preview,gemini-2.5-flash-image").split(",").map((s) => s.trim()).filter(Boolean);
export const IMAGE_COST_USD = 0.07;
const ASPECT = { square: "1:1", portrait: "4:5", story: "9:16", landscape: "16:9" };

export function aiStatus() {
  const key = getSettings().geminiKey;
  return { configured: Boolean(key), hint: key ? `…${String(key).slice(-4)}` : null, costPerImage: IMAGE_COST_USD };
}

export function setGeminiKey(key) {
  const k = String(key ?? "").trim();
  if (k && !/^[A-Za-z0-9_-]{20,100}$/.test(k)) throw new Error("La chiave di Gemini non sembra giusta: copiala di nuovo da aistudio.google.com (Get API key).");
  updateSettings({ geminiKey: k || null });
  return aiStatus();
}

/**
 * Crea un'immagine dalla descrizione (prompt). reference: id di foto dell'archivio da usare come base
 * (es. "metti questo prodotto su uno sfondo da spiaggia"). Restituisce il nuovo file dell'archivio.
 */
export async function generateImage({ prompt, format = "portrait", reference = [], title = "", by = null } = {}) {
  const key = getSettings().geminiKey;
  if (!key) throw new Error("Le immagini con l'IA non sono attive: l'utente deve mettere la chiave di Gemini in 📣 Social → Immagini con l'IA. Intanto usa create_graphic.");
  const text = String(prompt ?? "").trim();
  if (text.length < 5) throw new Error("prompt: descrivi l'immagine da creare");
  if (!ASPECT[format]) throw new Error(`format: ${Object.keys(ASPECT).join(", ")} (per le copertine dei profili usa create_graphic)`);
  const sharp = await getSharp();
  const parts = [{ text: text.slice(0, 4000) }];
  for (const id of [].concat(reference ?? []).slice(0, 3)) {
    const m = getMedia(id);
    if (m.kind !== "image") throw new Error(`${id} è un video: come riferimento servono foto`);
    const jpg = await sharp(mediaPath(m)).resize({ width: 1536, height: 1536, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
    parts.push({ inline_data: { mime_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  let lastErr;
  for (const model of MODELS) {
    let res;
    try {
      res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key },
        json: { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: ASPECT[format] } } },
        timeoutMs: 180_000,
      });
    } catch (err) {
      lastErr = err;
      if (err.status === 404) continue; // modello ritirato o non disponibile: si prova il prossimo
      if (err.status === 400 && /API key/i.test(err.message)) throw new Error("La chiave di Gemini non è valida: controllala in 📣 Social → Immagini con l'IA.");
      if (err.status === 429) throw new Error("Gemini: troppe richieste o credito finito (controlla la fatturazione su aistudio.google.com). Riprova più tardi.");
      throw new Error(`Gemini non ha creato l'immagine: ${err.message}`);
    }
    const cand = res?.candidates?.[0];
    const img = cand?.content?.parts?.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);
    if (!img) {
      const why = res?.promptFeedback?.blockReason ?? cand?.finishReason ?? "nessuna immagine nella risposta";
      const said = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join(" ").slice(0, 300);
      throw new Error(`Gemini non ha creato l'immagine (${why})${said ? `: ${said}` : ""}. Cambia la descrizione (niente persone reali famose, marchi o contenuti vietati).`);
    }
    const media = await addImageBuffer(Buffer.from(img.data, "base64"), { title: title || text.slice(0, 80), description: `Immagine IA: ${text.slice(0, 900)}`, origin: "ai", by });
    return { ...media, model, cost: IMAGE_COST_USD };
  }
  throw new Error(`Gemini: nessun modello per le immagini disponibile (${lastErr?.message ?? "?"})`);
}
