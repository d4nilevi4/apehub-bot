import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Engine, EngineCapabilities, RunOptions, RunResult } from "../engine";

/**
 * The only file that touches the Claude Agent SDK. Everything else talks to the
 * `Engine` interface, so the SDK's exact types stay contained here and tests mock
 * the interface instead of the SDK.
 */
export class ClaudeEngine implements Engine {
  readonly name = "claude" as const;
  readonly capabilities: EngineCapabilities;

  // Real model window. Sonnet 5.5 reports 1M via the SDK (getContextUsage → maxTokens).
  // Override with the CONTEXT_WINDOW env var if a model ever differs.
  constructor(contextWindow = Number(process.env.CONTEXT_WINDOW) || 1_000_000) {
    this.capabilities = {
      // CLI resolves these aliases to the current model ids; full ids also pass through.
      models: ["opus", "sonnet", "haiku"],
      contextWindow: () => contextWindow,
    };
  }

  async run(o: RunOptions): Promise<RunResult> {
    const q = query({
      prompt: o.prompt,
      options: {
        cwd: o.cwd,
        resume: o.resumeSessionId,
        env: o.env as Record<string, string>,
        model: o.model,
        permissionMode: "default",
        // Do not read danil's ~/.claude or project CLAUDE.md: sessions stay isolated.
        // The shared skills hub is injected explicitly via `plugins`, not settingSources.
        settingSources: [],
        ...(o.plugins?.length ? { plugins: o.plugins } : {}),
        ...(o.skills ? { skills: o.skills } : {}),
        allowedTools: o.allowedTools,
        mcpServers: o.mcpServers as never,
        systemPrompt: o.systemPromptAppend
          ? { type: "preset", preset: "claude_code", append: o.systemPromptAppend }
          : { type: "preset", preset: "claude_code" },
        canUseTool: async (toolName, input) => {
          const d = await o.onPermission({ toolName, input: input as Record<string, unknown> });
          return d.allow
            ? { behavior: "allow", updatedInput: d.updatedInput ?? input }
            : { behavior: "deny", message: d.message };
        },
      },
    });

    if (o.signal) o.signal.addEventListener("abort", () => void q.interrupt?.());

    let sessionId = o.resumeSessionId ?? "";
    let text = "";
    let isError = false;
    let model: string | undefined;
    let ctxUsed: number | undefined;

    for await (const msg of q as AsyncIterable<Record<string, any>>) {
      o.onActivity?.();
      if (typeof msg.session_id === "string") sessionId = msg.session_id;
      if (msg.type === "system" && msg.subtype === "init") {
        if (typeof msg.model === "string") model = msg.model;
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block?.type === "text" && block.text) await o.onText(block.text);
        }
      } else if (msg.type === "result") {
        isError = msg.subtype !== "success";
        if (typeof msg.result === "string") text = msg.result;
        // Prompt tokens re-sent next turn ≈ current context occupancy.
        const u = msg.usage ?? {};
        const used =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (used > 0) ctxUsed = used;
      }
    }

    return { sessionId, text, isError, model, ctxUsed };
  }
}
