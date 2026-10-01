import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Per-user credential storage, written by the in-bot /login flow and read fresh
 * by resolveSessionEnv / the engines. The bot now custodies model credentials
 * (the user's explicit choice: login happens through the bot). Files are 0600 in
 * a 0700 directory.
 * ponytail: in-process custody; a separate-uid broker hardens this later.
 */
export class CredStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Claude token (sk-ant-oat… subscription, or sk-ant-api… key) → <dir>/anthropic */
  setClaude(token: string): void {
    writeFileSync(`${this.dir}/anthropic`, token, { mode: 0o600 });
  }

  /** Codex ChatGPT-subscription creds (contents of ~/.codex/auth.json) → <dir>/codex/auth.json */
  setCodexAuthJson(json: string): void {
    const d = `${this.dir}/codex`;
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(`${d}/auth.json`, json, { mode: 0o600 });
  }

  /** Codex OpenAI API key → <dir>/codex-api-key (injected later as CODEX_API_KEY) */
  setCodexApiKey(key: string): void {
    writeFileSync(`${this.dir}/codex-api-key`, key, { mode: 0o600 });
  }

  /** GitHub OAuth token (device flow) → <dir>/github-token */
  setGithub(token: string): void {
    writeFileSync(`${this.dir}/github-token`, token, { mode: 0o600 });
  }

  /** GitHub profile (login/email) for git authorship → <dir>/github-user.json */
  setGithubUser(user: { login: string; email: string }): void {
    writeFileSync(`${this.dir}/github-user.json`, JSON.stringify(user), { mode: 0o600 });
  }

  /** Weeek API token (per-user, acts as that user in Weeek) → <dir>/weeek-token */
  setWeeek(token: string): void {
    writeFileSync(`${this.dir}/weeek-token`, token, { mode: 0o600 });
  }

  getGithubUser(): { login: string; email: string } | null {
    try {
      return JSON.parse(readFileSync(`${this.dir}/github-user.json`, "utf8"));
    } catch {
      return null;
    }
  }
}

export type LoginEngine = "claude" | "codex" | "weeek";
export interface LoginResult {
  ok: boolean;
  message: string;
}

const CLAUDE_INSTRUCTIONS = `🔐 Вход в *Claude*.
На своём компьютере выполни \`claude setup-token\` (нужна подписка Pro/Max) и пришли сюда полученный токен \`sk-ant-oat01-…\`.
Можно прислать и API-ключ \`sk-ant-api…\`.
⚠️ Сообщение с токеном я удалю сразу после сохранения. Отмена — /cancel.`;

const CODEX_INSTRUCTIONS = `🔐 Вход в *Codex*.
Вариант 1 (подписка ChatGPT): на компьютере выполни \`codex login\`, затем пришли сюда *содержимое* файла \`~/.codex/auth.json\` (начинается с \`{\`).
Вариант 2: пришли API-ключ OpenAI \`sk-…\`.
⚠️ Сообщение удалю сразу после сохранения. Отмена — /cancel.`;

const WEEEK_INSTRUCTIONS = `🔐 Вход в *Weeek*.
1. Открой https://app.weeek.net/ws/555194/settings/api
2. Создай токен (под своим аккаунтом) и пришли его сюда.
Все действия в трекере будут от твоего имени. ⚠️ Сообщение с токеном удалю сразу после сохранения. Отмена — /cancel.`;

const INSTRUCTIONS: Record<LoginEngine, string> = {
  claude: CLAUDE_INSTRUCTIONS,
  codex: CODEX_INSTRUCTIONS,
  weeek: WEEEK_INSTRUCTIONS,
};

/**
 * Tracks a single pending login (one user per bot) and validates/stores whatever
 * credential the user sends next.
 */
export class LoginManager {
  private pending: { engine: LoginEngine; chatId: number; topicId: number } | null = null;

  constructor(private store: CredStore) {}

  start(engine: LoginEngine, chatId: number, topicId: number): string {
    this.pending = { engine, chatId, topicId };
    return INSTRUCTIONS[engine];
  }

  isPending(): boolean {
    return this.pending !== null;
  }

  cancel(): boolean {
    const was = this.pending !== null;
    this.pending = null;
    return was;
  }

  /** Validate + store the submitted credential. On a bad value, keeps the login open for a retry. */
  submit(text: string): LoginResult {
    const p = this.pending;
    if (!p) return { ok: false, message: "Нет активного логина. Начни с /login claude или /login codex." };
    const raw = text.trim();

    if (p.engine === "claude") {
      if (!/^sk-ant-(oat|api)/.test(raw)) {
        return { ok: false, message: "Это не похоже на токен Claude (жду sk-ant-oat… или sk-ant-api…). Пришли ещё раз или /cancel." };
      }
      this.store.setClaude(raw);
      this.pending = null;
      return {
        ok: true,
        message: raw.startsWith("sk-ant-oat")
          ? "✅ Claude подключён по подписке. Напиши в любой топик — проверим."
          : "✅ Claude подключён по API-ключу. Напиши в любой топик — проверим.",
      };
    }

    if (p.engine === "weeek") {
      if (raw.length < 8) {
        return { ok: false, message: "Это не похоже на токен Weeek. Пришли токен из настроек workspace → API, или /cancel." };
      }
      this.store.setWeeek(raw);
      this.pending = null;
      return { ok: true, message: "✅ Weeek подключён. Задачи будут от твоего имени." };
    }

    // codex
    if (raw.startsWith("{")) {
      try {
        JSON.parse(raw);
      } catch {
        return { ok: false, message: "Похоже на auth.json, но JSON не парсится. Пришли файл целиком ещё раз или /cancel." };
      }
      this.store.setCodexAuthJson(raw);
      this.pending = null;
      return { ok: true, message: "✅ Codex-креды (auth.json) сохранены. Сам движок Codex подключу следующим шагом." };
    }
    if (raw.startsWith("sk-")) {
      this.store.setCodexApiKey(raw);
      this.pending = null;
      return { ok: true, message: "✅ Codex API-ключ сохранён. Сам движок Codex подключу следующим шагом." };
    }
    return { ok: false, message: "Для Codex пришли содержимое ~/.codex/auth.json (начинается с {) или API-ключ sk-… Или /cancel." };
  }
}
