/**
 * telegram.js — shared Telegram notification helper
 * Used by all Antigravity bots.
 *
 * Env vars required:
 *   TELEGRAM_TOKEN   = bot token from BotFather
 *   TELEGRAM_CHAT_ID = your personal chat ID
 */

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function tg(text) {
  if (!TOKEN || !CHAT_ID) return; // silent if not configured
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* never crash the bot over a notification */ }
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function tgSignal({ bot, sym, entry, sl, tp, riskPct, atr, score, mode }) {
  const name = sym.replace(/^[^:]+:/,"").replace(/\.P$/,"");
  const r = ((tp - entry) / (entry - sl)).toFixed(1);
  return tg(
`🟢 <b>${bot} — SIGNAL</b>
📌 <b>${name}</b> LONG
💰 Entry:  <b>$${(+entry).toFixed(4)}</b>
🛑 SL:     $${(+sl).toFixed(4)}  (−${(riskPct*100).toFixed(2)}%)
🎯 TP:     $${(+tp).toFixed(4)}  (${r}R)
📊 ATR:    ${(+atr).toFixed(2)}${score ? `\n⭐ Score:  ${score}` : ""}
🗂 Mode:   ${mode === "PAPER" ? "📋 PAPER" : "🔴 LIVE"}`
  );
}

export function tgEntry({ bot, sym, orderId, entry, sl, tp, mode }) {
  const name = sym.replace(/^[^:]+:/,"").replace(/\.P$/,"");
  return tg(
`✅ <b>${bot} — ORDER PLACED</b>
📌 <b>${name}</b> LONG @ $${(+entry).toFixed(4)}
🛑 SL: $${(+sl).toFixed(4)}
🎯 TP: $${(+tp).toFixed(4)}
🆔 ${orderId}
🗂 ${mode === "PAPER" ? "📋 PAPER" : "🔴 LIVE"}`
  );
}

export function tgExit({ bot, sym, reason, entry, exitPrice, pnl, mode }) {
  const name  = sym.replace(/^[^:]+:/,"").replace(/\.P$/,"");
  const emoji = pnl >= 0 ? "🟢" : "🔴";
  const sign  = pnl >= 0 ? "+" : "";
  return tg(
`${emoji} <b>${bot} — EXIT (${reason})</b>
📌 <b>${name}</b>
📥 Entry:  $${(+entry).toFixed(4)}
📤 Exit:   $${(+exitPrice).toFixed(4)}
💵 PnL:    <b>${sign}${(+pnl).toFixed(4)} USDT</b>
🗂 ${mode === "PAPER" ? "📋 PAPER" : "🔴 LIVE"}`
  );
}

export function tgError({ bot, msg }) {
  return tg(`❌ <b>${bot} — ERROR</b>\n${msg}`);
}
