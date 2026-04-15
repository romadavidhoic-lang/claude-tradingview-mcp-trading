/**
 * fetch-trades.js — Pull yesterday + today trades from BitGet Futures
 * Usage:  node fetch-trades.js
 * Output: bitget-trades-YYYY-MM-DD.csv  (Excel-ready)
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import crypto from "crypto";

const BITGET = {
  apiKey:     process.env.BITGET_API_KEY,
  secretKey:  process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
  baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
};

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", BITGET.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function bgRequest(method, path, params = {}) {
  const qs  = Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString() : "";
  const fullPath = path + qs;
  const ts  = Date.now().toString();
  const sig = sign(ts, method, fullPath, "");
  const res = await fetch(`${BITGET.baseUrl}${fullPath}`, {
    method,
    headers: {
      "Content-Type":       "application/json",
      "ACCESS-KEY":         BITGET.apiKey,
      "ACCESS-SIGN":        sig,
      "ACCESS-TIMESTAMP":   ts,
      "ACCESS-PASSPHRASE":  BITGET.passphrase,
    },
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet ${path}: ${data.msg} (${data.code})`);
  return data.data;
}

// Fetch fill records (executed trades) for USDT-FUTURES
async function fetchFills(startMs, endMs) {
  const fills = [];
  let idLessThan = undefined;

  while (true) {
    const params = {
      productType: "USDT-FUTURES",
      startTime:   String(startMs),
      endTime:     String(endMs),
      limit:       "100",
    };
    if (idLessThan) params.idLessThan = idLessThan;

    const data = await bgRequest("GET", "/api/v2/mix/order/fills", params);
    if (!data?.fillList?.length) break;

    fills.push(...data.fillList);
    if (data.fillList.length < 100) break;
    idLessThan = data.fillList[data.fillList.length - 1].fillId;
  }

  return fills;
}

// Fetch order history for USDT-FUTURES
async function fetchOrders(startMs, endMs) {
  const orders = [];
  let idLessThan = undefined;

  while (true) {
    const params = {
      productType: "USDT-FUTURES",
      startTime:   String(startMs),
      endTime:     String(endMs),
      limit:       "100",
    };
    if (idLessThan) params.idLessThan = idLessThan;

    const data = await bgRequest("GET", "/api/v2/mix/order/history", params);
    if (!data?.orderList?.length) break;

    orders.push(...data.orderList);
    if (data.orderList.length < 100) break;
    idLessThan = data.orderList[data.orderList.length - 1].orderId;
  }

  return orders;
}

function toISODate(ms) { return new Date(parseInt(ms)).toISOString(); }
function toDate(ms)    { return new Date(parseInt(ms)).toISOString().slice(0,10); }
function toTime(ms)    { return new Date(parseInt(ms)).toISOString().slice(11,19); }

async function main() {
  // Yesterday 00:00 UTC → today 23:59:59 UTC
  const now       = new Date();
  const todayStr  = now.toISOString().slice(0, 10);
  const yesterday = new Date(now); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yestStr   = yesterday.toISOString().slice(0, 10);

  const startMs = new Date(yestStr + "T00:00:00Z").getTime();
  const endMs   = new Date(todayStr + "T23:59:59Z").getTime();

  console.log(`\nFetching BitGet futures trades: ${yestStr} → ${todayStr}`);
  console.log(`Range: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}\n`);

  // ── Fills (individual executions) ──────────────────────────────────────────
  let fills = [];
  try {
    fills = await fetchFills(startMs, endMs);
    console.log(`  Fills found: ${fills.length}`);
  } catch (e) {
    console.warn(`  Fills error: ${e.message}`);
  }

  // ── Orders (includes SL/TP closures) ───────────────────────────────────────
  let orders = [];
  try {
    orders = await fetchOrders(startMs, endMs);
    orders = orders.filter(o => o.status === "filled" || o.status === "partially_filled");
    console.log(`  Filled orders found: ${orders.length}`);
  } catch (e) {
    console.warn(`  Orders error: ${e.message}`);
  }

  // ── CSV — Fills ─────────────────────────────────────────────────────────────
  if (fills.length > 0) {
    const fillCsv = [
      ["Date","Time(UTC)","Symbol","Side","FillQty","FillPrice","PnL","Fee","TradeID","OrderID"].join(","),
      ...fills.map(f => [
        toDate(f.cTime),
        toTime(f.cTime),
        f.symbol,
        f.side,
        f.size,
        f.price,
        f.profit  ?? "",
        f.fee     ?? "",
        f.fillId  ?? "",
        f.orderId ?? "",
      ].join(",")),
    ].join("\n");

    const fillFile = `bitget-fills-${todayStr}.csv`;
    writeFileSync(fillFile, fillCsv);
    console.log(`\n✅ Fills → ${fillFile}`);
  } else {
    console.log("\n  No fills found for this period.");
  }

  // ── CSV — Orders ────────────────────────────────────────────────────────────
  if (orders.length > 0) {
    const orderCsv = [
      ["Date","Time(UTC)","Symbol","Side","Qty","AvgPrice","Status","TriggerType","PnL","Fee","OrderID"].join(","),
      ...orders.map(o => [
        toDate(o.cTime),
        toTime(o.cTime),
        o.symbol,
        o.side,
        o.size          ?? o.baseVolume ?? "",
        o.priceAvg      ?? o.price      ?? "",
        o.status,
        o.orderType,
        o.profit        ?? "",
        o.fee           ?? "",
        o.orderId,
      ].join(",")),
    ].join("\n");

    const orderFile = `bitget-orders-${todayStr}.csv`;
    writeFileSync(orderFile, orderCsv);
    console.log(`✅ Orders → ${orderFile}`);
  } else {
    console.log("  No filled orders found for this period.");
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n─── Summary ──────────────────────────────────────────────");
  if (fills.length > 0) {
    const bySymbol = {};
    for (const f of fills) {
      if (!bySymbol[f.symbol]) bySymbol[f.symbol] = { count: 0, pnl: 0 };
      bySymbol[f.symbol].count++;
      bySymbol[f.symbol].pnl += parseFloat(f.profit || 0);
    }
    for (const [sym, d] of Object.entries(bySymbol)) {
      console.log(`  ${sym.padEnd(15)} ${d.count} fills | PnL: ${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(4)} USDT`);
    }
  }
  console.log();
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
