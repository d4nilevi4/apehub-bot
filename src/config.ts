import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type EngineName = "claude" | "opencode" | "codex";

export interface Config {
  botToken: string;
  forumChatId: number;
  dataDir: string;
  projectsRoot: string;
  dbPath: string;
  credsDir: string;
  defaultEngine: EngineName;
  model?: string;
  askTimeoutMs: number;
  /** Idle time (no engine activity) after which a running turn is auto-slept. */
  sleepAfterMs: number;
  /** OAuth App client id for GitHub device-flow login (public, not a secret). */
  githubClientId?: string;
  githubScope: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error("BOT_TOKEN is not set");
  const forumChatId = Number(env.FORUM_CHAT_ID);
  if (!Number.isFinite(forumChatId) || forumChatId === 0) {
    throw new Error("FORUM_CHAT_ID is not set or invalid");
  }
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    botToken,
    forumChatId,
    dataDir,
    projectsRoot: env.PROJECTS_ROOT ?? `${dataDir}/projects`,
    dbPath: env.DB_PATH ?? `${dataDir}/apehub.sqlite`,
    credsDir: env.CREDS_DIR ?? `${dataDir}/creds`,
    defaultEngine: (env.DEFAULT_ENGINE as EngineName) ?? "claude",
    model: env.MODEL || undefined,
    askTimeoutMs: Number(env.ASK_TIMEOUT_MS) || 10 * 60_000,
    sleepAfterMs: Number(env.SLEEP_AFTER_MS) || 30 * 60_000,
    githubClientId: env.GITHUB_CLIENT_ID || undefined,
    githubScope: env.GITHUB_SCOPE || "repo",
  };
}

/**
 * Per-session model credentials. The bot never stores these: in production
 * systemd delivers the credential via LoadCredential ($CREDENTIALS_DIRECTORY/anthropic),
 * so it is absent from the bot's own .env/config. Falls back to a plain env var
 * for local dev.
 *
 * One credential, two auth modes, auto-detected by prefix:
 *  - `sk-ant-oat…` → a subscription OAuth token (from `claude setup-token`, Pro/Max)
 *    → injected as CLAUDE_CODE_OAUTH_TOKEN.
 *  - anything else → a pay-per-token API key → injected as ANTHROPIC_API_KEY.
 *
 * Source precedence (first hit wins), read fresh each call so in-bot /login takes
 * effect without a restart:
 *  1. `<credsDir>/anthropic`  — written by /login
 *  2. `$CREDENTIALS_DIRECTORY/anthropic` — systemd LoadCredential bootstrap
 *  3. env ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — local dev
 * ponytail: in-process credential custody; the broker moves it to a separate uid later.
 */
export function resolveSessionEnv(
  env: NodeJS.ProcessEnv = process.env,
  credsDir?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let cred: string | undefined;
  if (credsDir) cred = readTrim(`${credsDir}/anthropic`);
  if (!cred && env.CREDENTIALS_DIRECTORY) cred = readTrim(`${env.CREDENTIALS_DIRECTORY}/anthropic`);
  if (!cred) cred = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
  if (cred) {
    if (cred.startsWith("sk-ant-oat")) out.CLAUDE_CODE_OAUTH_TOKEN = cred;
    else out.ANTHROPIC_API_KEY = cred;
  }
  if (env.ANTHROPIC_BASE_URL) out.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  return out;
}

function readTrim(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex session env: a per-user CODEX_HOME (holds auth.json + session rollouts for
 * `codex exec resume`), plus CODEX_API_KEY when logged in by key. ChatGPT-subscription
 * auth lives in `<credsDir>/codex/auth.json`, written by /login codex.
 */
export function resolveCodexEnv(credsDir: string): Record<string, string> {
  const out: Record<string, string> = { CODEX_HOME: `${credsDir}/codex` };
  const key = readTrim(`${credsDir}/codex-api-key`);
  if (key) {
    out.CODEX_API_KEY = key;
    out.OPENAI_API_KEY = key;
  }
  return out;
}

export function hasCodexAuth(credsDir: string): boolean {
  return existsSync(`${credsDir}/codex/auth.json`) || readTrim(`${credsDir}/codex-api-key`) !== undefined;
}

/**
 * Git access for sessions when the user has logged into GitHub. Writes a per-user
 * gitconfig whose credential helper reads the token from $GH_TOKEN (so the token
 * itself is never written into the file) and sets commit authorship to the user.
 */
export function resolveGithubEnv(credsDir: string): Record<string, string> {
  const token = readTrim(`${credsDir}/github-token`);
  if (!token) return {};
  let name = "ApeHub";
  let email = "apehub@users.noreply.github.com";
  try {
    const u = JSON.parse(readFileSync(`${credsDir}/github-user.json`, "utf8"));
    if (u.login) name = u.login;
    if (u.email) email = u.email;
  } catch {
    /* no profile yet */
  }
  const gitconfig = `${credsDir}/gitconfig`;
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; }; f`;
  writeFileSync(
    gitconfig,
    `[user]\n\tname = ${name}\n\temail = ${email}\n[credential "https://github.com"]\n\thelper = ${helper}\n`,
    { mode: 0o600 },
  );
  return { GH_TOKEN: token, GITHUB_TOKEN: token, GIT_CONFIG_GLOBAL: gitconfig, GIT_TERMINAL_PROMPT: "0" };
}
