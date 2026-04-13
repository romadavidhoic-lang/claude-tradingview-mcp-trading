/**
 * Antigravity Craig Bot — Range → Change → Execute
 *
 * Craig Percoco 3-Step ICT/SMC Strategy:
 *
 *  1. RANGE  (15m): Identify BOS (Break of Structure) — who's in control?
 *                   Detect 15m Fair Value Gaps (FVG) as draw-on-liquidity targets
 *
 *  2. CHANGE (1m):  Wait for CHoCH (Change of Character) on 1m
 *                   A strong candle that ejects prevailing players + forms a 1m FVG
 *
 *  3. EXECUTE: Entry = mid of 1m FVG
 *              SL    = just outside liquidity inflection level
 *              TP1   = 1:4 R:R
 *              TP2   = mid of 15m FVG (can reach 1:8)
 *              Move SL to BE when price confirms direction
 *
 * Run locally:  node craig-bot.js
 * Cloud:        Railway cron — every 1 minute (* * * * *)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Safety net — force exit after 2 minutes so cron never hangs
setTimeout(() => {
  console.log("⏱ Max runtime (2 min) — force exit");
  process.exit(0);
}, 2 * 60 * 1000).unref();

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  maxTradeSizeUSD: parseFloat(process.env.CRAIG_MAX_TRADE_USD  || "10"),
  maxTradesPerDay: parseInt( process.env.CRAIG_MAX_TRADES_DAY  || "5"),
  leverage:        parseInt( process.env.CRAIG_LEVERAGE         || "10"),
  rrTarget:        parseFloat(process.env.CRAIG_RR_TARGET       || "4"),   // initial 1:4
  cooldownMin:     parseInt( process.env.CRAIG_COOLDOWN_MIN     || "30"),  // min between trades per symbol
  paperTrading:    process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = join(__dirname, "craig-log.json");
const CSV_FILE = join(__dirname, "craig-trades.csv");
const CSV_HEADERS = [
  "Date","Time (UTC)","Exchange","Symbol","Side","Qty",
  "Entry","SL","TP1 (1:4)","TP2 (15m FVG)","Order ID","Mode","Notes",
].join(",");

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function wasRecentlyTraded(log, symbol) {
  const cutoff = Date.now() - CONFIG.cooldownMin * 60 * 1000;
  return log.trades.some(
    (t) => t.symbol === symbol && t.orderPlaced && new Date(t.timestamp).getTime() > cutoff,
  );
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  const qty  = entry.orderPlaced
    ? (entry.tradeSize * CONFIG.leverage / entry.entry).toFixed(6)
    : "";
  const mode = !entry.orderPlaced ? "BLOCKED" : entry.paperTrading ? "PAPER" : "LIVE";
  const notes = entry.orderPlaced
    ? `BOS:${entry.bosDirection} CHoCH:${entry.chochDirection} 15mFVG:${entry.fvg15mMid ? entry.fvg15mMid.toFixed(4) : "none"}`
    : entry.reason || "no signal";

  const row = [
    date, time, "BitGet", entry.symbol, entry.side || "", qty,
    entry.entry ? entry.entry.toFixed(4) : "",
    entry.sl    ? entry.sl.toFixed(4)   : "",
    entry.tp1   ? entry.tp1.toFixed(4)  : "",
    entry.tp2   ? entry.tp2.toFixed(4)  : "",
    entry.orderId || "", mode, `"${notes}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "15m", limit = 200) {
  const sym     = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  const okxSym  = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");
  const itvMap  = { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m",
                    "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };
  const bar     = itvMap[interval] || "15m";

  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${bar}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OKX ${okxSym}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX ${okxSym}: ${data.msg}`);

  // OKX returns newest first — reverse to chronological
  return data.data.reverse().map((k) => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Swing Point Detection ────────────────────────────────────────────────────

/**
 * Finds swing highs and lows.
 * A swing high = highest in [i-lookback .. i+lookback] window.
 * Only scans candles that have full lookback on both sides.
 */
function findSwingPoints(candles, lookback = 3) {
  const swingHighs = [];
  const swingLows  = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) swingHighs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow)  swingLows.push({ index: i, price: candles[i].low,  time: candles[i].time });
  }

  return { swingHighs, swingLows };
}

// ─── Step 1: BOS on 15m ──────────────────────────────────────────────────────

/**
 * Detects Break of Structure (BOS) on 15m.
 * BULL: Higher Highs + Higher Lows forming
 * BEAR: Lower Highs + Lower Lows forming
 * Returns bosDirection ("BULL" | "BEAR" | null) and swing point data.
 */
function detectBOS(candles15m) {
  const { swingHighs, swingLows } = findSwingPoints(candles15m, 5);

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { bosDirection: null, reason: "Not enough 15m swing points" };
  }

  const highs = swingHighs.slice(-3);
  const lows  = swingLows.slice(-3);

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow  = lows[lows.length - 1];
  const prevLow  = lows[lows.length - 2];

  let bullScore = 0, bearScore = 0;
  if (lastHigh.price > prevHigh.price) bullScore++; // Higher High
  if (lastLow.price  > prevLow.price)  bullScore++; // Higher Low
  if (lastHigh.price < prevHigh.price) bearScore++; // Lower High
  if (lastLow.price  < prevLow.price)  bearScore++; // Lower Low

  let bosDirection = null;
  if      (bullScore >= 2) bosDirection = "BULL";
  else if (bearScore >= 2) bosDirection = "BEAR";
  else if (bullScore > bearScore) bosDirection = "BULL";
  else if (bearScore > bullScore) bosDirection = "BEAR";

  return {
    bosDirection,
    bullScore,
    bearScore,
    lastHigh,
    prevHigh,
    lastLow,
    prevLow,
  };
}

// ─── Fair Value Gap Detection ─────────────────────────────────────────────────

/**
 * Finds Fair Value Gaps (FVGs) in candle array.
 *
 * Bullish FVG: candle[i-2].high < candle[i].low
 *   → gap between wick-top of first candle and wick-bottom of third candle
 *
 * Bearish FVG: candle[i-2].low > candle[i].high
 *   → gap between wick-bottom of first and wick-top of third
 *
 * @param {Array}  candles
 * @param {string} direction "BULL" | "BEAR"
 * @param {number} maxAge    how many bars back to scan
 */
function findFVGs(candles, direction, maxAge = 50) {
  const fvgs  = [];
  const start = Math.max(2, candles.length - maxAge);

  for (let i = start; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    if (direction === "BULL" && c1.high < c3.low) {
      fvgs.push({
        type:   "BULL",
        top:    c3.low,
        bottom: c1.high,
        mid:    (c1.high + c3.low) / 2,
        index:  i,
        time:   candles[i - 1].time,
      });
    } else if (direction === "BEAR" && c1.low > c3.high) {
      fvgs.push({
        type:   "BEAR",
        top:    c1.low,
        bottom: c3.high,
        mid:    (c1.low + c3.high) / 2,
        index:  i,
        time:   candles[i - 1].time,
      });
    }
  }

  return fvgs;
}

// ─── Step 2: CHoCH on 1m ─────────────────────────────────────────────────────

/**
 * Detects Change of Character (CHoCH) on 1m.
 *
 * For BULL 15m trend:
 *   A strong bullish 1m candle that closes ABOVE the last 1m swing high
 *   → buyers eject sellers, resuming the 15m uptrend after a pullback
 *
 * For BEAR 15m trend:
 *   A strong bearish 1m candle that closes BELOW the last 1m swing low
 *   → sellers eject buyers, resuming the 15m downtrend after a bounce
 *
 * "Strong" = body ≥ 50% of total candle range
 *
 * Returns CHoCH object or null.
 */
function detectCHoCH(candles1m, trendDirection) {
  const n = candles1m.length;
  if (n < 15) return null;

  // Use a recent window to find swing points (avoid looking too far back)
  const recentWindow = candles1m.slice(-40);
  const { swingHighs, swingLows } = findSwingPoints(recentWindow, 3);

  if (!swingHighs.length || !swingLows.length) return null;

  const lastCandle = candles1m[n - 1];
  const bodySize   = Math.abs(lastCandle.close - lastCandle.open);
  const totalSize  = lastCandle.high - lastCandle.low || 1e-9;
  const isStrong   = bodySize / totalSize >= 0.5;

  const recentSwingHigh = swingHighs[swingHighs.length - 1];
  const recentSwingLow  = swingLows[swingLows.length - 1];

  if (trendDirection === "BULL") {
    // Bullish CHoCH: strong bull candle breaks above last 1m swing high
    if (
      lastCandle.close > lastCandle.open &&
      lastCandle.close > recentSwingHigh.price &&
      isStrong
    ) {
      return {
        direction:      "BULL",
        level:          recentSwingHigh.price,   // broken level
        liquidityLevel: recentSwingLow.price,    // SL anchor (last swing low)
        candle:         lastCandle,
      };
    }
  } else if (trendDirection === "BEAR") {
    // Bearish CHoCH: strong bear candle breaks below last 1m swing low
    if (
      lastCandle.close < lastCandle.open &&
      lastCandle.close < recentSwingLow.price &&
      isStrong
    ) {
      return {
        direction:      "BEAR",
        level:          recentSwingLow.price,    // broken level
        liquidityLevel: recentSwingHigh.price,   // SL anchor (last swing high)
        candle:         lastCandle,
      };
    }
  }

  return null;
}

// ─── Main Signal Function ─────────────────────────────────────────────────────

async function getSignal(symbol) {
  // ── Step 1: 15m BOS + FVG ──────────────────────────────────────────────────
  const candles15m = await fetchCandles(symbol, "15m", 150);
  const bos        = detectBOS(candles15m);

  if (!bos.bosDirection) {
    return { signal: false, reason: `No clear 15m BOS (${bos.reason || "mixed"})`, symbol };
  }

  const fvgs15m     = findFVGs(candles15m, bos.bosDirection, 60);
  const latestFVG15 = fvgs15m.length ? fvgs15m[fvgs15m.length - 1] : null;

  // ── Step 2: 1m CHoCH + FVG ────────────────────────────────────────────────
  const candles1m = await fetchCandles(symbol, "1m", 100);
  const choch     = detectCHoCH(candles1m, bos.bosDirection);

  if (!choch) {
    return {
      signal:       false,
      reason:       `No 1m CHoCH yet (BOS: ${bos.bosDirection})`,
      symbol,
      bosDirection: bos.bosDirection,
      latestFVG15,
    };
  }

  // Find 1m FVG formed at/near the CHoCH (look at last 8 candles)
  const fvgs1m = findFVGs(candles1m.slice(-10), choch.direction, 8);
  const fvg1m  = fvgs1m.length ? fvgs1m[fvgs1m.length - 1] : null;

  if (!fvg1m) {
    return {
      signal:       false,
      reason:       `CHoCH confirmed but no 1m FVG near it`,
      symbol,
      bosDirection: bos.bosDirection,
      choch,
      latestFVG15,
    };
  }

  // ── Step 3: Calculate levels ───────────────────────────────────────────────
  const currentPrice = candles1m[candles1m.length - 1].close;

  // Entry = mid of 1m FVG
  // SL    = small buffer outside the liquidity inflection level
  // TP1   = 1:4 R:R (Craig's initial target)
  // TP2   = mid of 15m FVG (or 1:8 fallback)

  const buffer = currentPrice * 0.0005; // 0.05% buffer outside SL
  let entry, sl, tp1, tp2;

  if (choch.direction === "BULL") {
    entry = fvg1m.mid;
    sl    = choch.liquidityLevel - buffer;
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return { signal: false, reason: "Zero risk — invalid levels", symbol };
    tp1 = entry + CONFIG.rrTarget * risk;
    tp2 = latestFVG15 ? latestFVG15.mid : entry + 8 * risk;
  } else {
    entry = fvg1m.mid;
    sl    = choch.liquidityLevel + buffer;
    const risk = Math.abs(sl - entry);
    if (risk <= 0) return { signal: false, reason: "Zero risk — invalid levels", symbol };
    tp1 = entry - CONFIG.rrTarget * risk;
    tp2 = latestFVG15 ? latestFVG15.mid : entry - 8 * risk;
  }

  const risk = Math.abs(entry - sl);

  // Sanity check: risk at least 0.05%
  if (risk < currentPrice * 0.0005) {
    return { signal: false, reason: `SL too tight (${(risk / currentPrice * 100).toFixed(4)}%)`, symbol };
  }

  const rrActual = Math.abs(tp1 - entry) / risk;

  return {
    signal: true,
    symbol,
    side:           choch.direction === "BULL" ? "LONG" : "SHORT",
    currentPrice,
    entry,
    sl,
    tp1,
    tp2,
    risk,
    rrActual,
    bosDirection:   bos.bosDirection,
    bosScore:       `${bos.bullScore}:${bos.bearScore}`,
    chochDirection: choch.direction,
    fvg1m,
    latestFVG15,
  };
}

// ─── BitGet Execution ─────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, bodyObj = null) {
  const timestamp = Date.now().toString();
  const bodyStr   = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig       = signBitGet(timestamp, method, path, bodyStr);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type":       "application/json",
      "ACCESS-KEY":         CONFIG.bitget.apiKey,
      "ACCESS-SIGN":        sig,
      "ACCESS-TIMESTAMP":   timestamp,
      "ACCESS-PASSPHRASE":  CONFIG.bitget.passphrase,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet: ${data.msg}`);
  return data.data;
}

async function setLeverage(symbol, leverage) {
  const sym = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {
    symbol: sym, productType: "USDT-FUTURES", marginCoin: "USDT",
    leverage: String(leverage), holdSide: "long_short",
  });
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const sym = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  await setLeverage(symbol, CONFIG.leverage);
  const quantity = (sizeUSD * CONFIG.leverage / price).toFixed(4);
  return await bitgetRequest("POST", "/api/v2/mix/order/placeOrder", {
    symbol: sym, productType: "USDT-FUTURES", marginMode: "isolated",
    marginCoin: "USDT",
    side:      side === "LONG" ? "open_long"  : "open_short",
    orderType: "market", size: quantity,
    tradeSide: side === "LONG" ? "long"       : "short",
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();

  const rulesPath = join(__dirname, "rules-craig.json");
  const rules     = JSON.parse(readFileSync(rulesPath, "utf8"));
  const watchlist = rules.watchlist || ["BYBIT:BTCUSDT.P"];
  const log       = loadLog();
  const todayCount = countTodaysTrades(log);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Antigravity — Craig Bot (Range → Change → Execute)");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Strategy: ICT/SMC — 15m BOS + FVG → 1m CHoCH + FVG → Entry`);
  console.log(`RR: 1:${CONFIG.rrTarget} initial | TP2 = 15m FVG mid | Leverage: ${CONFIG.leverage}x`);
  console.log(`Scanning ${watchlist.length} assets | Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}\n`);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily limit reached (${CONFIG.maxTradesPerDay}). Done.\n`);
    return;
  }

  const signals = [];

  for (const symbol of watchlist) {
    const name = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    process.stdout.write(`  ${name.padEnd(12)}`);

    try {
      const result = await getSignal(symbol);

      if (result.signal) {
        console.log(
          `✅ SIGNAL ${result.side} | BOS:${result.bosDirection}(${result.bosScore}) | ` +
          `CHoCH:${result.chochDirection} | R:R 1:${result.rrActual.toFixed(1)} | ` +
          `Entry:$${result.entry.toFixed(4)} SL:$${result.sl.toFixed(4)}`,
        );
        signals.push(result);
      } else {
        const fvgInfo = result.latestFVG15 ? ` | 15mFVG:$${result.latestFVG15.mid.toFixed(2)}` : "";
        console.log(`—  ${result.reason}${fvgInfo}`);
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  console.log();

  if (signals.length === 0) {
    console.log("  No signals this scan. Waiting for BOS → CHoCH alignment.\n");
    return;
  }

  console.log(`\n  ${signals.length} SIGNAL(S) FOUND`);
  console.log("═══════════════════════════════════════════════════════════\n");

  for (const r of signals) {
    if (todayCount >= CONFIG.maxTradesPerDay) {
      console.log(`🚫 Daily limit — skipping ${r.symbol}`);
      break;
    }

    if (wasRecentlyTraded(log, r.symbol)) {
      console.log(`⏭  ${r.symbol} — cooldown active (${CONFIG.cooldownMin}min). Skipping.`);
      continue;
    }

    console.log(`🎯 ${r.symbol} — ${r.side}`);
    console.log(`   15m BOS      : ${r.bosDirection} (bull:bear = ${r.bosScore})`);
    console.log(`   1m CHoCH     : ${r.chochDirection}`);
    console.log(`   1m FVG       : $${r.fvg1m.bottom.toFixed(4)} — $${r.fvg1m.top.toFixed(4)}`);
    console.log(`   Entry        : $${r.entry.toFixed(4)}  (mid of 1m FVG)`);
    console.log(`   SL           : $${r.sl.toFixed(4)}  (outside liquidity)`);
    console.log(`   TP1 (1:${CONFIG.rrTarget})   : $${r.tp1.toFixed(4)}`);
    console.log(`   TP2 (15m FVG): ${r.tp2 ? "$" + r.tp2.toFixed(4) : "N/A"}`);
    console.log(`   Risk         : ${(r.risk / r.currentPrice * 100).toFixed(3)}%`);

    const logEntry = {
      timestamp:      new Date().toISOString(),
      symbol:         r.symbol,
      side:           r.side,
      price:          r.currentPrice,
      entry:          r.entry,
      sl:             r.sl,
      tp1:            r.tp1,
      tp2:            r.tp2,
      bosDirection:   r.bosDirection,
      chochDirection: r.chochDirection,
      fvg1mBottom:    r.fvg1m.bottom,
      fvg1mTop:       r.fvg1m.top,
      fvg15mMid:      r.latestFVG15?.mid ?? null,
      tradeSize:      CONFIG.maxTradeSizeUSD,
      orderPlaced:    false,
      orderId:        null,
      paperTrading:   CONFIG.paperTrading,
    };

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — logged. Set PAPER_TRADING=false to go live.`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `CRAIG-PAPER-${Date.now()}`;
    } else {
      try {
        const order = await placeBitGetOrder(r.symbol, r.side, CONFIG.maxTradeSizeUSD, r.currentPrice);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`\n✅ LIVE ORDER — ${order.orderId}`);
      } catch (err) {
        console.log(`\n❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
    console.log();
  }

  saveLog(log);
  console.log(`Craig log → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch((err) => {
  console.error("Craig bot error:", err.message);
  process.exit(1);
});
