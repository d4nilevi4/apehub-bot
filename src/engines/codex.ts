import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Engine, EngineCapabilities, RunOptions, RunResult } from "../engine";

export interface CodexState {
  sessionId: string;
  text: string;
  isError: boolean;
  failMsg: string;
  model?: string;
  ctxUsed?: number;
}

/**
 * Pure reducer for one line of `codex exec --json` JSONL. Updates `st` and returns
 * any newly-completed agent text (so the caller can stream it in order). Exported
 * for tests. Event shapes observed from codex-cli 0.159.3:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.failed","error":{"message":"…"}}
 * Transient {"type":"error",…} reconnect lines are not fatal and are ignored.
 */
export function parseCodexLine(st: CodexState, line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let ev: any;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null; // non-JSON trace noise
  }
  switch (ev?.type) {
    case "thread.started":
      if (typeof ev.thread_id === "string") st.sessionId = ev.thread_id;
      if (typeof ev.model === "string") st.model = ev.model;
      return null;
    case "turn.started":
      if (typeof ev.model === "string") st.model = ev.model;
      return null;
    case "item.completed": {
      const it = ev.item;
      if (it?.type === "agent_message") {
        const t = String(it.text ?? it.message ?? "");
        if (t) {
          st.text = t;
          return t;
        }
      }
      return null;
    }
    case "turn.completed": {
      const u = ev.usage ?? {};
      const used = Number(u.input_tokens ?? u.prompt_tokens ?? 0) + Number(u.cached_input_tokens ?? 0);
      if (used > 0) st.ctxUsed = used;
      return null;
    }
    case "turn.failed":
      st.isError = true;
      st.failMsg = ev.error?.message ? String(ev.error.message) : st.failMsg;
      return null;
    default:
      return null;
  }
}

/**
 * Wraps the Codex CLI's non-interactive mode (`codex exec --json`). Unlike the
 * Claude engine, Codex runs autonomously inside a workspace-write sandbox
 * (`--approve-for-me`), so there are no interactive permission prompts to bridge.
 * Session continuity is via `codex exec resume <thread_id>`. Auth (CODEX_HOME /
 * CODEX_API_KEY) is supplied by the caller in `o.env`.
 * ponytail: workspace-write sandbox, no Telegram approvals; tighten the policy or
 * bridge codex approvals later if needed.
 */
export class CodexEngine implements Engine {
  readonly name = "codex" as const;
  readonly capabilities: EngineCapabilities = {
    models: ["gpt-5-codex", "gpt-5", "o3"],
    contextWindow: () => undefined, // codex doesn't report a window; show raw tokens
  };

  async run(o: RunOptions): Promise<RunResult> {
    // --approve-for-me = autonomous workspace-write sandbox (mutually exclusive with -s).
    const common = [
      "--json",
      "--skip-git-repo-check",
      "-C",
      o.cwd,
      "--approve-for-me",
      ...(o.model ? ["-m", o.model] : []),
    ];
    // Prompt as a positional arg (spawn passes it without a shell, so no injection;
    // Telegram messages are well under ARG_MAX). stdin is left closed.
    const args = o.resumeSessionId
      ? ["exec", "resume", ...common, o.resumeSessionId, o.prompt]
      : ["exec", ...common, o.prompt];

    const child = spawn("codex", args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, PATH: `/usr/local/bin:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (o.signal) o.signal.addEventListener("abort", () => child.kill("SIGTERM"));

    const st: CodexState = { sessionId: o.resumeSessionId ?? "", text: "", isError: false, failMsg: "" };
    let exitCode = 0;
    const done = new Promise<void>((resolve) => {
      child.once("close", (c) => {
        exitCode = c ?? 0;
        resolve();
      });
      child.once("error", () => {
        exitCode = -1;
        resolve();
      });
    });

    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      const t = parseCodexLine(st, line);
      if (t) await o.onText(t);
    }
    await done;

    if (exitCode !== 0 && !st.text) st.isError = true;
    const text = st.text || (st.isError ? `⚠️ Codex: ${st.failMsg || `процесс завершился (код ${exitCode})`}` : "");
    return { sessionId: st.sessionId, text, isError: st.isError, model: st.model, ctxUsed: st.ctxUsed };
  }
}
