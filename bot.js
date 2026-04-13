/**
 * Antigravity Trading Bot — MCB v6 + TTC Confluence
 *
 * Scans all 7 watchlist assets on the daily timeframe.
 * Implements the full MCB WaveTrend + TTC 7-condition scoring strategy.
 * SL: 1.5× ATR | TP: 4.5× ATR | Max hold: 40 bars
 *
 * Run locally:  node bot.js
 * Cloud:        Railway triggers on cron (every 4h by default)
 * Tax summary:  node bot.js --tax-summary
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "180"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "50"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
  "Price","Total USD","Fee (est.)","Net Amount","Order ID","Mode","Notes",
].join(",");

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    if (process.env.RAILWAY_ENVIRONMENT) {
      console.error(`❌ Missing Railway Variables: ${missing.join(", ")} — set them in Railway dashboard.`);
      process.exit(1);
    }
    // Running locally without .env — try to open it for editing
    if (!existsSync(".env")) {
      console.log("\n⚠️  No .env file found — creating it for you...\n");
      writeFileSync(".env", [
        "BITGET_API_KEY=", "BITGET_SECRET_KEY=", "BITGET_PASSPHRASE=",
        "PORTFOLIO_VALUE_USD=180", "MAX_TRADE_SIZE_USD=50", "MAX_TRADES_PER_DAY=10",
        "PAPER_TRADING=true", "TRADE_MODE=futures",
      ].join("\n") + "\n");
      try { execSync("open .env"); } catch {}
    } else {
      try { execSync("open .env"); } catch {}
    }
    console.log(`Missing credentials: ${missing.join(", ")}`);
    console.log("Fill in your BitGet credentials and re-run.\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(`   Open in Google Sheets or Excel — or tell Claude to move it.\n`);
}

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
    const note = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
  }
}

function writeTradeCsv(entry) {
  const now = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  let side = "", qty = "", total = "", fee = "", net = "", orderId = "", mode = "", notes = "";

  if (!entry.allPass) {
    const failed = entry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else if (entry.paperTrading) {
    side = entry.side || "BUY";
    qty = (entry.tradeSize / entry.price).toFixed(6);
    total = entry.tradeSize.toFixed(2);
    fee = (entry.tradeSize * 0.001).toFixed(4);
    net = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    mode = "PAPER"; notes = `TTC ${entry.ttcScore || ""}`;
  } else {
    side = entry.side || "BUY";
    qty = (entry.tradeSize / entry.price).toFixed(6);
    total = entry.tradeSize.toFixed(2);
    fee = (entry.tradeSize * 0.001).toFixed(4);
    net = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    mode = "LIVE"; notes = entry.error ? `Error: ${entry.error}` : `TTC ${entry.ttcScore || ""}`;
  }

  const row = [date, time, "BitGet", entry.symbol, side, qty,
    entry.price.toFixed(4), total, fee, net, orderId, mode, `"${notes}"`].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`   Tax record saved → ${CSV_FILE}`);
}

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1d", limit = 300) {
  const sym = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
  // OKX format: BTCUSDT → BTC-USDT
  const okxSym = sym.replace(/^(\w+?)(USDT)$/, "$1-USDT");

  // OKX interval mapping
  const intervalMap = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
  const okxInterval = intervalMap[interval] || "1D";

  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${okxInterval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OKX ${okxSym}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX ${okxSym}: ${data.msg}`);

  // OKX returns newest first — reverse to chronological order
  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Library ────────────────────────────────────────────────────────

function ema(arr, period) {
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function emaArr(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function smaArr(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    out[i] = arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / period / (losses / period || 1e-9);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (!session.length) return candles[candles.length - 1].close;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? candles[candles.length - 1].close : tpv / vol;
}

function calcBB(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3) {
  // Build RSI series
  const rsiArr = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    rsiArr.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  }
  if (rsiArr.length < stochPeriod) return { k: 50, d: 50 };
  const window = rsiArr.slice(-stochPeriod);
  const minRSI = Math.min(...window);
  const maxRSI = Math.max(...window);
  const rawK = maxRSI === minRSI ? 0 : ((rsiArr[rsiArr.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
  return { k: rawK, d: rawK }; // simplified — D smoothing needs more history
}

function calcMFI(candles, period = 14) {
  const slice = candles.slice(-period - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const tp = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const prevTp = (slice[i - 1].high + slice[i - 1].low + slice[i - 1].close) / 3;
    const mf = tp * slice[i].volume;
    if (tp > prevTp) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

// ─── MCB WaveTrend ────────────────────────────────────────────────────────────
// Formula: esa=EMA(hlc3,9), de=EMA(|hlc3-esa|,9), ci=(hlc3-esa)/(0.015*de)
//          wt1=EMA(ci,12), wt2=SMA(wt1,3)

function calcWaveTrend(candles) {
  const hlc3 = candles.map((c) => (c.high + c.low + c.close) / 3);
  const esa = emaArr(hlc3, 9);
  const absDiff = hlc3.map((v, i) => (esa[i] === null ? null : Math.abs(v - esa[i])));
  const validStart = absDiff.findIndex((v) => v !== null);
  const de = emaArr(absDiff.map((v) => v ?? 0), 9);
  const ci = hlc3.map((v, i) => {
    if (esa[i] === null || de[i] === null || de[i] === 0) return 0;
    return (v - esa[i]) / (0.015 * de[i]);
  });
  const wt1 = emaArr(ci, 12);
  const wt2 = smaArr(wt1.map((v) => v ?? 0), 3);

  const last = candles.length - 1;
  const prev = candles.length - 2;

  return {
    wt1_now: wt1[last] ?? 0,
    wt2_now: wt2[last] ?? 0,
    wt1_prev: wt1[prev] ?? 0,
    wt2_prev: wt2[prev] ?? 0,
  };
}

// ─── TTC Scoring ──────────────────────────────────────────────────────────────

function calcTTC(candles) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  const bar = candles[n - 1];

  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const rsi = calcRSI(closes, 14);
  const { wt2_now: wt2 } = calcWaveTrend(candles);
  const { k: stochK } = calcStochRSI(closes);
  const mfi = calcMFI(candles, 14);
  const vwap = calcVWAP(candles);
  const bb = calcBB(closes, 20);

  let L = 0, S = 0;
  const conditions = [];

  const cond = (name, longVal, shortVal, longTest, shortTest) => {
    if (longTest)       { L++; conditions.push({ name, bias: "LONG",  value: longVal }); }
    else if (shortTest) { S++; conditions.push({ name, bias: "SHORT", value: shortVal }); }
    else                {      conditions.push({ name, bias: "—",     value: longVal }); }
  };

  cond("Trend EMA21/50", `${e21.toFixed(2)}>${e50.toFixed(2)}`, `${e21.toFixed(2)}<${e50.toFixed(2)}`, e21 > e50, e21 < e50);
  cond("RSI(14)",        rsi.toFixed(1), rsi.toFixed(1), rsi < 40, rsi > 65);
  cond("WaveTrend WT2",  wt2.toFixed(1), wt2.toFixed(1), wt2 < -53, wt2 > 53);
  cond("Stoch RSI K",    stochK.toFixed(1), stochK.toFixed(1), stochK < 20, stochK > 80);
  cond("MFI(14)",        mfi.toFixed(1), mfi.toFixed(1), mfi < 30, mfi > 70);
  cond("VWAP",           `${bar.close.toFixed(4)}>${vwap.toFixed(4)}`, `${bar.close.toFixed(4)}<${vwap.toFixed(4)}`, bar.close > vwap, bar.close < vwap);
  cond("BB",             `close<lower${bb.lower.toFixed(4)}`, `close>upper${bb.upper.toFixed(4)}`, bar.close < bb.lower, bar.close > bb.upper);

  return { L, S, conditions, rsi, wt2, stochK, mfi, vwap, bb, e21, e50 };
}

// ─── MCB Signal ───────────────────────────────────────────────────────────────
// Signal = WT2 crosses ±65 AND WT1 crosses WT2

function getMCBSignal(candles) {
  const { wt1_now, wt2_now, wt1_prev, wt2_prev } = calcWaveTrend(candles);

  const longSignal =
    wt2_now < -65 &&
    wt1_prev < wt2_prev &&
    wt1_now > wt2_now;  // bullish WT cross below -65

  const shortSignal =
    wt2_now > 65 &&
    wt1_prev > wt2_prev &&
    wt1_now < wt2_now;  // bearish WT cross above +65

  return { longSignal, shortSignal, wt1: wt1_now, wt2: wt2_now };
}

// ─── Per-Asset Safety Check ───────────────────────────────────────────────────

function runAssetCheck(symbol, candles, rules) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const atr = calcATR(candles);
  const e200 = ema(closes, 200);
  const MIN_TTC = rules.ttc_scoring?.minimum_score_to_trade ?? 2;

  const { longSignal, shortSignal, wt1, wt2 } = getMCBSignal(candles);
  const { L, S, conditions, rsi, stochK, mfi, vwap, bb, e21, e50 } = calcTTC(candles);

  const results = [];
  let side = null;
  let allPass = false;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual: String(actual), pass });
  };

  if (longSignal) {
    side = "LONG";
    check("WT2 crossed below −65 (exhaustion)", "< −65", wt2.toFixed(1), true);
    check("WT1 bullish cross above WT2", "WT1 > WT2", `${wt1.toFixed(1)} > ${wt2.toFixed(1)}`, true);
    check(`TTC Long score ≥ ${MIN_TTC}/7`, `≥ ${MIN_TTC}`, `${L}/7`, L >= MIN_TTC);
    check("Price above EMA200 (structure)", `> ${e200.toFixed(2)}`, price.toFixed(2), price > e200);
    allPass = L >= MIN_TTC; // EMA200 is preferred but not hard blocker on alts
  } else if (shortSignal) {
    side = "SHORT";
    check("WT2 crossed above +65 (exhaustion)", "> +65", wt2.toFixed(1), true);
    check("WT1 bearish cross below WT2", "WT1 < WT2", `${wt1.toFixed(1)} < ${wt2.toFixed(1)}`, true);
    check(`TTC Short score ≥ ${MIN_TTC}/7`, `≥ ${MIN_TTC}`, `${S}/7`, S >= MIN_TTC);
    allPass = S >= MIN_TTC;
  } else {
    // No signal — report current state for morning brief awareness
    const approaching = Math.abs(wt2) > 45;
    check(
      approaching
        ? `⚠️  WT2 approaching ±65 zone (${wt2.toFixed(1)})`
        : `WT2 in neutral zone (${wt2.toFixed(1)})`,
      "Need WT2 cross ±65 + WT1 cross",
      `WT2=${wt2.toFixed(1)} | WT1=${wt1.toFixed(1)}`,
      false,
    );
    allPass = false;
  }

  return {
    symbol, price, atr, wt1, wt2, e21, e50, e200,
    rsi, stochK, mfi, vwap, bb,
    ttcL: L, ttcS: S, conditions,
    side, allPass, results,
    slPrice: side === "LONG" ? price - 1.5 * atr : price + 1.5 * atr,
    tpPrice: side === "LONG" ? price + 4.5 * atr : price - 4.5 * atr,
  };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

// Dynamic leverage based on TTC score (swing strategy)
function getSwingLeverage(ttcScore) {
  if (ttcScore >= 5) return 10;
  if (ttcScore >= 4) return 7;
  if (ttcScore >= 3) return 5;
  return 3; // minimum at TTC 2/7
}

function signBitGet(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, bodyObj = null) {
  const timestamp = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const signature = signBitGet(timestamp, method, path, bodyStr);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
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
    symbol: sym,
    productType: "USDT-FUTURES",
    marginCoin: "USDT",
    leverage: String(leverage),
    holdSide: "long_short",
  });
}

async function placeBitGetOrder(symbol, side, sizeUSD, price, leverage = 10) {
  const sym = symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");

  // Set leverage first
  await setLeverage(symbol, leverage);

  // Futures: size = contracts (qty in base asset)
  const quantity = (sizeUSD * leverage / price).toFixed(4);
  const holdSide = side.toLowerCase() === "buy" ? "long" : "short";

  return await bitgetRequest("POST", "/api/v2/mix/order/placeOrder", {
    symbol: sym,
    productType: "USDT-FUTURES",
    marginMode: "isolated",
    marginCoin: "USDT",
    side: side.toLowerCase() === "buy" ? "open_long" : "open_short",
    orderType: "market",
    size: quantity,
    tradeSide: holdSide,
  });
}

// ─── Tax Summary ─────────────────────────────────────────────────────────────

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv yet."); return; }
  const rows = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const vol = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const fees = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log(`\n── Tax Summary ──────────────────────────────────────────`);
  console.log(`  Live trades   : ${live.length}`);
  console.log(`  Paper trades  : ${paper.length}`);
  console.log(`  Blocked       : ${blocked.length}`);
  console.log(`  Total volume  : $${vol.toFixed(2)}`);
  console.log(`  Fees paid     : $${fees.toFixed(4)}`);
  console.log(`  Full record   : ${CSV_FILE}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist || ["BYBIT:BTCUSDT.P"];
  const log = loadLog();
  const todayCount = countTodaysTrades(log);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Antigravity — MCB v6 + TTC Confluence Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\nStrategy: ${rules.strategy?.name || "MCB v6 + TTC"}`);
  console.log(`Scanning: ${watchlist.length} assets | Daily | OB/OS ±65 | TTC ≥ 2/7`);
  console.log(`Trade limits: ${todayCount}/${CONFIG.maxTradesPerDay} trades today\n`);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached (${CONFIG.maxTradesPerDay}). Done for today.\n`);
    return;
  }

  const results = [];

  for (const symbol of watchlist) {
    process.stdout.write(`  Fetching ${symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "").padEnd(10)}`);
    try {
      const candles = await fetchCandles(symbol, "1d", 300);
      const check = runAssetCheck(symbol, candles, rules);
      results.push(check);
      console.log(
        `  WT2:${check.wt2.toFixed(1).padStart(7)}  ` +
        `TTC L${check.ttcL}/S${check.ttcS}  ` +
        `$${check.price.toFixed(4)}  ` +
        (check.allPass ? `✅ SIGNAL: ${check.side}` : check.side ? `🔶 NEAR SIGNAL` : "—")
      );
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
    }
  }

  // ── Detailed report per asset ──────────────────────────────────────────────

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  DETAILED SCAN RESULTS");
  console.log("══════════════════════════════════════════════════════════\n");

  const signals = results.filter((r) => r.allPass);

  for (const r of results) {
    const name = r.symbol.replace(/^[^:]+:/, "").replace(/\.P$/, "");
    const trend = r.e21 > r.e50 ? "BULL" : "BEAR";
    const aboveEma200 = r.price > r.e200;

    console.log(`── ${name} — $${r.price.toFixed(4)} ──────────────────────────`);
    console.log(`   WT2: ${r.wt2.toFixed(1)}  |  TTC Long: ${r.ttcL}/7  Short: ${r.ttcS}/7`);
    console.log(`   RSI: ${r.rsi.toFixed(1)}  |  MFI: ${r.mfi.toFixed(1)}  |  StochK: ${r.stochK.toFixed(1)}`);
    console.log(`   EMA Trend: ${trend}  |  EMA200: ${aboveEma200 ? "ABOVE ✓" : "BELOW ✗"}`);
    console.log(`   ATR: ${r.atr.toFixed(4)}`);

    for (const c of r.results) {
      console.log(`   ${c.pass ? "✅" : "🚫"} ${c.label}`);
      if (!c.pass) console.log(`      Required: ${c.required} | Actual: ${c.actual}`);
    }

    if (r.allPass) {
      const ttcScore = r.side === "LONG" ? r.ttcL : r.ttcS;
      const conviction = ttcScore >= 4 ? "HIGH" : ttcScore >= 3 ? "MEDIUM" : "MINIMUM";
      console.log(`\n   🎯 SIGNAL: ${r.side} | TTC ${ttcScore}/7 (${conviction} conviction)`);
      console.log(`   SL: $${r.slPrice.toFixed(4)}  |  TP: $${r.tpPrice.toFixed(4)}`);
      console.log(`   R:R 1:3  |  Max hold: 40 bars`);
    }
    console.log();
  }

  // ── Execute signals ────────────────────────────────────────────────────────

  if (signals.length === 0) {
    console.log("══════════════════════════════════════════════════════════");
    console.log("  No signals today. Waiting for WT2 to cross ±65.");
    console.log("  Next scan in 4 hours.");
    console.log("══════════════════════════════════════════════════════════\n");
  } else {
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  ${signals.length} SIGNAL(S) FOUND`);
    console.log("══════════════════════════════════════════════════════════\n");

    for (const r of signals) {
      if (todayCount >= CONFIG.maxTradesPerDay) {
        console.log(`🚫 Daily trade limit reached — skipping ${r.symbol}`);
        continue;
      }

      const tradeSize = Math.min(CONFIG.portfolioValue * 0.02, CONFIG.maxTradeSizeUSD);
      const ttcScore = r.side === "LONG" ? r.ttcL : r.ttcS;
      const adjustedSize = ttcScore === 2 ? tradeSize * 0.5 : tradeSize; // half size at minimum TTC

      const logEntry = {
        timestamp: new Date().toISOString(),
        symbol: r.symbol,
        timeframe: "1D",
        price: r.price,
        side: r.side,
        indicators: { wt1: r.wt1, wt2: r.wt2, rsi: r.rsi, ttcL: r.ttcL, ttcS: r.ttcS },
        conditions: r.results,
        allPass: true,
        tradeSize: adjustedSize,
        ttcScore: `${ttcScore}/7`,
        sl: r.slPrice,
        tp: r.tpPrice,
        orderPlaced: false,
        orderId: null,
        paperTrading: CONFIG.paperTrading,
      };

      console.log(`\n🎯 ${r.symbol} — ${r.side} signal`);
      console.log(`   Size: $${adjustedSize.toFixed(2)}${ttcScore === 2 ? " (50% — minimum TTC)" : " (full size)"}`);
      console.log(`   Entry: $${r.price.toFixed(4)}`);
      console.log(`   SL:    $${r.slPrice.toFixed(4)} (1.5× ATR)`);
      console.log(`   TP:    $${r.tpPrice.toFixed(4)} (4.5× ATR)`);

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — logged. Set PAPER_TRADING=false to go live.`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
      } else {
        try {
          const ttcScore = r.side === "LONG" ? r.ttcL : r.ttcS;
        const leverage = getSwingLeverage(ttcScore);
        console.log(`   Leverage: ${leverage}x (TTC ${ttcScore}/7)`);
        const order = await placeBitGetOrder(r.symbol, r.side === "LONG" ? "buy" : "sell", adjustedSize, r.price, leverage);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          console.log(`\n✅ LIVE ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`\n❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }

      log.trades.push(logEntry);
      writeTradeCsv(logEntry);
    }

    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
  }

  // Also log blocked assets for full audit trail
  for (const r of results.filter((r) => !r.allPass)) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol: r.symbol,
      timeframe: "1D",
      price: r.price,
      indicators: { wt2: r.wt2, ttcL: r.ttcL, ttcS: r.ttcS },
      conditions: r.results,
      allPass: false,
      tradeSize: 0,
      orderPlaced: false,
      paperTrading: CONFIG.paperTrading,
    };
    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
  }
  saveLog(log);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err.message);
    process.exit(1);
  });
}
