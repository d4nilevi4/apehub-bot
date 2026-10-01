import type { BrokerJob } from "./broker";
import type { Config, EngineName } from "./config";
import { GENERAL_TOPIC_ID } from "./constants";
import type { Db, Project } from "./db";
import type { Engine } from "./engine";
import { bar, defaultAutocompactAt, fmtK } from "./format";
import { listHubSkills } from "./hub";

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
    private sessions: {
      interrupt(topicId: number): boolean;
      compact(topicId: number): Promise<void>;
      isActive(topicId: number): boolean;
    },
    private getEngine: (n: EngineName) => Engine,
    private creds: { getGithubUser(): { login: string } | null; hasWeeek(): boolean },
    private broker: { list(): BrokerJob[] },
  ) {}

  private proj(topicId: number): Project | null {
    return this.db.getProject(topicId);
  }

  status(topicId: number): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const model = p.lastModel ?? p.model ?? "(дефолт движка)";
    const session = this.sessions.isActive(topicId)
      ? "работает (идёт ответ)"
      : p.sessionId
        ? "простаивает (0 RAM, контекст сохранён)"
        : "новая";
    return {
      text: [
        `📊 *${p.name}*`,
        `Движок: ${p.engine}`,
        `Модель: ${model}`,
        `Сессия: ${session}`,
        `Контекст: ${this.ctxLine(p)}`,
        `Автокомпакт: ${this.autocompactLine(p)}`,
        `Авто-подтверждение: ${p.auto ? "вкл (без запроса)" : "выкл (спрашиваю)"}`,
        `GitHub: ${this.creds.getGithubUser()?.login ?? "не подключён (/login github)"}`,
        `Weeek: ${this.creds.hasWeeek() ? "подключён" : "не подключён (/login weeek)"}`,
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

  /** Manual sleep. Auto-sleep (on idle) is handled by the session watchdog. */
  sleep(topicId: number): CmdReply {
    if (!this.proj(topicId)) return NOT_LINKED;
    return {
      text: this.sessions.interrupt(topicId)
        ? "😴 Усыпляю сессию (прерываю текущий ход; контекст сохранён)."
        : "Сессия простаивает — она уже холодная (0 RAM), контекст на диске. Пиши — продолжу.",
    };
  }

  /** Fire-and-forget: sessions.compact sends its own progress messages. */
  compact(topicId: number): CmdReply | null {
    if (!this.proj(topicId)) return NOT_LINKED;
    void this.sessions.compact(topicId);
    return null;
  }

  /** /autocompact off | on | <tokens> — set whether & at what context size history auto-compacts. */
  autocompact(topicId: number, arg?: string): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const a = (arg ?? "").trim().toLowerCase();
    if (a === "") {
      return {
        text: `Автокомпакт сейчас: *${this.autocompactLine(p)}*.\nМеняй: \`/autocompact off\` · \`/autocompact on\` · \`/autocompact 150000\` (порог в токенах).`,
      };
    }
    if (a === "off" || a === "выкл") {
      this.db.setAutocompact(topicId, false);
      return { text: "✅ Автокомпакт выключен — историю сам сжимать не буду (есть /compact вручную)." };
    }
    if (a === "on" || a === "вкл") {
      this.db.setAutocompact(topicId, true);
      this.db.setAutocompactAt(topicId, null);
      const thr = defaultAutocompactAt(this.windowFor(p));
      return { text: `✅ Автокомпакт включён${thr ? ` (порог по умолчанию — ${fmtK(thr)} токенов)` : ""}.` };
    }
    const n = parseTokens(a);
    if (n && n > 0) {
      this.db.setAutocompact(topicId, true);
      this.db.setAutocompactAt(topicId, n);
      return { text: `✅ Автокомпакт включён, порог *${fmtK(n)}* токенов.` };
    }
    return { text: "Не понял. Примеры: `/autocompact off` · `/autocompact on` · `/autocompact 150000` · `/autocompact 150k`" };
  }

  /** Auto-approve: run tools/commands without a Telegram confirmation button. Per topic. */
  auto(topicId: number, arg?: string): CmdReply {
    const p = this.proj(topicId);
    if (!p) return NOT_LINKED;
    const a = (arg ?? "").trim().toLowerCase();
    if (a === "on" || a === "вкл") {
      this.db.setAuto(topicId, true);
      return { text: "✅ Авто-режим включён — команды выполняются без запроса. Выключить: `/auto off`" };
    }
    if (a === "off" || a === "выкл") {
      this.db.setAuto(topicId, false);
      return { text: "✅ Авто-режим выключен — снова буду спрашивать перед командами." };
    }
    return { text: `Авто-режим сейчас: *${p.auto ? "вкл" : "выкл"}*. Переключить: \`/auto on\` | \`/auto off\`` };
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

  /** List the skills available from the shared marketplace (hub). All are active in every session. */
  skills(): CmdReply {
    const list = listHubSkills(this.config.hubDir);
    if (!list.length) {
      return { text: "🧩 Маркетплейс скилов пуст или не подключён на сервере." };
    }
    const lines = list.map((s) => {
      const d = s.description.length > 90 ? `${s.description.slice(0, 90)}…` : s.description;
      return `• *${s.plugin}:${s.name}*${d ? ` — ${d}` : ""}`;
    });
    return {
      text: `🧩 *Скилы маркетплейса ApeHub* (${list.length}, активны во всех сессиях):\n${lines.join("\n")}`,
    };
  }

  jobs(): CmdReply {
    const js = this.broker.list();
    if (!js.length) return { text: "🏗 Очередь брокера пуста." };
    return {
      text: "🏗 Задачи брокера:\n" + js.map((j) => `#${j.id} [${j.kind}] ${j.state}: ${j.command.slice(0, 60)}`).join("\n"),
    };
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
        "/auto on|off — выполнять команды без запроса",
        "/new — начать новую сессию",
        "/sleep — усыпить сессию вручную",
        "/stop — прервать текущий ответ",
        "/jobs — очередь тяжёлых задач (брокер)",
        "/skills — доступные скилы маркетплейса",
        "/login claude|codex|github|weeek — входы",
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

  private autocompactLine(p: Project): string {
    if (!p.autocompact) return "выкл";
    const thr = p.autocompactAt ?? defaultAutocompactAt(this.windowFor(p));
    return thr ? `вкл (порог ${fmtK(thr)})` : "вкл";
  }
}

/** "150000", "150k", "150к" → 150000. null if not a token count. */
function parseTokens(s: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*([kкmм]?)$/.exec(s.trim());
  if (!m) return null;
  let n = parseFloat(m[1]!.replace(",", "."));
  const suf = m[2]!.toLowerCase();
  if (suf === "k" || suf === "к") n *= 1000;
  else if (suf === "m" || suf === "м") n *= 1_000_000;
  return Math.round(n);
}
