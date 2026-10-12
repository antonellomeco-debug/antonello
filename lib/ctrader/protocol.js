// Messaggi della cTrader Open API: codifica/decodifica con i file .proto ufficiali di Spotware.
// Ogni messaggio viaggia dentro un ProtoMessage { payloadType, payload, clientMsgId };
// sulla connessione TCP/TLS ogni ProtoMessage è preceduto dalla sua lunghezza (4 byte, big-endian).
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "proto");
const root = protobuf.loadSync(
  ["OpenApiCommonModelMessages.proto", "OpenApiCommonMessages.proto", "OpenApiModelMessages.proto", "OpenApiMessages.proto"].map((f) =>
    path.join(DIR, f),
  ),
);

const ProtoMessage = root.lookupType("ProtoMessage");
const payloadEnums = [root.lookupEnum("ProtoPayloadType"), root.lookupEnum("ProtoOAPayloadType")];

/** Numero del tipo di messaggio → tipo protobuf, ricavato dal valore di default del campo payloadType. */
const byPayload = new Map();
const byName = new Map();
for (const type of root.nestedArray.filter((n) => n instanceof protobuf.Type)) {
  const field = type.fields.payloadType;
  const def = field?.options?.default;
  if (!def) continue;
  const num = payloadEnums.map((e) => e.values[def]).find((v) => v != null);
  if (num == null) continue;
  byPayload.set(num, type);
  byName.set(type.name, { type, payloadType: num });
}

const TO_OBJECT = { longs: Number, enums: String, defaults: false };

export const PAYLOAD = Object.fromEntries([...byName].map(([name, v]) => [name, v.payloadType]));

export function payloadTypeOf(name) {
  const entry = byName.get(name);
  if (!entry) throw new Error(`Messaggio cTrader sconosciuto: ${name}`);
  return entry.payloadType;
}

/** Costruisce i byte di un ProtoMessage (senza il prefisso di lunghezza). */
export function encodeMessage(name, fields = {}, clientMsgId) {
  const { type, payloadType } = byName.get(name) ?? {};
  if (!type) throw new Error(`Messaggio cTrader sconosciuto: ${name}`);
  const message = type.fromObject(fields); // accetta anche i nomi degli enum (es. "BUY")
  const err = type.verify(message);
  if (err) throw new Error(`Messaggio ${name} non valido: ${err}`);
  const missing = type.fieldsArray.filter((f) => f.required && f.name !== "payloadType" && !Object.hasOwn(message, f.name));
  if (missing.length) throw new Error(`Messaggio ${name}: mancano ${missing.map((f) => f.name).join(", ")}`);
  const payload = type.encode(message).finish();
  const msg = { payloadType, payload };
  if (clientMsgId) msg.clientMsgId = clientMsgId;
  return ProtoMessage.encode(ProtoMessage.create(msg)).finish();
}

/** Decodifica un ProtoMessage → { name, payloadType, clientMsgId, data }. */
export function decodeMessage(bytes) {
  const msg = ProtoMessage.decode(bytes);
  const type = byPayload.get(msg.payloadType);
  const data = type && msg.payload?.length ? type.toObject(type.decode(msg.payload), TO_OBJECT) : {};
  return { name: type?.name ?? `payload_${msg.payloadType}`, payloadType: msg.payloadType, clientMsgId: msg.clientMsgId || null, data };
}

/** Aggiunge il prefisso di lunghezza (4 byte big-endian) usato sulla connessione TCP. */
export function frame(bytes) {
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  Buffer.from(bytes).copy(out, 4);
  return out;
}

/** Separa i messaggi completi da un buffer in arrivo; restituisce { messages, rest }. */
export function unframe(buffer, maxLength = 15_000_000) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32BE(offset);
    if (len > maxLength) throw new Error(`Messaggio troppo lungo dal server (${len} byte)`);
    if (buffer.length - offset - 4 < len) break;
    messages.push(buffer.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export const enums = {
  tradeSide: root.lookupEnum("ProtoOATradeSide").values,
  orderType: root.lookupEnum("ProtoOAOrderType").values,
  trendbarPeriod: root.lookupEnum("ProtoOATrendbarPeriod").values,
};
