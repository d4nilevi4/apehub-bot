import type { Config, EngineName } from "./config";
import { GENERAL_TOPIC_ID } from "./constants";
import type { Db, Project } from "./db";
import type { Engine } from "./engine";

export interface Button {
  text: string;
  data: string;
}
export interface CmdReply {
  text: string;
  buttons?: Button[][];
}

const NOT_LINKED: CmdReply = { text: "Этот топик не привязан к проекту." };

/**
 * Universal command layer. Every command resolves the current topic → project →
 * engine, so the same command does the right thing whichever engine is open.
 * Methods return a reply (text + optional inline buttons) for the Telegram layer
 * to render; nothing here touches grammY.
 */
export class Commands {
  constructor(
    private db: Db,
    private config: Config,
    private sessions: { interrupt(topicId: number): boolean; compact(topicId: number): Promise<void> },
    private getEngine: (n: EngineName) => Engine,
  ) {}

  private proj(topicId: number): Project | null {
    return this.db.getProject(topicId);
  }

  status(topicId: number): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const model = p.lastModel ?? p.model ?? "(дефолт движка)";
    const session = p.sessionId ? "тёплая (есть история)" : "холодная (новая)";
    return {
      text: [
        `📊 *${p.name}*`,
        `Движок: ${p.engine}`,
        `Модель: ${model}`,
        `Сессия: ${session}`,
        `Контекст: ${this.ctxLine(p)}`,
        `Автокомпакт: ${p.autocompact ? "вкл" : "выкл"}`,
      ].join("\n"),
    };
  }

  context(topicId: number): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    if (p.ctxUsed == null) return { text: "🧮 Контекст пуст — напиши хотя бы одно сообщение." };
    const win = this.windowFor(p);
    const head = `🧮 Контекст · модель ${p.lastModel ?? p.model ?? "?"}`;
    if (win) {
      const pct = Math.round((p.ctxUsed / win) * 100);
      return { text: `${head}\n${fmtK(p.ctxUsed)} / ${fmtK(win)} (${pct}%)\n${bar(pct)}` };
    }
    return { text: `${head}\n~${fmtK(p.ctxUsed)} токенов (окно модели неизвестно)` };
  }

  switchModel(topicId: number, arg?: string): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const name = (arg ?? "").trim();
    if (name) return this.setModel(topicId, name);
    const models = this.getEngine(p.engine).capabilities.models;
    return {
      text: `Модель для движка *${p.engine}*. Выбери кнопкой или пришли \`/switchmodel <имя>\`:`,
      buttons: models.length ? models.map((m) => [{ text: m, data: `sm:${m}` }]) : undefined,
    };
  }

  setModel(topicId: number, model: string): CmdReply {
    if (!this.proj(topicId)) return NOT_LINKED;
    this.db.setModel(topicId, model);
    return { text: `✅ Модель: *${model}* (применится со следующего сообщения).` };
  }

  reset(topicId: number): CmdReply {
    if (!this.proj(topicId)) return NOT_LINKED;
    this.db.setSession(topicId, null);
    this.db.setSeed(topicId, null);
    this.db.setUsage(topicId, null, null);
    return { text: "🆕 Начал новую сессию — история сброшена." };
  }

  stop(topicId: number): CmdReply {
    return { text: this.sessions.interrupt(topicId) ? "⏹ Прерываю текущий ответ." : "Сейчас ничего не выполняется." };
  }

  /** Fire-and-forget: sessions.compact sends its own progress messages. */
  compact(topicId: number): CmdReply | null {
    if (!this.proj(topicId)) return NOT_LINKED;
    void this.sessions.compact(topicId);
    return null;
  }

  autocompact(topicId: number, arg?: string): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const a = (arg ?? "").trim().toLowerCase();
    if (a === "on" || a === "вкл") {
      this.db.setAutocompact(topicId, true);
      return { text: "✅ Автокомпакт включён." };
    }
    if (a === "off" || a === "выкл") {
      this.db.setAutocompact(topicId, false);
      return { text: "✅ Автокомпакт выключен." };
    }
    return { text: `Автокомпакт сейчас: *${p.autocompact ? "вкл" : "выкл"}*. Переключить: \`/autocompact on\` | \`/autocompact off\`` };
  }

  engine(topicId: number, arg?: string): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    if (topicId === GENERAL_TOPIC_ID) {
      return { text: "В General всегда Claude (ассистент-оркестратор). Движок меняется в топиках-проектах." };
    }
    const a = (arg ?? "").trim().toLowerCase();
    if (a === "claude" || a === "codex") return this.setEngine(topicId, a as EngineName);
    return {
      text: `Движок проекта: *${p.engine}*. Сменить:`,
      buttons: [[{ text: "claude", data: "eng:claude" }, { text: "codex", data: "eng:codex" }]],
    };
  }

  setEngine(topicId: number, name: EngineName): CmdReply {
    if (topicId === GENERAL_TOPIC_ID) return { text: "В General движок не меняется." };
    if (!this.proj(topicId)) return NOT_LINKED;
    this.db.setEngine(topicId, name);
    this.db.setSession(topicId, null); // session/history format differs per engine
    this.db.setSeed(topicId, null);
    return { text: `✅ Движок: *${name}*. Сессия сброшена (у движков разный формат истории).` };
  }

  help(): CmdReply {
    return {
      text: [
        "*Команды* (работают для текущего движка топика):",
        "/status — движок, модель, сессия, контекст",
        "/context — заполнение окна контекста",
        "/switchmodel [имя] — сменить модель (без имени — кнопки)",
        "/engine [claude|codex] — сменить движок проекта",
        "/compact — сжать историю (резюме → новая сессия)",
        "/autocompact on|off — авто-сжатие при заполнении",
        "/new — начать новую сессию",
        "/stop — прервать текущий ответ",
        "/login claude|codex — вход в модель",
      ].join("\n"),
    };
  }

  /** Inline-button callbacks for the model/engine pickers. */
  handleCallback(topicId: number, data: string): CmdReply | null {
    const sm = /^sm:(.+)$/.exec(data);
    if (sm) return this.setModel(topicId, sm[1]!);
    const eng = /^eng:(claude|codex)$/.exec(data);
    if (eng) return this.setEngine(topicId, eng[1] as EngineName);
    return null;
  }

  private windowFor(p: Project): number | undefined {
    return this.getEngine(p.engine).capabilities.contextWindow(p.lastModel ?? p.model ?? undefined);
  }

  private ctxLine(p: Project): string {
    if (p.ctxUsed == null) return "—";
    const win = this.windowFor(p);
    return win ? `${fmtK(p.ctxUsed)}/${fmtK(win)} (${Math.round((p.ctxUsed / win) * 100)}%)` : `${fmtK(p.ctxUsed)} токенов`;
  }
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}
