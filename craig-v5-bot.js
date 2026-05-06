/**
 * Antigravity Craig v5 Bot — Supertrend + EMA Trend Filter
 *
 * Strategy (backtested BYBIT:BTCUSDT.P, 15m, ~5yr):
 *   Signal  : Supertrend(3.5, 15) flips bearish → bullish
 *   Filter  : EMA50 > EMA200 AND close > EMA200  (long only)
 *   Entry   : Market at signal candle close
 *   SL      : 1.5 × ATR(14) below entry
 *   TP      : 3.5R above entry
 *   Backtest: 12 trades | 50% WR | PF 4.134 | +2.09% net | 0.52% DD
 *
 * Optional (from ICT AUTO PDF):
 *   HTF_FILTER=true  → also requires 4h close > 4h EMA200
 *   KILLZONE=true    → only trade London (07-10 UTC) or NY (13:30-16 UTC)
 *
 * Railway cron: 1,16,31,46 * * * *  (1 minute after each 15m candle close)
 * Local:        node craig-v5-bot.js
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";
import { tgSignal, tgEntry, tgExit, tgError } from "./telegram.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ─── Safety net ────────────────────────────────────────────────────────────────
setTimeout(() => { console.log("⏱ Max runtime — force exit"); process.exit(0); },
  2 * 60 * 1000).unref();

// ─── Config ────────────────────────────────────────────────────────────────────
const RULES_FILE = join(__dirname, "rules-craig-v5.json");
const RULES      = JSON.parse(readFileSync(RULES_FILE, "utf8"));

const CFG = {
  watchlist:       RULES.watchlist || ["BYBIT:BTCUSDT.P"],
  maxTradeSizeUSD: parseFloat(process.env.V5_MAX_USD    || RULES.parameters?.MAX_USD_PER_TRADE || "10"),
  maxTradesPerDay: parseInt(  process.env.V5_MAX_TRADES  || RULES.parameters?.MAX_TRADES_DAY   || "17"),
  leverage:        parseInt(  process.env.V5_LEVERAGE    || RULES.parameters?.LEVERAGE          || "10"),
  stFactor:        parseFloat(process.env.V5_ST_FACTOR   || RULES.parameters?.ST_FACTOR         || "3.5"),
  stPeriod:        parseInt(  process.env.V5_ST_PERIOD   || RULES.parameters?.ST_PERIOD          || "15"),
  slMult:          parseFloat(process.env.V5_SL_MULT     || RULES.parameters?.SL_MULT            || "1.5"),
  tpRR:            parseFloat(process.env.V5_TP_RR       || RULES.parameters?.TP_RR              || "3.5"),
  htfFilter:       process.env.V5_HTF_FILTER === "true",
  killzone:        process.env.V5_KILLZONE   === "true",
  cooldownMin:     parseInt(  process.env.V5_COOLDOWN    || RULES.parameters?.COOLDOWN_MIN       || "60"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = join(__dirname, "craig-v5-log.json");
const CSV_FILE = join(__dirname, "craig-v5-trades.csv");
const CSV_HDR  = ["Date","Time(UTC)","Symbol","Side","Qty","Entry","SL","TP",
                  "Risk%","RR","ATR","OrderID","Mode","Notes"].join(",");

// ─── Utilities ─────────────────────────────────────────────────────────────────
function loadLog()   { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(l)  { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function initCsv()   { if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HDR + "\n"); }

function todayCount(log) {
  const d = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.ts.startsWith(d) && t.placed).length;
}
function onCooldown(log, sym) {
  const cutoff = Date.now() - CFG.cooldownMin * 60_000;
  return log.trades.some(t => t.sym === sym && t.placed && new Date(t.ts) > cutoff);
}
function appendCsv(t, mode) {
  const dt = new Date(t.ts);
  const qty = ((CFG.maxTradeSizeUSD * CFG.leverage) / t.entry).toFixed(6);
  const row = [
    dt.toISOString().slice(0,10),
    dt.toISOString().slice(11,19),
    t.sym, "LONG", qty,
    t.entry.toFixed(4), t.sl.toFixed(4), t.tp.toFixed(4),
    (t.riskPct * 100).toFixed(3), CFG.tpRR,
    t.atr.toFixed(4), t.orderId || "",
    mode,
    `"ST_flip;ATR=${t.atr.toFixed(1)};EMA200=${t.ema200.toFixed(0)}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Market Data ───────────────────────────────────────────────────────────────
async function fetchCandles(symbol, interval, limit = 300) {
  const sym   = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  const okxSym = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");
  const barMap = { "1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","1d":"1D" };
  const bar    = barMap[interval] || "15m";
  const url    = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${bar}&limit=${limit}`;
  const res    = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OKX ${okxSym} ${bar}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX ${okxSym}: ${data.msg}`);
  return data.data.reverse().map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), vol: parseFloat(k[5]),
  }));
}

// ─── Indicators ────────────────────────────────────────────────────────────────

/** Wilder's ATR (same as Pine Script ta.atr) */
function calcATR(candles, period) {
  const n  = candles.length;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      candles[i].high  - candles[i].low,
      Math.abs(candles[i].high  - candles[i-1].close),
      Math.abs(candles[i].low   - candles[i-1].close),
    );
  }
  const atr = new Array(n).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/** EMA (standard exponential, 2/(n+1) smoothing) */
function calcEMA(candles, period) {
  const k   = 2 / (period + 1);
  const ema = new Array(candles.length).fill(null);
  let sum   = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i-1] * (1 - k);
  }
  return ema;
}

/**
 * Supertrend — identical logic to Pine Script ta.supertrend()
 * dir=-1 → bullish (price above ST line)
 * dir=+1 → bearish (price below ST line)
 */
function calcSupertrend(candles, factor, period) {
  const atr = calcATR(candles, period);
  const n   = candles.length;
  const fub = new Array(n).fill(null); // Final Upper Band
  const flb = new Array(n).fill(null); // Final Lower Band
  const dir = new Array(n).fill(null);

  for (let i = period; i < n; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const ub  = hl2 + factor * atr[i];
    const lb  = hl2 - factor * atr[i];

    if (i === period) {
      fub[i] = ub; flb[i] = lb; dir[i] = 1;
      continue;
    }

    // Upper band: decreases (or resets) if prior close broke above
    fub[i] = (ub < fub[i-1] || candles[i-1].close > fub[i-1]) ? ub : fub[i-1];
    // Lower band: increases (or resets) if prior close broke below
    flb[i] = (lb > flb[i-1] || candles[i-1].close < flb[i-1]) ? lb : flb[i-1];

    if (dir[i-1] === 1)       // was bearish → flip bullish if close > upper
      dir[i] = candles[i].close > fub[i] ? -1 : 1;
    else                      // was bullish → flip bearish if close < lower
      dir[i] = candles[i].close < flb[i] ?  1 : -1;
  }

  return { fub, flb, dir, atr };
}

// ─── Killzone check ────────────────────────────────────────────────────────────
function inKillzone() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const hm = h * 60 + m;
  const london = hm >= 7*60   && hm < 10*60;    // 07:00–10:00 UTC
  const ny     = hm >= 13*60+30 && hm < 16*60;  // 13:30–16:00 UTC
  return london || ny;
}

// ─── Strategy signal ───────────────────────────────────────────────────────────
async function getSignal(symbol) {
  const candles = await fetchCandles(symbol, "15m", 300);
  if (candles.length < 220) throw new Error("Not enough candles (<220)");

  const { dir, atr } = calcSupertrend(candles, CFG.stFactor, CFG.stPeriod);
  const ema50  = calcEMA(candles, 50);
  const ema200 = calcEMA(candles, 200);

  const i = candles.length - 1;

  // Need valid values at current and previous bar
  if (dir[i] == null || dir[i-1] == null || ema200[i] == null || atr[i] == null)
    return { signal: false, reason: "Insufficient indicator data" };

  // EMA trend filter (same as Pine: emaB = close > EMA200 AND EMA50 > EMA200)
  const emaB = candles[i].close > ema200[i] && ema50[i] > ema200[i];

  // Supertrend flip: bearish (dir≥1) → bullish (dir=-1)
  const stFlip = dir[i] === -1 && dir[i-1] === 1;

  // Killzone filter (optional)
  if (CFG.killzone && !inKillzone())
    return { signal: false, reason: "Outside killzone (London/NY)" };

  // HTF 4h alignment (optional)
  if (CFG.htfFilter) {
    const c4h    = await fetchCandles(symbol, "4h", 220);
    const e2004h = calcEMA(c4h, 200);
    const j      = c4h.length - 1;
    if (e2004h[j] == null || c4h[j].close <= e2004h[j])
      return { signal: false, reason: "4h HTF not aligned (close < 4h EMA200)" };
  }

  if (!emaB)   return { signal: false, reason: `EMA filter not met (close=${candles[i].close.toFixed(0)}, EMA200=${ema200[i].toFixed(0)}, EMA50=${ema50[i].toFixed(0)})` };
  if (!stFlip) return { signal: false, reason: `No ST flip yet (dir[i]=${dir[i]}, dir[i-1]=${dir[i-1]})` };

  const entry   = candles[i].close;
  const sl      = entry - CFG.slMult * atr[i];
  const risk    = entry - sl;
  const tp      = entry + CFG.tpRR * risk;
  const riskPct = risk / entry;

  return {
    signal: true,
    sym:     symbol,
    entry, sl, tp,
    atr:     atr[i],
    ema200:  ema200[i],
    ema50:   ema50[i],
    riskPct,
    ts:      new Date().toISOString(),
  };
}

// ─── BitGet Execution ──────────────────────────────────────────────────────────
function signBitGet(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CFG.bitget.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, bodyObj = null) {
  const ts      = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig     = signBitGet(ts, method, path, bodyStr);
  const res     = await fetch(`${CFG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type":       "application/json",
      "ACCESS-KEY":         CFG.bitget.apiKey,
      "ACCESS-SIGN":        sig,
      "ACCESS-TIMESTAMP":   ts,
      "ACCESS-PASSPHRASE":  CFG.bitget.passphrase,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg} (${data.code})`);
  return data.data;
}

async function placeLong(r) {
  const sym = r.sym.replace(/^[^:]+:/, "").replace(/\.P$/, "");

  // Set leverage
  await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {
    symbol: sym, productType: "USDT-FUTURES", marginCoin: "USDT",
    leverage: String(CFG.leverage), holdSide: "long_short",
  });

  const qty = ((CFG.maxTradeSizeUSD * CFG.leverage) / r.entry).toFixed(4);

  const order = await bitgetRequest("POST", "/api/v2/mix/order/placeOrder", {
    symbol:                sym,
    productType:           "USDT-FUTURES",
    marginMode:            "isolated",
    marginCoin:            "USDT",
    side:                  "open_long",
    orderType:             "market",
    size:                  qty,
    tradeSide:             "long",
    presetStopLossPrice:   r.sl.toFixed(2),
    presetStopSurplusPrice: r.tp.toFixed(2),
  });

  return order.orderId;
}

// ─── Exit Tracker ──────────────────────────────────────────────────────────────
async function checkOpenPositions(log) {
  const open = log.trades.filter(t => t.placed && !t.closed);
  if (open.length === 0) return;

  console.log(`── Exit check: ${open.length} open position(s) ─────────────────`);
  for (const t of open) {
    const name = t.sym.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    try {
      const candles = await fetchCandles(t.sym, "15m", 3);
      const price   = candles[candles.length - 1].close;

      let exitReason = null;
      let exitPrice  = null;
      if (price <= t.sl)  { exitReason = "SL"; exitPrice = t.sl; }
      else if (price >= t.tp) { exitReason = "TP"; exitPrice = t.tp; }

      if (exitReason) {
        const pnl = (exitPrice - t.entry) / t.entry * CFG.maxTradeSizeUSD * CFG.leverage;
        t.closed = true; t.exitPrice = exitPrice; t.exitReason = exitReason;
        t.exitTime = new Date().toISOString(); t.pnl = pnl;
        console.log(`  ${exitReason === "TP" ? "✅" : "❌"} ${name} → ${exitReason} @ $${exitPrice.toFixed(4)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
        await tgExit({ bot:"Craig v5", sym:t.sym, reason:exitReason, entry:t.entry, exitPrice, pnl, mode:t.paper?"PAPER":"LIVE" });
      } else {
        const unrealPnl = (price - t.entry) / t.entry * CFG.maxTradeSizeUSD * CFG.leverage;
        console.log(`  📊 ${name} open | $${price.toFixed(4)} | Unrealized: ${unrealPnl >= 0 ? "+" : ""}$${unrealPnl.toFixed(4)}`);
      }
    } catch (err) { console.log(`  ❌ Error checking ${name}: ${err.message}`); }
  }
  console.log();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  initCsv();
  const log   = loadLog();
  await checkOpenPositions(log);
  saveLog(log);
  let   today = todayCount(log);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Antigravity Craig v5 — Supertrend + EMA Trend Filter");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode    : ${CFG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log(`  Params  : ST(${CFG.stFactor}, ${CFG.stPeriod}) | SL=${CFG.slMult}×ATR | TP=${CFG.tpRR}R | Lev=${CFG.leverage}x`);
  console.log(`  Watching: ${CFG.watchlist.map(s => s.replace(/^[^:]+:/,"").replace(/\.P$/,"")).join(", ")}`);
  console.log(`  Trades  : ${today}/${CFG.maxTradesPerDay} today`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (today >= CFG.maxTradesPerDay) {
    console.log("🚫 Daily limit reached. Done.\n"); return;
  }

  for (const sym of CFG.watchlist) {
    if (today >= CFG.maxTradesPerDay) {
      console.log("🚫 Daily limit reached mid-scan. Stopping.\n"); break;
    }

    const name = sym.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    process.stdout.write(`  ${name.padEnd(14)}`);

    if (onCooldown(log, sym)) {
      console.log(`⏭  cooldown (${CFG.cooldownMin}min)`);
      continue;
    }

    let result;
    try {
      result = await getSignal(sym);
    } catch (err) {
      console.log(`❌ ${err.message}`);
      continue;
    }

    if (!result.signal) {
      console.log(`—  ${result.reason}`);
      continue;
    }

    if (log.trades.some(t => t.sym === sym && t.placed && !t.closed)) {
      console.log(`—  already in position`); continue;
    }

    console.log(`✅ SIGNAL`);
    console.log(`   Entry: $${result.entry.toFixed(4)}  SL: $${result.sl.toFixed(4)}  TP: $${result.tp.toFixed(4)}`);
    console.log(`   Risk:  ${(result.riskPct*100).toFixed(3)}%  ATR: ${result.atr.toFixed(2)}  EMA200: ${result.ema200.toFixed(2)}`);
    await tgSignal({ bot:"Craig v5", sym:result.sym, entry:result.entry, sl:result.sl, tp:result.tp, riskPct:result.riskPct, atr:result.atr, mode: CFG.paperTrading?"PAPER":"LIVE" });

    const logEntry = {
      ts:      result.ts,
      sym:     result.sym,
      entry:   result.entry,
      sl:      result.sl,
      tp:      result.tp,
      atr:     result.atr,
      ema200:  result.ema200,
      riskPct: result.riskPct,
      placed:  false,
      closed:  false,
      orderId: null,
      paper:   CFG.paperTrading,
    };

    if (CFG.paperTrading) {
      logEntry.placed  = true;
      logEntry.orderId = `V5-PAPER-${Date.now()}`;
      console.log(`   📋 PAPER TRADE logged.\n`);
      appendCsv(logEntry, "PAPER");
      await tgEntry({ bot:"Craig v5", sym:result.sym, orderId:logEntry.orderId, entry:result.entry, sl:result.sl, tp:result.tp, mode:"PAPER" });
    } else {
      try {
        logEntry.orderId = await placeLong(result);
        logEntry.placed  = true;
        console.log(`   ✅ LIVE ORDER — ${logEntry.orderId}\n`);
        appendCsv(logEntry, "LIVE");
        await tgEntry({ bot:"Craig v5", sym:result.sym, orderId:logEntry.orderId, entry:result.entry, sl:result.sl, tp:result.tp, mode:"LIVE" });
      } catch (err) {
        logEntry.error = err.message;
        console.log(`   ❌ ORDER FAILED: ${err.message}\n`);
        appendCsv(logEntry, "FAILED");
        await tgError({ bot:"Craig v5", msg:`ORDER FAILED: ${err.message}` });
      }
    }

    log.trades.push(logEntry);
    today++;
  }

  saveLog(log);
  console.log(`\nLog → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Craig v5 error:", err.message); process.exit(1); });
