/**
 * Antigravity v3 — Asia Low Sweep Bot [15m, BTCUSDT, Long Only]
 *
 * Strategy:
 *   1. Track Asia session (00:00–08:00 UTC) High/Low on 15m BTC candles
 *   2. During trade window (08:00–22:00 UTC), detect sweep of Asia Low (price ≥0.15% below)
 *   3. Enter LONG when: sweep detected + bullish confirmation candle + confluence ≥4/6
 *   4. SL: sweep_low − 0.5×ATR | TP: 4×R
 *   5. Force-close at 22:00 UTC if still open
 *
 * Run locally:   node agv3-bot.js
 * On Railway:    set start command to "node agv3-bot.js", cron every 15min
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.AGV3_SYMBOL || "BYBIT:BTCUSDT.P",
  tradeSize: parseFloat(process.env.TRADE_SIZE_USDT || "20"),        // fixed USDT margin per trade
  leverage: parseInt(process.env.LEVERAGE || "10"),                   // futures leverage
  paperTrading: process.env.PAPER_TRADING !== "false",

  // Strategy params (match Pine Script)
  asiaStartHour: 0,   // UTC
  asiaEndHour: 8,     // UTC
  tradeStartHour: 8,  // UTC
  tradeEndHour: 22,   // UTC
  minSweepDepthPct: 0.15,   // % below Asia Low required
  minConfluence: 4,          // out of 6
  slMult: 0.5,              // ATR multiplier for SL
  tpRR: 4.0,                // Risk:Reward ratio
  sweepExpireBars: 8,       // bars before sweep signal expires

  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const STATE_FILE = "agv3-state.json";
const LOG_FILE   = "agv3-log.json";
const CSV_FILE   = "agv3-trades.csv";
const CSV_HEADER = "Date,Time (UTC),Symbol,Side,Size USD,Entry Price,SL,TP,Exit Price,PnL USD,Mode,Score,Notes";

// ─── State (persists between runs) ───────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return defaultState();
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return defaultState(); }
}

function defaultState() {
  return {
    // Asia session tracking
    asiaHigh: null,
    asiaLow: null,
    prevAsiaHigh: null,
    prevAsiaLow: null,
    asiaDate: null,       // YYYY-MM-DD UTC of current Asia session

    // Sweep state
    sweepActive: false,
    sweepBar: 0,
    sweepLow: null,       // lowest wick during sweep (for SL)

    // Open position
    position: null,       // { side, entryPrice, sl, tp, size, entryTime, score }
    barIndex: 0,
  };
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── CSV Logging ─────────────────────────────────────────────────────────────

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADER + "\n");
}

function logTrade(entry) {
  const now = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const row = [
    date, time, CONFIG.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, ""),
    entry.side, entry.sizeUsd?.toFixed(2) ?? "",
    entry.entryPrice?.toFixed(2) ?? "",
    entry.sl?.toFixed(2) ?? "", entry.tp?.toFixed(2) ?? "",
    entry.exitPrice?.toFixed(2) ?? "", entry.pnl?.toFixed(4) ?? "",
    CONFIG.paperTrading ? "PAPER" : "LIVE",
    entry.score ?? "", `"${entry.notes ?? ""}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles15m(limit = 300) {
  const sym = CONFIG.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  const okxSym = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=15m&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX ${okxSym}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX ${okxSym}: ${data.msg}`);
  // OKX returns newest first → reverse to chronological
  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchCandles4h(limit = 100) {
  const sym = CONFIG.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  const okxSym = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=4H&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX 4H ${okxSym}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX 4H ${okxSym}: ${data.msg}`);
  return data.data.reverse().map((k) => ({
    close: parseFloat(k[4]),
  }));
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function ema(arr, period) {
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / ((losses / period) || 1e-9);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVWAP(candles) {
  // Anchored to midnight UTC
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (!session.length) return candles[candles.length - 1].close;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? candles[candles.length - 1].close : tpv / vol;
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smooth = 3) {
  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    rsiSeries.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  }
  if (rsiSeries.length < stochPeriod) return 50;
  const window = rsiSeries.slice(-stochPeriod);
  const minR = Math.min(...window);
  const maxR = Math.max(...window);
  return maxR === minR ? 0 : ((rsiSeries[rsiSeries.length - 1] - minR) / (maxR - minR)) * 100;
}

function calcMFI(candles, period = 14) {
  const slice = candles.slice(-period - 1);
  let pos = 0, neg = 0;
  for (let i = 1; i < slice.length; i++) {
    const tp   = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const prev = (slice[i-1].high + slice[i-1].low + slice[i-1].close) / 3;
    const mf = tp * slice[i].volume;
    if (tp > prev) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 2) return 15;
  const slice = candles.slice(-period - 2);
  const dmPlus = [], dmMinus = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const upMove   = slice[i].high - slice[i-1].high;
    const downMove = slice[i-1].low - slice[i].low;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close)));
  }
  const atrVal  = tr.reduce((a,b)=>a+b,0) / period;
  const plusDI  = (dmPlus.reduce((a,b)=>a+b,0) / period) / (atrVal || 1) * 100;
  const minusDI = (dmMinus.reduce((a,b)=>a+b,0) / period) / (atrVal || 1) * 100;
  const dx = Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1) * 100;
  return dx;
}

// ─── Asia Session Tracker ─────────────────────────────────────────────────────

function updateAsiaSession(candles15m, state) {
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const todayDate = now.toISOString().slice(0, 10);

  // Yesterday date for determining the most recent completed Asia session
  const yesterdayDate = new Date(now - 86400000).toISOString().slice(0, 10);

  // Filter candles for today's Asia session (00:00-08:00 UTC)
  const todayAsiaStart = new Date(todayDate + "T00:00:00Z").getTime();
  const todayAsiaEnd   = new Date(todayDate + "T08:00:00Z").getTime();

  const asiaCandles = candles15m.filter((c) =>
    c.time >= todayAsiaStart && c.time < todayAsiaEnd
  );

  // Previous completed Asia session (for trade window)
  let prevAsiaStart, prevAsiaEnd;
  if (hourUTC >= 8) {
    // Today's Asia session is complete
    prevAsiaStart = todayAsiaStart;
    prevAsiaEnd   = todayAsiaEnd;
  } else {
    // Still in Asia or before trade window — use yesterday's Asia
    prevAsiaStart = new Date(yesterdayDate + "T00:00:00Z").getTime();
    prevAsiaEnd   = new Date(yesterdayDate + "T08:00:00Z").getTime();
  }

  const prevAsiaCandles = candles15m.filter((c) =>
    c.time >= prevAsiaStart && c.time < prevAsiaEnd
  );

  if (prevAsiaCandles.length > 0) {
    state.prevAsiaHigh = Math.max(...prevAsiaCandles.map((c) => c.high));
    state.prevAsiaLow  = Math.min(...prevAsiaCandles.map((c) => c.low));
  }

  return state;
}

// ─── Confluence Scoring ───────────────────────────────────────────────────────

function calcConfluence(candles15m, candles4h) {
  const closes = candles15m.map((c) => c.close);
  const bar    = candles15m[candles15m.length - 1];

  const rsi     = calcRSI(closes, 14);
  const vwap    = calcVWAP(candles15m);
  const stochK  = calcStochRSI(closes);
  const mfi     = calcMFI(candles15m, 14);
  const adx     = calcADX(candles15m, 14);
  const ema21   = ema(closes, 21);

  const c1 = rsi > 35 && rsi < 70;          // RSI healthy
  const c2 = bar.close > vwap;               // Above VWAP
  const c3 = stochK < 60;                    // StochRSI has upside
  const c4 = mfi > 35;                       // MFI positive
  const c5 = adx > 15;                       // Trending
  const c6 = bar.close > ema21;              // Above EMA21

  const score = [c1,c2,c3,c4,c5,c6].filter(Boolean).length;

  return {
    score, c1, c2, c3, c4, c5, c6,
    rsi, vwap, stochK, mfi, adx, ema21,
    close: bar.close, open: bar.open, high: bar.high, low: bar.low,
  };
}

// ─── Main Strategy Logic ──────────────────────────────────────────────────────

function runStrategy(candles15m, candles4h, state) {
  const now = new Date();
  const hourUTC = now.getUTCHours();

  const inTrade = hourUTC >= CONFIG.tradeStartHour && hourUTC < CONFIG.tradeEndHour;
  const bar     = candles15m[candles15m.length - 1];
  const atr14   = calcATR(candles15m, 14);

  state = updateAsiaSession(candles15m, state);
  state.barIndex++;

  const pal = state.prevAsiaLow;   // Previous Asia Low
  const pah = state.prevAsiaHigh;

  let action = "HOLD";
  let conf = null;
  let notes = "";

  // ── Check open position ─────────────────────────────────────────────────
  if (state.position) {
    const pos = state.position;

    // Check SL
    if (bar.low <= pos.sl) {
      action = "EXIT_SL";
      notes  = "SL hit";
    }
    // Check TP
    else if (bar.high >= pos.tp) {
      action = "EXIT_TP";
      notes  = "TP hit";
    }
    // Force close at session end
    else if (!inTrade) {
      action = "EXIT_SESSION";
      notes  = "Session end";
    }
  }

  // ── Look for new entry (only if no position) ────────────────────────────
  if (!state.position && action === "HOLD" && inTrade && pal !== null) {
    const sweepMin = pal * (1 - CONFIG.minSweepDepthPct / 100);

    // Detect sweep of Asia Low
    if (bar.low < sweepMin) {
      if (!state.sweepActive) {
        state.sweepActive = true;
        state.sweepBar    = state.barIndex;
        state.sweepLow    = bar.low;
      } else if (bar.low < state.sweepLow) {
        state.sweepLow = bar.low;  // track deepest wick
      }
    }

    // Expire sweep signal
    if (state.sweepActive && (state.barIndex - state.sweepBar) > CONFIG.sweepExpireBars) {
      state.sweepActive = false;
      state.sweepLow    = null;
    }

    // Confirmation: close back above Asia Low + bullish candle
    if (state.sweepActive && bar.close > pal) {
      const bullishCandle = bar.close > bar.open && (bar.close - bar.open) > atr14 * 0.1;

      if (bullishCandle) {
        conf = calcConfluence(candles15m, candles4h);

        if (conf.score >= CONFIG.minConfluence) {
          action = "ENTER_LONG";
          state.sweepActive = false;
        } else {
          notes = `Sweep confirmed but confluence too low (${conf.score}/${CONFIG.minConfluence})`;
        }
      }
    }
  }

  return { action, state, conf, bar, atr14, pal, pah, inTrade, notes };
}

// ─── BitGet Execution ─────────────────────────────────────────────────────────

function signBitGet(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, bodyObj = null) {
  const ts      = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig     = signBitGet(ts, method, path, bodyStr);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg}`);
  return data.data;
}

async function setLeverage(sym) {
  await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {
    symbol:      sym,
    productType: "USDT-FUTURES",
    marginCoin:  "USDT",
    leverage:    String(CONFIG.leverage),
    holdSide:    "long_short",
  });
}

async function placeOrder(side, sizeUSD, price) {
  if (CONFIG.paperTrading) {
    return { orderId: `PAPER_${Date.now()}` };
  }

  const sym = CONFIG.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");

  // Set leverage first
  await setLeverage(sym);

  // Notional = margin × leverage → qty in BTC
  const notional = sizeUSD * CONFIG.leverage;
  const qty = (notional / price).toFixed(6);

  return await bitgetRequest("POST", "/api/v2/mix/order/placeOrder", {
    symbol:      sym,
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    side:        side === "buy" ? "open_long" : "open_short",
    orderType:   "market",
    size:        qty,
    tradeSide:   side === "buy" ? "long" : "short",
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Safety net — force exit after 3 minutes so cron never hangs
setTimeout(() => {
  console.log("⏱ Max runtime (3 min) exceeded — force exit");
  process.exit(0);
}, 3 * 60 * 1000).unref();

async function run() {
  // Onboarding check
  if (!CONFIG.bitget.apiKey && !CONFIG.paperTrading) {
    console.error("❌ Missing BITGET_API_KEY — set env vars or enable PAPER_TRADING=true");
    process.exit(1);
  }

  initCsv();
  const state = loadState();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Antigravity v3 — Asia Low Sweep Bot [15m BTC Long Only]");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Fetch data
  let candles15m, candles4h;
  try {
    console.log("  Fetching 15m candles...");
    candles15m = await fetchCandles15m(300);
    console.log(`  ✓ Got ${candles15m.length} bars | Last close: $${candles15m[candles15m.length-1].close.toFixed(2)}`);

    candles4h = await fetchCandles4h(60);
  } catch (err) {
    console.error("❌ Data fetch failed:", err.message);
    process.exit(1);
  }

  const bar = candles15m[candles15m.length - 1];
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const inTrade = hourUTC >= CONFIG.tradeStartHour && hourUTC < CONFIG.tradeEndHour;

  // Run strategy
  const { action, state: newState, conf, atr14, pal, pah, notes } = runStrategy(candles15m, candles4h, state);

  // Status display
  console.log(`\n  BTC: $${bar.close.toFixed(2)}  |  ATR: $${atr14.toFixed(2)}`);
  console.log(`  Asia Low: ${pal ? "$"+pal.toFixed(2) : "N/A"}  |  Asia High: ${pah ? "$"+pah.toFixed(2) : "N/A"}`);
  console.log(`  Session: ${inTrade ? "TRADE WINDOW ✓" : `OFF (${hourUTC}h UTC)`}`);
  console.log(`  Sweep active: ${newState.sweepActive ? "YES ↑ (low=" + newState.sweepLow?.toFixed(2) + ")" : "no"}`);
  console.log(`  Position: ${newState.position ? `LONG @ $${newState.position.entryPrice.toFixed(2)} | SL $${newState.position.sl.toFixed(2)} | TP $${newState.position.tp.toFixed(2)}` : "none"}\n`);

  if (conf) {
    console.log(`  Confluence Score: ${conf.score}/6`);
    console.log(`  RSI: ${conf.rsi.toFixed(1)}  |  StochK: ${conf.stochK.toFixed(1)}  |  MFI: ${conf.mfi.toFixed(1)}  |  ADX: ${conf.adx.toFixed(1)}`);
    console.log(`  VWAP: $${conf.vwap.toFixed(2)}  |  EMA21: $${conf.ema21.toFixed(2)}  |  Close: $${conf.close.toFixed(2)}\n`);
  }

  // ── Execute action ──────────────────────────────────────────────────────

  if (action === "ENTER_LONG") {
    const sizeUSD = CONFIG.tradeSize;  // fixed USDT margin per trade
    const sl      = newState.sweepLow - atr14 * CONFIG.slMult;
    const risk    = bar.close - sl;
    const tp      = bar.close + risk * CONFIG.tpRR;

    console.log("  ══════════════════════════════════════════════════");
    console.log(`  🎯 LONG SIGNAL — Score ${conf.score}/6`);
    console.log(`  Entry:  $${bar.close.toFixed(2)}`);
    console.log(`  SL:     $${sl.toFixed(2)}  (−$${(bar.close - sl).toFixed(2)}, ${((bar.close-sl)/bar.close*100).toFixed(3)}%)`);
    console.log(`  TP:     $${tp.toFixed(2)}  (+$${(tp - bar.close).toFixed(2)}, ${((tp-bar.close)/bar.close*100).toFixed(3)}%)`);
    console.log(`  Size:   $${sizeUSD.toFixed(2)} margin × ${CONFIG.leverage}x = $${(sizeUSD * CONFIG.leverage).toFixed(2)} notional`);
    console.log(`  Mode:   ${CONFIG.paperTrading ? "PAPER" : "LIVE"}`);
    console.log("  ══════════════════════════════════════════════════\n");

    try {
      const order = await placeOrder("buy", sizeUSD, bar.close);

      newState.position = {
        side: "LONG",
        entryPrice: bar.close,
        sl, tp,
        size: sizeUSD,
        entryTime: now.toISOString(),
        score: `${conf.score}/6`,
        orderId: order?.orderId ?? "",
      };

      logTrade({
        timestamp: now.toISOString(),
        side: "LONG", sizeUsd: sizeUSD,
        entryPrice: bar.close, sl, tp,
        score: `${conf.score}/6`,
        notes: `Asia Low sweep @${pal?.toFixed(2)}`,
      });

      console.log(`  ✅ Order placed: ${CONFIG.paperTrading ? "PAPER" : order?.orderId}`);
    } catch (err) {
      console.error("  ❌ Order failed:", err.message);
    }
  }

  else if (action.startsWith("EXIT_")) {
    const pos = newState.position;
    const exitPrice = action === "EXIT_SL"      ? pos.sl
                    : action === "EXIT_TP"      ? pos.tp
                    : bar.close; // session end

    const pnl = ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.size;

    console.log("  ══════════════════════════════════════════════════");
    console.log(`  📤 EXIT: ${action} @ $${exitPrice.toFixed(2)}`);
    console.log(`  Entry: $${pos.entryPrice.toFixed(2)}  |  Exit: $${exitPrice.toFixed(2)}`);
    console.log(`  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} USDT`);
    console.log("  ══════════════════════════════════════════════════\n");

    if (!CONFIG.paperTrading) {
      try { await placeOrder("sell", pos.size, exitPrice); } catch (err) {
        console.error("  ❌ Exit order failed:", err.message);
      }
    }

    logTrade({
      timestamp: now.toISOString(),
      side: "CLOSE", sizeUsd: pos.size,
      entryPrice: pos.entryPrice, sl: pos.sl, tp: pos.tp,
      exitPrice, pnl, score: pos.score,
      notes: action === "EXIT_SL" ? "SL hit" : action === "EXIT_TP" ? "TP hit" : "Session end",
    });

    newState.position = null;
  }

  else {
    console.log(`  Status: WATCHING — ${notes || "waiting for Asia Low sweep setup"}`);
  }

  saveState(newState);
  console.log("\n  State saved. Next run: 15 min.\n");
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--status") {
  const s = loadState();
  console.log(JSON.stringify(s, null, 2));
} else {
  run().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
