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
import crypto from "crypto";
import { tgSignal, tgEntry, tgExit, tgError } from "../telegram.js";

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

const LOG_FILE  = "scalp-log.json";
const CSV_FILE  = "scalp-trades.csv";
const CSV_HEADERS = [
  "Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
  "Price","Total USD","Fee (est.)","Net Amount","Order ID","Mode","Notes",
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
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  let side = "", qty = "", total = "", fee = "", net = "", orderId = "", mode = "", notes = "";

  if (!entry.allPass) {
    const failed = entry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else if (entry.paperTrading) {
    side = entry.side; qty = (entry.tradeSize / entry.price).toFixed(6);
    total = entry.tradeSize.toFixed(2); fee = (entry.tradeSize * 0.001).toFixed(4);
    net = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || ""; mode = "PAPER"; notes = "5M Scalp";
  } else {
    side = entry.side; qty = (entry.tradeSize / entry.price).toFixed(6);
    total = entry.tradeSize.toFixed(2); fee = (entry.tradeSize * 0.001).toFixed(4);
    net = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || ""; mode = "LIVE";
    notes = entry.error ? `Error: ${entry.error}` : "5M Scalp";
  }

  const row = [date, time, "BitGet", entry.symbol, side, qty,
    entry.price.toFixed(4), total, fee, net, orderId, mode, `"${notes}"`].join(",");
  appendFileSync(CSV_FILE, row + "\n");
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

const SCALP_LEVERAGE = 20;

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

// ─── Tax Summary ─────────────────────────────────────────────────────────────

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No scalp-trades.csv yet."); return; }
  const rows  = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live  = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const vol   = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const fees  = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log(`\n── Scalp Tax Summary ────────────────────────────────────`);
  console.log(`  Live trades   : ${live.length}`);
  console.log(`  Paper trades  : ${paper.length}`);
  console.log(`  Blocked       : ${blocked.length}`);
  console.log(`  Total volume  : $${vol.toFixed(2)}`);
  console.log(`  Fees paid     : $${fees.toFixed(4)}\n`);
}

// ─── Exit Tracker ─────────────────────────────────────────────────────────────
async function checkOpenPositions(log) {
  const open = log.trades.filter(t => t.orderPlaced && !t.isClosed && t.sl != null && t.tp != null);
  if (open.length === 0) return;

  console.log(`── Exit check: ${open.length} open scalp position(s) ──────────`);
  for (const t of open) {
    const name = t.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    try {
      const candles = await fetchCandles(t.symbol, 3);
      const price   = candles[candles.length - 1].close;
      const isLong  = t.side === "LONG";

      let exitReason = null;
      let exitPrice  = null;
      if (isLong) {
        if (price <= t.sl)  { exitReason = "SL"; exitPrice = t.sl; }
        else if (price >= t.tp) { exitReason = "TP"; exitPrice = t.tp; }
      } else {
        if (price >= t.sl)  { exitReason = "SL"; exitPrice = t.sl; }
        else if (price <= t.tp) { exitReason = "TP"; exitPrice = t.tp; }
      }

      if (exitReason) {
        const pnl = isLong
          ? (exitPrice - t.price) / t.price * t.tradeSize * SCALP_LEVERAGE
          : (t.price - exitPrice) / t.price * t.tradeSize * SCALP_LEVERAGE;
        t.isClosed = true; t.exitPrice = exitPrice; t.exitReason = exitReason;
        t.exitTime = new Date().toISOString(); t.pnl = pnl;
        console.log(`  ${exitReason === "TP" ? "✅" : "❌"} ${name} ${t.side} → ${exitReason} @ $${exitPrice.toFixed(4)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
        await tgExit({ bot:"Scalper 5M", sym:t.symbol, reason:exitReason, entry:t.price, exitPrice, pnl, mode:t.paperTrading?"PAPER":"LIVE" });
      } else {
        const unrealPnl = isLong
          ? (price - t.price) / t.price * t.tradeSize * SCALP_LEVERAGE
          : (t.price - price) / t.price * t.tradeSize * SCALP_LEVERAGE;
        console.log(`  📊 ${name} ${t.side} open | $${price.toFixed(4)} | Unrealized: ${unrealPnl >= 0 ? "+" : ""}$${unrealPnl.toFixed(4)}`);
      }
    } catch (err) { console.log(`  ❌ Error checking ${name}: ${err.message}`); }
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();

  const rules = JSON.parse(readFileSync("rules-scalp.json", "utf8"));
  const watchlist = rules.watchlist || ["BYBIT:BTCUSDT.P"];
  const log = loadLog();
  await checkOpenPositions(log);
  saveLog(log);
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

    const alreadyOpen = log.trades.some(t => t.symbol === r.symbol && t.orderPlaced && !t.isClosed);
    if (alreadyOpen) { console.log(`  ⏭  ${r.symbol.replace(/^[^:]+:/,"").replace(/\.P$/,"")} already open`); continue; }

    const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

    const logEntry = {
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
      isClosed: false,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    console.log(`🎯 ${r.symbol} — ${r.side}`);
    console.log(`   Entry:     $${r.price.toFixed(4)}`);
    console.log(`   SL:        $${r.sl.toFixed(4)} (1× ATR)`);
    console.log(`   TP:        $${r.tp.toFixed(4)} (2× ATR)`);
    console.log(`   Margin:    $${tradeSize.toFixed(2)} @ ${SCALP_LEVERAGE}x = $${(tradeSize * SCALP_LEVERAGE).toFixed(2)} position`);

    await tgSignal({ bot:"Scalper 5M", sym:r.symbol, entry:r.price, sl:r.sl, tp:r.tp, riskPct:Math.abs(r.price-r.sl)/r.price, atr:r.atr, score:null, mode:CONFIG.paperTrading?"PAPER":"LIVE" });

    if (CONFIG.paperTrading) {
      console.log(`📋 PAPER — logged. Set PAPER_TRADING=false to go live.`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `SCALP-PAPER-${Date.now()}`;
      await tgEntry({ bot:"Scalper 5M", sym:r.symbol, orderId:logEntry.orderId, entry:r.price, sl:r.sl, tp:r.tp, mode:"PAPER" });
    } else {
      try {
        const order = await placeBitGetOrder(r.symbol, r.side === "LONG" ? "buy" : "sell", tradeSize, r.price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ LIVE ORDER — ${order.orderId}`);
        await tgEntry({ bot:"Scalper 5M", sym:r.symbol, orderId:order.orderId, entry:r.price, sl:r.sl, tp:r.tp, mode:"LIVE" });
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
        await tgError({ bot:"Scalper 5M", msg:`${r.symbol} order failed: ${err.message}` });
      }
    }

    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
  }

  // Log blocked/no-signal bars for audit
  for (const r of results.filter((r) => !r.allPass)) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol: r.symbol, timeframe: "5m", price: r.price,
      indicators: { ema9: r.ema9, stochK: r.stochK, rsi: r.rsi },
      conditions: r.conditions, allPass: false, tradeSize: 0,
      orderPlaced: false, paperTrading: CONFIG.paperTrading,
    };
    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
  }

  saveLog(log);
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
