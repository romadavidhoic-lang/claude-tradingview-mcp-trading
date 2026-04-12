// Entry point — reads BOT_TYPE env var to decide which bot to run
// accurate-reprieve: BOT_TYPE=swing  → bot.js
// scalping-bot:      BOT_TYPE=scalp  → bot-scalp.js
// agv3-sweep-bot:    BOT_TYPE=agv3   → agv3-bot.js

const type = process.env.BOT_TYPE || "swing";

if (type === "scalp") {
  import("./bot-scalp.js");
} else if (type === "agv3") {
  import("./agv3-bot.js");
} else {
  import("./bot.js");
}
