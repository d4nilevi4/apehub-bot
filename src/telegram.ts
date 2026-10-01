import { Bot, type Context } from "grammy";
import type { Bridge } from "./bridge";
import type { CmdReply, Commands } from "./commands";
import type { Config } from "./config";
import { GENERAL_TOPIC_ID } from "./constants";
import type { LoginEngine, LoginManager } from "./login";
import type { SessionManager } from "./sessions";

export interface Handlers {
  bridge: Bridge;
  sessions: SessionManager;
  login: LoginManager;
  commands: Commands;
  githubLogin: { start(topicId: number): Promise<string> };
}

/** Shown in Telegram's "/" command menu (set via setMyCommands at startup). */
export const BOT_COMMANDS = [
  { command: "status", description: "движок, модель, сессия, контекст" },
  { command: "context", description: "заполнение окна контекста" },
  { command: "switchmodel", description: "сменить модель (без имени — кнопки)" },
  { command: "engine", description: "сменить движок проекта: claude | codex" },
  { command: "compact", description: "сжать историю (резюме → новая сессия)" },
  { command: "autocompact", description: "авто-сжатие: on | off | <токены>" },
  { command: "auto", description: "выполнять команды без запроса: on | off" },
  { command: "new", description: "начать новую сессию" },
  { command: "sleep", description: "усыпить сессию вручную" },
  { command: "stop", description: "прервать текущий ответ" },
  { command: "jobs", description: "очередь тяжёлых задач (брокер)" },
  { command: "skills", description: "доступные скилы маркетплейса" },
  { command: "login", description: "вход: claude | codex | github | weeek" },
  { command: "cancel", description: "отменить ввод логина" },
  { command: "help", description: "список команд" },
  { command: "ping", description: "проверка связи" },
];

export function registerHandlers(bot: Bot, config: Config, deps: Handlers): void {
  const thread = (topicId: number) => (topicId > 0 ? { message_thread_id: topicId } : {});
  const topicOf = (ctx: Context) => ctx.message?.message_thread_id ?? GENERAL_TOPIC_ID;

  const sendReply = (ctx: Context, topicId: number, r: CmdReply) =>
    ctx.reply(r.text, {
      ...thread(topicId),
      parse_mode: "Markdown",
      ...(r.buttons
        ? {
            reply_markup: {
              inline_keyboard: r.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
            },
          }
        : {}),
    });

  bot.command("ping", (ctx) => ctx.reply("pong 🐒"));

  // Universal commands — the bot resolves topic → project → engine itself.
  bot.command("status", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.status(topicOf(ctx))));
  bot.command("context", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.context(topicOf(ctx))));
  bot.command("switchmodel", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.switchModel(topicOf(ctx), ctx.match)));
  bot.command("engine", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.engine(topicOf(ctx), ctx.match)));
  bot.command("autocompact", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.autocompact(topicOf(ctx), ctx.match)));
  bot.command("auto", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.auto(topicOf(ctx), ctx.match)));
  bot.command("new", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.reset(topicOf(ctx))));
  bot.command("sleep", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.sleep(topicOf(ctx))));
  bot.command("stop", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.stop(topicOf(ctx))));
  bot.command("jobs", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.jobs()));
  bot.command("skills", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.skills()));
  bot.command("help", (ctx) => sendReply(ctx, topicOf(ctx), deps.commands.help()));
  bot.command("compact", (ctx) => {
    const r = deps.commands.compact(topicOf(ctx));
    if (r) return sendReply(ctx, topicOf(ctx), r);
  });

  bot.command("whereami", (ctx) => {
    const topic = ctx.message?.message_thread_id;
    return ctx.reply(`chat_id: \`${ctx.chat.id}\`\ntopic_id: ${topic ?? "(General)"}`, {
      parse_mode: "Markdown",
      message_thread_id: topic,
    });
  });

  bot.command("login", async (ctx) => {
    const topicId = ctx.message?.message_thread_id ?? GENERAL_TOPIC_ID;
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg === "github") {
      const msg = await deps.githubLogin.start(topicId);
      return ctx.reply(msg, { ...thread(topicId), parse_mode: "Markdown" });
    }
    if (arg !== "claude" && arg !== "codex" && arg !== "weeek") {
      return ctx.reply("Использование: /login claude | codex | github | weeek", thread(topicId));
    }
    const msg = deps.login.start(arg as LoginEngine, ctx.chat.id, topicId);
    return ctx.reply(msg, { ...thread(topicId), parse_mode: "Markdown" });
  });

  bot.command("cancel", (ctx) => {
    const topicId = ctx.message?.message_thread_id ?? GENERAL_TOPIC_ID;
    return ctx.reply(deps.login.cancel() ? "Отменил." : "Нечего отменять.", thread(topicId));
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (deps.bridge.handlePermissionCallback(data)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const topicId = ctx.callbackQuery.message?.message_thread_id ?? GENERAL_TOPIC_ID;
    const r = deps.commands.handleCallback(topicId, data);
    await ctx.answerCallbackQuery();
    if (r) await sendReply(ctx, topicId, r);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.id !== config.forumChatId) {
      if (ctx.chat.type === "private") await ctx.reply("Я работаю в форуме-группе проектов, не в личке.");
      return;
    }
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // commands handled above (incl. /cancel while a login is pending)
    const topicId = ctx.message.message_thread_id ?? GENERAL_TOPIC_ID;
    // A pending /login consumes the next message as the credential; delete it afterwards.
    if (deps.login.isPending()) {
      const res = deps.login.submit(text);
      try {
        await ctx.deleteMessage();
      } catch {
        /* no delete rights; credential is stored regardless */
      }
      await ctx.reply(res.message, thread(topicId));
      return;
    }
    // A reply to a pending ask_user is consumed here, not treated as a new turn.
    if (deps.bridge.resolveAsk(topicId, text)) return;
    void deps.sessions.handle(topicId, text);
  });

  bot.on("message:voice", async (ctx) => {
    if (ctx.chat.id !== config.forumChatId) return;
    const topicId = ctx.message.message_thread_id ?? GENERAL_TOPIC_ID;
    await ctx.reply("🎤 Голос пока не подключён (STT через шлюз — следующий этап).", thread(topicId));
  });

  bot.catch((err) => console.error("[bot error]", err.error));
}
