import { mkdirSync } from "node:fs";
import type { Bridge } from "./bridge";
import { hasCodexAuth, resolveCodexEnv, resolveGithubEnv, resolveSessionEnv, type Config, type EngineName } from "./config";
import { makeCommsServer } from "./comms";
import { ASSISTANT_CONTRACT, GENERAL_TOPIC_ID, TELEGRAM_CONTRACT } from "./constants";
import type { Db, Project } from "./db";
import type { Engine } from "./engine";

export interface SessionDeps {
  config: Config;
  db: Db;
  getEngine: (name: EngineName) => Engine;
  bridge: Bridge;
  send: (topicId: number, text: string) => Promise<void> | void;
  /** MCP server with the General-assistant orchestration tools. */
  assistantServer: unknown;
}

/** Tools pre-approved for every session; anything else prompts the user via buttons. */
const SAFE_TOOLS = [
  "mcp__apehub-comms__ask_user",
  "mcp__apehub__create_project",
  "mcp__apehub__list_projects",
  "mcp__apehub__project_status",
  "mcp__apehub__github_login",
  "Read",
  "Glob",
  "Grep",
];

/** Fraction of the context window at which auto-compact kicks in. */
const AUTOCOMPACT_AT = 0.8;

const SUMMARY_PROMPT =
  "Summarize our conversation so far so a fresh session can continue seamlessly: the goal, what has been done, key files/commands, decisions made, current state, and the next steps. Be thorough but compact. Output only the summary.";

/**
 * One serialized queue per topic: a new message waits for the current turn, then
 * resumes the session (context preserved via resumeSessionId). Idle = cold (0 RAM).
 * ponytail: cold-resume per message; a warm pool is a latency optimization — add later.
 */
export class SessionManager {
  private chains = new Map<number, Promise<void>>();
  private active = new Map<number, AbortController>();

  constructor(private deps: SessionDeps) {}

  handle(topicId: number, text: string): Promise<void> {
    return this.enqueue(topicId, () => this.process(topicId, text));
  }

  /** /compact: summarize the current session, then reseed a fresh one. Universal across engines. */
  compact(topicId: number): Promise<void> {
    return this.enqueue(topicId, async () => {
      const { db, config } = this.deps;
      const project = db.getProject(topicId);
      if (!project?.sessionId) {
        await this.deps.send(topicId, "Нечего сжимать — сессия ещё не начата.");
        return;
      }
      const env = this.authEnv(topicId, project);
      if (!env) return;
      await this.deps.send(topicId, "🗜 Сжимаю историю…");
      await this.doCompact(topicId, project, env, project.sessionId);
      await this.deps.send(topicId, "✅ История сжата: следующее сообщение продолжит с кратким резюме.");
    });
  }

  /** /stop and manual /sleep: abort the turn currently running in this topic. */
  interrupt(topicId: number): boolean {
    const ac = this.active.get(topicId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /** True while a turn is actively running in this topic. */
  isActive(topicId: number): boolean {
    return this.active.has(topicId);
  }

  private enqueue(topicId: number, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(topicId) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch(async (e) => {
        console.error(`[session ${topicId}]`, e);
        await this.deps.send(topicId, `⚠️ Ошибка: ${String((e as Error)?.message ?? e)}`);
      })
      .finally(() => {
        if (this.chains.get(topicId) === next) this.chains.delete(topicId);
      });
    this.chains.set(topicId, next);
    return next;
  }

  /** Build the full session env (model auth + git access); sends a hint and returns null if not logged in. */
  private authEnv(topicId: number, project: Project): Record<string, string> | null {
    const { config } = this.deps;
    const git = resolveGithubEnv(config.credsDir); // empty unless logged into GitHub
    if (project.engine === "codex") {
      if (!hasCodexAuth(config.credsDir)) {
        void this.deps.send(topicId, "🔑 Не вошёл в Codex. Набери /login codex.");
        return null;
      }
      return { ...resolveCodexEnv(config.credsDir), ...git };
    }
    const env = resolveSessionEnv(process.env, config.credsDir);
    if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      void this.deps.send(topicId, "🔑 Не вошёл в модель. Набери /login claude (или /login codex).");
      return null;
    }
    return { ...env, ...git };
  }

  private modelFor(project: Project): string | undefined {
    if (project.engine === "codex") return project.model ?? undefined;
    return project.model ?? this.deps.config.model;
  }

  private async process(topicId: number, text: string): Promise<void> {
    const { db, config } = this.deps;
    const isGeneral = topicId === GENERAL_TOPIC_ID;
    const project = db.getProject(topicId) ?? (isGeneral ? ensureGeneral(db, config) : null);
    if (!project) {
      await this.deps.send(topicId, "Этот топик не привязан к проекту.");
      return;
    }

    const env = this.authEnv(topicId, project);
    if (!env) return;

    const engine = this.deps.getEngine(project.engine);
    const model = this.modelFor(project);

    // Prepend a pending compaction summary to the first message of the new session.
    let prompt = text;
    if (project.seed) {
      prompt = `Контекст прошлой сессии (сжатая история):\n${project.seed}\n\n---\nНовое сообщение: ${text}`;
      db.setSeed(topicId, null);
    }

    const mcpServers: Record<string, unknown> = {
      "apehub-comms": makeCommsServer(this.deps.bridge, topicId),
    };
    if (isGeneral) mcpServers["apehub"] = this.deps.assistantServer;

    let sentAny = false;
    let lastActivity = Date.now();
    const bump = () => {
      lastActivity = Date.now();
    };
    const onText = async (t: string) => {
      bump();
      if (t.trim()) {
        sentAny = true;
        await this.deps.send(topicId, t);
      }
    };

    const ac = new AbortController();
    this.active.set(topicId, ac);
    // Watchdog: sleep (abort) a turn only after it has been fully idle — no engine
    // activity at all — for sleepAfterMs. A working agent keeps bumping, so it never sleeps.
    let sleptByIdle = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity >= config.sleepAfterMs) {
        sleptByIdle = true;
        ac.abort();
      }
    }, Math.min(60_000, config.sleepAfterMs));

    db.setState(topicId, "busy");
    try {
      const res = await engine.run({
        cwd: project.cwd,
        prompt,
        resumeSessionId: project.sessionId ?? undefined,
        env,
        model,
        systemPromptAppend: isGeneral ? ASSISTANT_CONTRACT : TELEGRAM_CONTRACT,
        mcpServers,
        allowedTools: SAFE_TOOLS,
        signal: ac.signal,
        onActivity: bump,
        onText,
        onPermission: (req) => {
          bump();
          return this.deps.bridge.requestPermission(topicId, req);
        },
      });
      // Session id is captured early (init/thread.started), so it's resumable even if slept.
      if (res.sessionId) db.setSession(topicId, res.sessionId);

      if (sleptByIdle) {
        await this.deps.send(topicId, "😴 Усыпил сессию — агент простаивал без активности. Контекст сохранён, напиши — продолжу.");
      } else if (!ac.signal.aborted) {
        db.setUsage(topicId, res.model ?? project.lastModel, res.ctxUsed ?? project.ctxUsed);
        if (!sentAny && res.text) await this.deps.send(topicId, res.text);

        // Auto-compact when the window is nearly full (only if we know the window).
        const win = engine.capabilities.contextWindow(res.model ?? model);
        if (project.autocompact && !res.isError && res.sessionId && res.ctxUsed && win && res.ctxUsed / win >= AUTOCOMPACT_AT) {
          await this.deps.send(topicId, "🗜 Контекст почти полон — сжимаю историю…");
          await this.doCompact(topicId, { ...project, sessionId: res.sessionId }, env, res.sessionId);
        }
      }
    } finally {
      clearInterval(watchdog);
      this.active.delete(topicId);
      if (db.getProject(topicId)?.state !== "archived") db.setState(topicId, "idle");
    }
  }

  /** Run a summary turn on `sessionId`, store it as the seed, and drop the session. */
  private async doCompact(
    topicId: number,
    project: Project,
    env: Record<string, string>,
    sessionId: string,
  ): Promise<void> {
    const engine = this.deps.getEngine(project.engine);
    let summary = "";
    const res = await engine.run({
      cwd: project.cwd,
      prompt: SUMMARY_PROMPT,
      resumeSessionId: sessionId,
      env,
      model: this.modelFor(project),
      onText: (t) => {
        summary += t;
      },
      onPermission: async () => ({ allow: false, message: "compaction is summary-only" }),
    });
    summary = (summary || res.text).trim();
    if (summary) {
      this.deps.db.setSeed(topicId, summary);
      this.deps.db.setSession(topicId, null);
    }
  }
}

export function ensureGeneral(db: Db, config: Config): Project {
  const existing = db.getProject(GENERAL_TOPIC_ID);
  if (existing) return existing;
  const now = Date.now();
  const p: Project = {
    topicId: GENERAL_TOPIC_ID,
    name: "General",
    engine: "claude",
    cwd: `${config.projectsRoot}/general`,
    sessionId: null,
    state: "idle",
    createdAt: now,
    updatedAt: now,
    model: null,
    autocompact: true,
    seed: null,
    lastModel: null,
    ctxUsed: null,
  };
  mkdirSync(p.cwd, { recursive: true });
  db.upsertProject(p);
  return p;
}
