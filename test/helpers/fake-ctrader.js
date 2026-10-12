// Finto server cTrader per i test: parla lo stesso protocollo (file .proto ufficiali) su TCP in chiaro,
// più un finto endpoint OAuth per i token. Simula conti, prezzi, candele, ordini ed errori tipici.
import net from "node:net";
import http from "node:http";
import { encodeMessage, decodeMessage, frame, unframe } from "../../lib/ctrader/protocol.js";

export const ACCOUNTS = { demo: 1001, live: 2002 };
const SYMBOLS = [
  { symbolId: 1, symbolName: "EURUSD", description: "Euro vs US Dollar", enabled: true, sortingNumber: 1 },
  { symbolId: 2, symbolName: "XAUUSD", description: "Gold vs US Dollar", enabled: true, sortingNumber: 2 },
  { symbolId: 3, symbolName: "US500", description: "US 500 Index", enabled: true, sortingNumber: 3 },
  { symbolId: 4, symbolName: "ENI.IT", description: "Eni SpA", enabled: true, sortingNumber: 4 },
];
const DETAILS = {
  1: { digits: 5, pipPosition: 4, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, maxVolume: 10_000_000_000, price: 108_500 },
  2: { digits: 2, pipPosition: 2, lotSize: 10_000, minVolume: 100, stepVolume: 100, maxVolume: 10_000_000, price: 240_037_000 }, // 2400.37
  3: { digits: 1, pipPosition: 0, lotSize: 100, minVolume: 100, stepVolume: 100, maxVolume: 1_000_000, price: 600_000_000 },
  4: { digits: 3, pipPosition: 2, lotSize: 100, minVolume: 100, stepVolume: 100, maxVolume: 1_000_000, price: 1_450_000 },
};

export function startFake({ port = 0, tokenPort = 0, validTokens = new Set(["tok-1", "tok-2"]) } = {}) {
  const state = {
    received: [],
    positions: new Map(), // positionId -> {...}
    nextId: 500,
    rateLimitOnce: true,
    tokens: validTokens,
    refreshed: 0,
    sockets: new Set(),
    trendbarWindows: [],
    accountType: "HEDGED",
    failPnl: false,
    hook: null, // (nome del messaggio) => void, chiamato a ogni richiesta ricevuta
    clients: new Set(), // { authed, send } per ogni connessione
  };
  const step = (d) => 10 ** Math.max(0, 5 - d.digits); // i prezzi sono multipli di questo valore

  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    let buf = Buffer.alloc(0);
    const appAuthed = { ok: false };
    const authed = new Set();
    const send = (name, data, clientMsgId) => socket.write(frame(encodeMessage(name, data, clientMsgId)));
    const err = (code, id, extra = {}) => send("ProtoOAErrorRes", { errorCode: code, description: code, ...extra }, id);
    const client = { authed, send };
    state.clients.add(client);
    socket.on("close", () => {
      state.sockets.delete(socket);
      state.clients.delete(client);
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = unframe(buf);
      buf = rest;
      for (const bytes of messages) {
        const m = decodeMessage(bytes);
        state.received.push(m);
        state.hook?.(m.name);
        handle(m);
      }
    });

    function handle({ name, data, clientMsgId: id }) {
      const acc = data.ctidTraderAccountId;
      switch (name) {
        case "ProtoHeartbeatEvent":
          return;
        case "ProtoOAApplicationAuthReq":
          if (data.clientId !== "client-ok" || data.clientSecret !== "secret-ok") return err("CH_CLIENT_AUTH_FAILURE", id);
          appAuthed.ok = true;
          return send("ProtoOAApplicationAuthRes", {}, id);
        case "ProtoOAGetAccountListByAccessTokenReq":
          if (!state.tokens.has(data.accessToken)) return err("CH_ACCESS_TOKEN_INVALID", id);
          return send(
            "ProtoOAGetAccountListByAccessTokenRes",
            {
              accessToken: data.accessToken,
              permissionScope: "SCOPE_TRADE",
              ctidTraderAccount: [
                { ctidTraderAccountId: ACCOUNTS.demo, isLive: false, traderLogin: 5550001, brokerTitleShort: "FP Markets" },
                { ctidTraderAccountId: ACCOUNTS.live, isLive: true, traderLogin: 7770002, brokerTitleShort: "FP Markets" },
              ],
            },
            id,
          );
        case "ProtoOAAccountAuthReq":
          if (!appAuthed.ok) return err("CH_CLIENT_NOT_AUTHENTICATED", id);
          if (!state.tokens.has(data.accessToken)) return err("CH_ACCESS_TOKEN_INVALID", id);
          authed.add(acc);
          return send("ProtoOAAccountAuthRes", { ctidTraderAccountId: acc }, id);
      }
      if (acc != null && !authed.has(acc)) return err("ACCOUNT_NOT_AUTHORIZED", id, { ctidTraderAccountId: acc });
      switch (name) {
        case "ProtoOASymbolsListReq":
          return send("ProtoOASymbolsListRes", { ctidTraderAccountId: acc, symbol: SYMBOLS }, id);
        case "ProtoOASymbolByIdReq":
          return send(
            "ProtoOASymbolByIdRes",
            {
              ctidTraderAccountId: acc,
              symbol: data.symbolId.map((sid) => {
                const { price, ...d } = DETAILS[sid];
                return { symbolId: sid, ...d };
              }),
            },
            id,
          );
        case "ProtoOASubscribeSpotsReq":
          send("ProtoOASubscribeSpotsRes", { ctidTraderAccountId: acc }, id);
          for (const sid of data.symbolId) {
            const p = DETAILS[sid].price;
            const t = step(DETAILS[sid]);
            setTimeout(() => send("ProtoOASpotEvent", { ctidTraderAccountId: acc, symbolId: sid, bid: p, ask: p + 2 * t }), 20);
            // un aggiornamento con solo il bid: l'ask deve restare quello di prima
            setTimeout(() => send("ProtoOASpotEvent", { ctidTraderAccountId: acc, symbolId: sid, bid: p + t }), 60);
          }
          return;
        case "ProtoOAGetTrendbarsReq": {
          if (state.rateLimitOnce) {
            state.rateLimitOnce = false;
            return err("BLOCKED_PAYLOAD_TYPE", id, { retryAfter: 1 });
          }
          state.trendbarWindows.push(data.toTimestamp - data.fromTimestamp);
          const n = Math.min(data.count ?? 50, 50);
          const base = DETAILS[data.symbolId].price;
          const step = { D1: 1440, H1: 60 }[data.period] ?? 1440;
          const nowMin = Math.floor(data.toTimestamp / 60000);
          const trendbar = Array.from({ length: n }, (_, i) => ({
            volume: 1000 + i,
            period: data.period,
            low: base + i * 100,
            deltaOpen: 20,
            deltaHigh: 80,
            deltaClose: 50,
            utcTimestampInMinutes: nowMin - (n - 1 - i) * step,
          })).reverse(); // ordine qualunque: il client deve ordinare
          return send("ProtoOAGetTrendbarsRes", { ctidTraderAccountId: acc, period: data.period, trendbar, symbolId: data.symbolId }, id);
        }
        case "ProtoOAAssetListReq":
          return send("ProtoOAAssetListRes", { ctidTraderAccountId: acc, asset: [{ assetId: 1, name: "EUR", displayName: "EUR" }] }, id);
        case "ProtoOATraderReq":
          return send(
            "ProtoOATraderRes",
            {
              ctidTraderAccountId: acc,
              trader: { ctidTraderAccountId: acc, balance: 1_000_000, depositAssetId: 1, leverageInCents: 3000, moneyDigits: 2, accountType: state.accountType, traderLogin: 5550001, brokerName: "FP Markets" },
            },
            id,
          );
        case "ProtoOAReconcileReq":
          return send("ProtoOAReconcileRes", { ctidTraderAccountId: acc, position: [...state.positions.values()].filter((p) => p.acc === acc).map((p) => p.proto) }, id);
        case "ProtoOAGetPositionUnrealizedPnLReq":
          if (state.failPnl) return err("INTERNAL_ERROR", id);
          return send(
            "ProtoOAGetPositionUnrealizedPnLRes",
            {
              ctidTraderAccountId: acc,
              moneyDigits: 2,
              positionUnrealizedPnL: [...state.positions.values()].filter((p) => p.acc === acc).map((p) => ({ positionId: p.proto.positionId, grossUnrealizedPnL: -1234, netUnrealizedPnL: -1500 })),
            },
            id,
          );
        case "ProtoOANewOrderReq": {
          const d = DETAILS[data.symbolId];
          if (data.volume < d.minVolume || data.volume % d.stepVolume) return send("ProtoOAOrderErrorEvent", { ctidTraderAccountId: acc, errorCode: "TRADING_BAD_VOLUME", description: "bad volume" }, id);
          if (data.stopLoss != null || data.takeProfit != null) return send("ProtoOAOrderErrorEvent", { ctidTraderAccountId: acc, errorCode: "TRADING_BAD_STOPS", description: "absolute SL on market" }, id);
          // Come il server vero: le distanze relative devono rispettare i decimali dello strumento.
          if ((data.relativeStopLoss ?? 0) % step(d) || (data.relativeTakeProfit ?? 0) % step(d)) {
            return send("ProtoOAOrderErrorEvent", { ctidTraderAccountId: acc, errorCode: "TRADING_BAD_STOPS", description: "Relative stop loss has invalid precision" }, id);
          }
          const orderId = ++state.nextId;
          const positionId = ++state.nextId;
          const price = (data.tradeSide === "BUY" ? d.price + 2 * step(d) : d.price) / 100000;
          const sl = data.relativeStopLoss ? (data.tradeSide === "BUY" ? price - data.relativeStopLoss / 100000 : price + data.relativeStopLoss / 100000) : undefined;
          const tradeData = { symbolId: data.symbolId, volume: data.volume, tradeSide: data.tradeSide, label: data.label, comment: data.comment, openTimestamp: Date.now() };
          const order = { orderId, tradeData, orderType: "MARKET", orderStatus: "ORDER_STATUS_ACCEPTED" };
          const position = { positionId, tradeData, positionStatus: "POSITION_STATUS_OPEN", swap: 0, price, stopLoss: sl, moneyDigits: 2 };
          // Prima la conferma di accettazione (risposta alla richiesta), poi l'esecuzione come evento separato.
          send("ProtoOAExecutionEvent", { ctidTraderAccountId: acc, executionType: "ORDER_ACCEPTED", order, position: { ...position, positionStatus: "POSITION_STATUS_CREATED" } }, id);
          setTimeout(() => {
            state.positions.set(positionId, { acc, proto: position });
            send("ProtoOAExecutionEvent", {
              ctidTraderAccountId: acc,
              executionType: "ORDER_FILLED",
              order: { ...order, orderStatus: "ORDER_STATUS_FILLED" },
              position,
              deal: { dealId: ++state.nextId, orderId, positionId, volume: data.volume, filledVolume: data.volume, symbolId: data.symbolId, createTimestamp: Date.now(), executionTimestamp: Date.now(), executionPrice: price, tradeSide: data.tradeSide, dealStatus: "FILLED" },
            });
          }, 80);
          return;
        }
        case "ProtoOAClosePositionReq": {
          const p = state.positions.get(data.positionId);
          if (!p) return send("ProtoOAOrderErrorEvent", { ctidTraderAccountId: acc, errorCode: "POSITION_NOT_FOUND", positionId: data.positionId }, id);
          const orderId = ++state.nextId;
          const order = { orderId, tradeData: { ...p.proto.tradeData, volume: data.volume }, orderType: "MARKET", orderStatus: "ORDER_STATUS_ACCEPTED", closingOrder: true };
          send("ProtoOAExecutionEvent", { ctidTraderAccountId: acc, executionType: "ORDER_ACCEPTED", order, position: p.proto }, id);
          setTimeout(() => {
            if (data.volume >= p.proto.tradeData.volume) state.positions.delete(data.positionId);
            else p.proto = { ...p.proto, tradeData: { ...p.proto.tradeData, volume: p.proto.tradeData.volume - data.volume } };
            send("ProtoOAExecutionEvent", {
              ctidTraderAccountId: acc,
              executionType: "ORDER_FILLED",
              order: { ...order, orderStatus: "ORDER_STATUS_FILLED" },
              position: { ...p.proto, positionStatus: "POSITION_STATUS_CLOSED" },
              deal: { dealId: ++state.nextId, orderId, positionId: data.positionId, volume: data.volume, filledVolume: data.volume, symbolId: p.proto.tradeData.symbolId, createTimestamp: Date.now(), executionTimestamp: Date.now(), executionPrice: 1.0849, tradeSide: p.proto.tradeData.tradeSide === "BUY" ? "SELL" : "BUY", dealStatus: "FILLED" },
            });
          }, 80);
          return;
        }
        default:
          return err("UNSUPPORTED_MESSAGE", id);
      }
    }
  });

  // Finto OAuth: /apps/token
  const tokenServer = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.searchParams;
    if (u.pathname === "/apps/auth") {
      // pagina di accesso finta: concede subito l'accesso e torna all'app con il codice
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=code-ok` });
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    if (p.get("client_id") !== "client-ok" || p.get("client_secret") !== "secret-ok") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ errorCode: "ACCESS_DENIED", description: "Invalid client" }));
    }
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "code-ok") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ errorCode: "ACCESS_DENIED", description: "Invalid code" }));
      }
      return res.end(JSON.stringify({ accessToken: "tok-1", tokenType: "bearer", expiresIn: 2628000, refreshToken: "ref-1" }));
    }
    if (p.get("grant_type") === "refresh_token") {
      state.refreshed++;
      if (p.get("refresh_token") !== `ref-${state.refreshed}`) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ errorCode: "ACCESS_DENIED", description: "refresh token already used" }));
      }
      return res.end(JSON.stringify({ accessToken: `tok-${state.refreshed + 1}`, tokenType: "bearer", expiresIn: 2628000, refreshToken: `ref-${state.refreshed + 1}` }));
    }
    res.statusCode = 400;
    res.end("{}");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      tokenServer.listen(tokenPort, "127.0.0.1", () => {
        resolve({
          port: server.address().port,
          tokenPort: tokenServer.address().port,
          state,
          dropConnections: () => [...state.sockets].forEach((s) => s.destroy()),
          /** Simula un deposito (amount > 0) o un prelievo (amount < 0) sul conto. */
          deposit: (acc, amount) => {
            for (const c of state.clients) {
              if (!c.authed.has(acc)) continue;
              c.send("ProtoOAExecutionEvent", {
                ctidTraderAccountId: acc,
                executionType: "DEPOSIT_WITHDRAW",
                depositWithdraw: { operationType: amount > 0 ? "BALANCE_DEPOSIT" : "BALANCE_WITHDRAW", balanceHistoryId: ++state.nextId, balance: 1_000_000, delta: Math.round(Math.abs(amount) * 100), changeBalanceTimestamp: Date.now(), moneyDigits: 2 },
              });
            }
          },
          close: () => new Promise((r) => { [...state.sockets].forEach((s) => s.destroy()); server.close(() => tokenServer.close(r)); }),
        });
      });
    });
  });
}
