import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const bot = new Bot(token);

// Health check.
bot.command("ping", (ctx) => ctx.reply("pong 🐒"));

// Report where we are — useful while wiring up the forum (chat id + topic id).
bot.command("whereami", (ctx) => {
  const topic = ctx.message?.message_thread_id;
  const isForum = (ctx.chat as { is_forum?: boolean }).is_forum ?? false;
  return ctx.reply(
    [
      `chat_id: \`${ctx.chat.id}\``,
      `chat_type: ${ctx.chat.type}`,
      `is_forum: ${isForum}`,
      `topic_id: ${topic ?? "(General / none)"}`,
    ].join("\n"),
    { parse_mode: "Markdown", message_thread_id: topic },
  );
});

// For now just observe traffic so routing can be designed against real updates.
bot.on("message", (ctx) => {
  const text = ctx.message.text ?? "<non-text message>";
  console.log(
    `[msg] chat=${ctx.chat.id} topic=${ctx.message.message_thread_id ?? "-"} ` +
      `from=${ctx.from?.username ?? ctx.from?.id} :: ${text}`,
  );
});

bot.catch((err) => console.error("[bot error]", err.error));

bot.start({
  onStart: (info) => console.log(`apehub-bot online as @${info.username} (id ${info.id})`),
});

const stop = () => {
  console.log("shutting down…");
  void bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
