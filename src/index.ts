import { mkdirSync } from "node:fs";
import { Bot } from "grammy";
import { makeAssistant } from "./assistant";
import { Bridge, type TgApi } from "./bridge";
import { Broker } from "./broker";
import { Commands } from "./commands";
import { hasWeeek, loadConfig } from "./config";
import { Db } from "./db";
import { getEngine } from "./engines";
import { GithubLogin } from "./github";
import { CredStore, LoginManager } from "./login";
import type { ProjectsApi, ProjectsCtx } from "./projects";
import { ensureGeneral, SessionManager } from "./sessions";
import { BOT_COMMANDS, registerHandlers } from "./telegram";

const TG_LIMIT = 4000;

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.projectsRoot, { recursive: true });

const credStore = new CredStore(config.credsDir);
const login = new LoginManager(credStore);
const githubLogin = new GithubLogin(config.githubClientId, config.githubScope, credStore, send);

const db = new Db(config.dbPath);
const bot = new Bot(config.botToken);
const api = bot.api as unknown as TgApi & ProjectsApi;

const bridge = new Bridge(api, config.forumChatId, config.askTimeoutMs);

const projectsCtx: ProjectsCtx = {
  api,
  db,
  forumChatId: config.forumChatId,
  projectsRoot: config.projectsRoot,
  defaultEngine: config.defaultEngine,
};
const assistant = makeAssistant(projectsCtx, { githubLogin });

async function send(topicId: number, text: string): Promise<void> {
  if (!text?.trim()) return;
  const opts = topicId > 0 ? { message_thread_id: topicId } : {};
  for (let i = 0; i < text.length; i += TG_LIMIT) {
    await bot.api.sendMessage(config.forumChatId, text.slice(i, i + TG_LIMIT), opts);
  }
}

const broker = new Broker();

const sessions = new SessionManager({
  config,
  db,
  getEngine,
  bridge,
  send,
  assistantServer: assistant.server,
  broker,
});

const commands = new Commands(
  db,
  config,
  sessions,
  getEngine,
  { getGithubUser: () => credStore.getGithubUser(), hasWeeek: () => hasWeeek(config.credsDir) },
  broker,
);

ensureGeneral(db, config);
registerHandlers(bot, config, { bridge, sessions, login, commands, githubLogin });

await bot.api.setMyCommands(BOT_COMMANDS);

bot.start({
  onStart: (info) => console.log(`apehub-bot online as @${info.username} (id ${info.id})`),
});

const stop = () => {
  // Do NOT close the DB here: an in-flight turn may still write to it during
  // shutdown ("Cannot use a closed database"). WAL-sqlite is durable per-commit;
  // the OS closes the fd on exit. Just stop polling.
  console.log("shutting down…");
  void bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
