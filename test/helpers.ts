import type { Engine, EngineCapabilities, RunOptions, RunResult } from "../src/engine";

/** Records every call so tests can assert on what the bot asked Telegram to do. */
export class FakeApi {
  sent: { chatId: number; text: string; opts?: any }[] = [];
  topics: { name: string; id: number }[] = [];
  closed: number[] = [];
  edits: { messageId: number; text: string }[] = [];
  private mid = 100;
  private tid = 10;

  async sendMessage(chatId: number, text: string, opts?: unknown) {
    this.sent.push({ chatId, text, opts });
    return { message_id: ++this.mid };
  }
  async createForumTopic(_chatId: number, name: string) {
    const id = ++this.tid;
    this.topics.push({ name, id });
    return { message_thread_id: id };
  }
  async closeForumTopic(_chatId: number, messageThreadId: number) {
    this.closed.push(messageThreadId);
    return true;
  }
  async editMessageText(_chatId: number, messageId: number, text: string) {
    this.edits.push({ messageId, text });
    return true;
  }

  /** The callback_data of the last message that carried inline buttons. */
  lastButtonData(): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const kb = this.sent[i]?.opts?.reply_markup?.inline_keyboard;
      if (kb) return kb[0]?.[0]?.callback_data;
    }
    return undefined;
  }
}

/** Stands in for a real engine: records RunOptions, streams canned text, can trip a permission. */
export class FakeEngine implements Engine {
  readonly name = "claude" as const;
  calls: RunOptions[] = [];
  nextSessionId = "sess-1";
  stream: string[] = ["hello from agent"];
  resultText = "";
  nextModel?: string;
  nextCtxUsed?: number;
  window?: number;
  /** If set, run() hangs with no activity until the signal aborts (idle/stuck turn). */
  stall = false;
  /** If set, run() emits this many onActivity heartbeats, beatMs apart, before finishing. */
  beats = 0;
  beatMs = 20;
  /** If set, run() asks for permission to use this tool and records the decision. */
  permissionTool?: string;
  lastDecision?: unknown;

  readonly capabilities: EngineCapabilities = {
    models: ["fake-a", "fake-b"],
    contextWindow: () => this.window,
  };

  async run(o: RunOptions): Promise<RunResult> {
    this.calls.push(o);
    if (this.stall) {
      await new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve()));
      return { sessionId: this.nextSessionId, text: "", isError: false };
    }
    for (let i = 0; i < this.beats; i++) {
      o.onActivity?.();
      await new Promise((r) => setTimeout(r, this.beatMs));
    }
    if (this.permissionTool) {
      this.lastDecision = await o.onPermission({
        toolName: this.permissionTool,
        input: { command: "rm -rf /" },
      });
    }
    for (const t of this.stream) await o.onText(t);
    return {
      sessionId: this.nextSessionId,
      text: this.resultText,
      isError: false,
      model: this.nextModel,
      ctxUsed: this.nextCtxUsed,
    };
  }
}
