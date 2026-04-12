/**
 * Antigravity Scalping Bot — 5M Strategy
 *
 * EMA 9/21 crossover + VWAP session bias + Stoch RSI timing + ATR exits
 * Scans all 7 watchlist assets on the 5-minute timeframe.
 * SL: 1× ATR | TP: 2× ATR (1:2 R:R)
 *
 * Run locally:  node bot-scalp.js
 * Cloud:        Railway triggers every 5 minutes via cron
 * Tax summary:  node bot-scalp.js --tax-summary
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  portfolioValue:  parseFloat(process.env.SCALP_PORTFOLIO_USD   || "50"),
  maxTradeSizeUSD: parseFloat(process.env.SCALP_MAX_TRADE_USD   || "10"),
  maxTradesPerDay: parseInt(  process.env.SCALP_MAX_TRADES_DAY  || "30"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const SCALP_LEVERAGE = 20;

const LOG_FILE  = "scalp-log.json";
const CSV_FILE  = "scalp-trades.csv";
const CSV_HEADERS = [
  "Trade ID","Date","Time (UTC)","Exchange","Symbol","Side","Leverage",
  "Margin USD","Position USD","Entry Price","SL","TP",
  "Status","Exit Price","Exit Time (UTC)","PnL USD","PnL %",
  "Mode","Notes",
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

function initCsv() {
  writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

/** Rebuild the entire CSV from the JSON log (only real/paper trades, no blocked scans). */
function rebuildCsv(log) {
  const lines = [CSV_HEADERS];
  for (const t of log.trades) {
    if (!t.allPass) continue; // skip blocked scans — not real trades
    const entryDate = new Date(t.timestamp);
    const date = entryDate.toISOString().slice(0, 10);
    const time = entryDate.toISOString().slice(11, 19);
    const mode = t.paperTrading ? "PAPER" : "LIVE";
    const margin = (t.tradeSize || 0).toFixed(2);
    const position = ((t.tradeSize || 0) * SCALP_LEVERAGE).toFixed(2);
    const entry = (t.price || 0).toFixed(4);
    const sl = t.sl ? t.sl.toFixed(4) : "";
    const tp = t.tp ? t.tp.toFixed(4) : "";
    const status = t.status || "OPEN";
    const exitPrice = t.exitPrice ? t.exitPrice.toFixed(4) : "";
    const exitTime = t.exitTime ? new Date(t.exitTime).toISOString().slice(11, 19) : "";
    const pnlUSD = t.pnlUSD !== undefined ? t.pnlUSD.toFixed(4) : "";
    const pnlPct = t.pnlPct !== undefined ? t.pnlPct.toFixed(2) + "%" : "";
    const notes = t.error ? `Error: ${t.error}` : "5M Scalp";
    const row = [
      t.tradeId || "", date, time, "BitGet", t.symbol, t.side || "", SCALP_LEVERAGE,
      margin, position, entry, sl, tp,
      status, exitPrice, exitTime, pnlUSD, pnlPct,
      mode, `"${notes}"`,
    ].join(",");
    lines.push(row);
  }
  writeFileSync(CSV_FILE, lines.join("\n") + "\n");
}

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, limit = 300) {
  const sym = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  // OKX format: BTCUSDT → BTC-USDT
  const okxSym = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");

  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=5m&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX ${okxSym}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX ${okxSym}: ${data.msg}`);

  // OKX returns newest first — reverse to chronological order
  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaArr(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function ema(arr, period) {
  const a = emaArr(arr, period);
  return a[a.length - 1] ?? arr[arr.length - 1];
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

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3) {
  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    rsiSeries.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  }
  if (rsiSeries.length < stochPeriod) return { k: 50 };
  const window = rsiSeries.slice(-stochPeriod);
  const lo = Math.min(...window), hi = Math.max(...window);
  const raw = hi === lo ? 0 : ((rsiSeries[rsiSeries.length - 1] - lo) / (hi - lo)) * 100;
  return { k: raw };
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
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (!session.length) return candles[candles.length - 1].close;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? candles[candles.length - 1].close : tpv / vol;
}

// ─── Signal Logic ─────────────────────────────────────────────────────────────

function getScalpSignal(candles) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;

  const ema9Arr  = emaArr(closes, 9);
  const ema21Arr = emaArr(closes, 21);

  const ema9Now   = ema9Arr[n - 1];
  const ema21Now  = ema21Arr[n - 1];
  const ema9Prev  = ema9Arr[n - 2];
  const ema21Prev = ema21Arr[n - 2];
  const ema200    = ema(closes, 200);

  const crossUp   = ema9Prev <= ema21Prev && ema9Now > ema21Now;
  const crossDown = ema9Prev >= ema21Prev && ema9Now < ema21Now;

  const price   = closes[n - 1];
  const vwap    = calcVWAP(candles);
  const rsi     = calcRSI(closes, 14);
  const { k: stochK } = calcStochRSI(closes, 14, 14, 3);
  const atr     = calcATR(candles, 14);

  const conditions = [];
  let allPass = false;
  let side = null;

  const check = (label, required, actual, pass) => {
    conditions.push({ label, required, actual: String(actual), pass });
  };

  if (crossUp) {
    side = "LONG";
    check("EMA 9 crosses above EMA 21",    "crossover ↑",      `${ema9Now.toFixed(4)} > ${ema21Now.toFixed(4)}`, true);
    check("Price above VWAP",              `> ${vwap.toFixed(4)}`,  price.toFixed(4),    price > vwap);
    check("Stoch RSI K < 20 (oversold)",   "< 20",             stochK.toFixed(1),         stochK < 20);
    check("RSI(14) < 65 (not overbought)", "< 65",             rsi.toFixed(1),            rsi < 65);
    check("Price above EMA 200",           `> ${ema200.toFixed(4)}`, price.toFixed(4),   price > ema200);
    allPass = conditions.every((c) => c.pass);
  } else if (crossDown) {
    side = "SHORT";
    check("EMA 9 crosses below EMA 21",    "crossunder ↓",     `${ema9Now.toFixed(4)} < ${ema21Now.toFixed(4)}`, true);
    check("Price below VWAP",              `< ${vwap.toFixed(4)}`,  price.toFixed(4),    price < vwap);
    check("Stoch RSI K > 80 (overbought)", "> 80",             stochK.toFixed(1),         stochK > 80);
    check("RSI(14) > 40 (not oversold)",   "> 40",             rsi.toFixed(1),            rsi > 40);
    check("Price below EMA 200",           `< ${ema200.toFixed(4)}`, price.toFixed(4),   price < ema200);
    allPass = conditions.every((c) => c.pass);
  } else {
    check(
      ema9Now > ema21Now ? "EMA 9 above EMA 21 (no fresh cross)" : "EMA 9 below EMA 21 (no fresh cross)",
      "Need fresh EMA crossover this bar",
      `EMA9=${ema9Now.toFixed(4)} EMA21=${ema21Now.toFixed(4)}`,
      false,
    );
    allPass = false;
  }

  return {
    price, vwap, rsi, stochK, atr, ema200,
    ema9: ema9Now, ema21: ema21Now,
    side, allPass, conditions,
    sl: side === "LONG" ? price - atr : price + atr,
    tp: side === "LONG" ? price + 2 * atr : price - 2 * atr,
  };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, bodyObj = null) {
  const timestamp = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig = signBitGet(timestamp, method, path, bodyStr);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
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
  await setLeverage(symbol, SCALP_LEVERAGE);

  const quantity = (sizeUSD * SCALP_LEVERAGE / price).toFixed(4);
  return await bitgetRequest("POST", "/api/v2/mix/order/placeOrder", {
    symbol: sym,
    productType: "USDT-FUTURES",
    marginMode: "isolated",
    marginCoin: "USDT",
    side: side.toLowerCase() === "buy" ? "open_long" : "open_short",
    orderType: "market",
    size: quantity,
    tradeSide: side.toLowerCase() === "buy" ? "long" : "short",
  });
}

// ─── Outcome Tracking ────────────────────────────────────────────────────────

/**
 * For each OPEN trade in the log, fetch recent 5m candles and check if
 * SL or TP has been hit since entry. Updates the log entry in place.
 * Returns true if any trade was updated.
 */
async function checkOpenTrades(log) {
  const openTrades = log.trades.filter((t) => t.allPass && t.status === "OPEN");
  if (openTrades.length === 0) return false;

  console.log(`\n  Checking ${openTrades.length} open trade(s) for SL/TP outcome...`);
  let anyUpdated = false;

  for (const trade of openTrades) {
    try {
      const candles = await fetchCandles(trade.symbol, 300);
      const entryTime = new Date(trade.timestamp).getTime();

      // Only look at candles that closed AFTER our entry
      const afterEntry = candles.filter((c) => c.time > entryTime);
      if (afterEntry.length === 0) {
        console.log(`    ${trade.symbol}: still in entry candle, checking next run`);
        continue;
      }

      let hitSL = null, hitTP = null;

      for (const candle of afterEntry) {
        const candleTime = candle.time;
        if (trade.side === "LONG") {
          // SL hit: low touches or breaks SL level
          if (!hitSL && candle.low <= trade.sl) hitSL = { time: candleTime, price: trade.sl };
          // TP hit: high touches or breaks TP level
          if (!hitTP && candle.high >= trade.tp) hitTP = { time: candleTime, price: trade.tp };
        } else { // SHORT
          // SL hit: high touches or breaks SL level
          if (!hitSL && candle.high >= trade.sl) hitSL = { time: candleTime, price: trade.sl };
          // TP hit: low touches or breaks TP level
          if (!hitTP && candle.low <= trade.tp) hitTP = { time: candleTime, price: trade.tp };
        }
        if (hitSL && hitTP) break; // found both, whichever came first determines outcome
      }

      if (!hitSL && !hitTP) {
        console.log(`    ${trade.symbol} ${trade.side}: still OPEN — SL/TP not yet reached`);
        continue;
      }

      // Determine which came first
      let outcome, exitPrice, exitTime;
      if (hitSL && hitTP) {
        // Both in same candle — conservative: assume SL hit first
        const slFirst = hitSL.time <= hitTP.time;
        outcome  = slFirst ? "LOSS" : "WIN";
        exitPrice = slFirst ? hitSL.price : hitTP.price;
        exitTime  = slFirst ? hitSL.time  : hitTP.time;
      } else if (hitSL) {
        outcome = "LOSS"; exitPrice = hitSL.price; exitTime = hitSL.time;
      } else {
        outcome = "WIN";  exitPrice = hitTP.price; exitTime = hitTP.time;
      }

      // PnL: based on position size (margin × leverage)
      const position = trade.tradeSize * SCALP_LEVERAGE;
      const priceDiff = trade.side === "LONG"
        ? exitPrice - trade.price
        : trade.price - exitPrice;
      const pnlUSD = (priceDiff / trade.price) * position;
      const pnlPct = (pnlUSD / trade.tradeSize) * 100; // % of margin

      trade.status    = outcome;
      trade.exitPrice = exitPrice;
      trade.exitTime  = exitTime;
      trade.pnlUSD    = pnlUSD;
      trade.pnlPct    = pnlPct;
      anyUpdated = true;

      const icon = outcome === "WIN" ? "✅" : "❌";
      console.log(
        `    ${icon} ${trade.symbol} ${trade.side}: ${outcome}  ` +
        `exit $${exitPrice.toFixed(4)}  PnL: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)} ` +
        `(${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`
      );
    } catch (err) {
      console.log(`    ${trade.symbol}: outcome check failed — ${err.message}`);
    }
  }

  return anyUpdated;
}

// ─── Tax Summary ─────────────────────────────────────────────────────────────

function generateTaxSummary() {
  const log = loadLog();
  const trades = log.trades.filter((t) => t.allPass);
  const live  = trades.filter((t) => !t.paperTrading);
  const paper = trades.filter((t) => t.paperTrading);
  const wins  = trades.filter((t) => t.status === "WIN");
  const losses = trades.filter((t) => t.status === "LOSS");
  const open  = trades.filter((t) => t.status === "OPEN");
  const totalPnl = trades.reduce((s, t) => s + (t.pnlUSD || 0), 0);
  const winRate = trades.filter((t) => t.status !== "OPEN").length > 0
    ? (wins.length / (wins.length + losses.length) * 100).toFixed(1)
    : "N/A";
  console.log(`\n── Scalp Tax Summary ────────────────────────────────────`);
  console.log(`  Total trades  : ${trades.length} (${live.length} live, ${paper.length} paper)`);
  console.log(`  Open          : ${open.length}`);
  console.log(`  Wins          : ${wins.length}  Losses: ${losses.length}  Win rate: ${winRate}%`);
  console.log(`  Total PnL     : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(4)}`);
  console.log(`  Fees (est.)   : $${(live.reduce((s,t)=>s+(t.tradeSize||0),0)*0.001).toFixed(4)}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const rules = JSON.parse(readFileSync(join(__dirname, "rules-scalp.json"), "utf8"));
  const watchlist = rules.watchlist || ["BYBIT:BTCUSDT.P"];
  const log = loadLog();

  // ── Step 1: resolve outcomes for any open trades ──────────────────────────
  const anyResolved = await checkOpenTrades(log);
  if (anyResolved) {
    saveLog(log);
    rebuildCsv(log);
  }

  const todayCount = countTodaysTrades(log);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Antigravity — 5M Scalping Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\nStrategy: EMA 9/21 + VWAP + Stoch RSI | 5M | 1:2 R:R`);
  console.log(`Scanning: ${watchlist.length} assets`);
  console.log(`Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}\n`);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily limit reached (${CONFIG.maxTradesPerDay} scalp trades). Done.\n`);
    return;
  }

  const results = [];

  for (const symbol of watchlist) {
    const name = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    process.stdout.write(`  ${name.padEnd(10)}`);
    try {
      const candles = await fetchCandles(symbol, 300);
      const sig = getScalpSignal(candles);
      results.push({ symbol, ...sig });
      console.log(
        `  EMA9:${sig.ema9.toFixed(2).padStart(10)}  ` +
        `StochK:${sig.stochK.toFixed(0).padStart(4)}  ` +
        `$${sig.price.toFixed(4)}  ` +
        (sig.allPass ? `✅ ${sig.side}` : sig.side ? `⚠️  cross but conditions failed` : "—")
      );
    } catch (err) {
      console.log(`  ❌ ${err.message}`);
    }
  }

  const signals = results.filter((r) => r.allPass);

  if (signals.length === 0) {
    console.log("\n  No scalp signals this bar. Next scan in 5 minutes.\n");
  } else {
    console.log(`\n  ${signals.length} SIGNAL(S) FOUND\n`);
  }

  for (const r of signals) {
    if (todayCount >= CONFIG.maxTradesPerDay) break;

    const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

    const logEntry = {
      tradeId: `SCALP-${Date.now()}`,
      timestamp: new Date().toISOString(),
      symbol: r.symbol,
      timeframe: "5m",
      price: r.price,
      side: r.side,
      indicators: { ema9: r.ema9, ema21: r.ema21, stochK: r.stochK, rsi: r.rsi, vwap: r.vwap },
      conditions: r.conditions,
      allPass: true,
      tradeSize,
      sl: r.sl,
      tp: r.tp,
      status: "OPEN",
      exitPrice: null,
      exitTime: null,
      pnlUSD: null,
      pnlPct: null,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    console.log(`🎯 ${r.symbol} — ${r.side}`);
    console.log(`   Entry:     $${r.price.toFixed(4)}`);
    console.log(`   SL:        $${r.sl.toFixed(4)} (1× ATR)`);
    console.log(`   TP:        $${r.tp.toFixed(4)} (2× ATR)`);
    console.log(`   Margin:    $${tradeSize.toFixed(2)} @ ${SCALP_LEVERAGE}x = $${(tradeSize * SCALP_LEVERAGE).toFixed(2)} position`);

    if (CONFIG.paperTrading) {
      console.log(`📋 PAPER — logged. Set PAPER_TRADING=false to go live.`);
      logEntry.orderPlaced = true;
      logEntry.orderId = logEntry.tradeId;
    } else {
      try {
        const order = await placeBitGetOrder(r.symbol, r.side === "LONG" ? "buy" : "sell", tradeSize, r.price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ LIVE ORDER — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    log.trades.push(logEntry);
  }

  saveLog(log);
  rebuildCsv(log);
  console.log(`\nScalp log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Scalp bot error:", err.message);
    process.exit(1);
  });
}
