import type { PermissionDecision, PermissionRequest } from "./engine";

/** The slice of grammY's bot.api that the bridge needs (keeps tests off grammY). */
export interface TgApi {
  sendMessage(chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
  editMessageText?(chatId: number, messageId: number, text: string, opts?: unknown): Promise<unknown>;
}

const SUMMARY_LEN = 300;

interface PendingPerm {
  resolve: (d: PermissionDecision) => void;
  messageId: number;
}

/**
 * Bridges the harness's two blocking needs to Telegram:
 *  - tool-permission prompts -> inline Allow/Deny buttons (canUseTool)
 *  - free-form questions -> ask_user tool, answered by the user's next message
 */
export class Bridge {
  private perms = new Map<string, PendingPerm>();
  private asks = new Map<number, (answer: string) => void>(); // keyed by topicId
  private seq = 0;

  constructor(
    private api: TgApi,
    private forumChatId: number,
    private askTimeoutMs: number,
  ) {}

  private threadOpts(topicId: number): Record<string, unknown> {
    return topicId > 0 ? { message_thread_id: topicId } : {};
  }

  // --- permissions: Allow / Deny buttons ---

  async requestPermission(topicId: number, req: PermissionRequest): Promise<PermissionDecision> {
    const id = `${Date.now()}-${this.seq++}`;
    // Register the resolver synchronously, before awaiting the send, so a fast
    // callback can never arrive before the pending entry exists.
    let resolve!: (d: PermissionDecision) => void;
    const decision = new Promise<PermissionDecision>((r) => (resolve = r));
    this.perms.set(id, { resolve, messageId: 0 });
    const msg = await this.api.sendMessage(
      this.forumChatId,
      `🔐 Разрешить \`${req.toolName}\`?\n${summarize(req)}`,
      {
        ...this.threadOpts(topicId),
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Разрешить", callback_data: `perm:${id}:allow` },
              { text: "⛔️ Запретить", callback_data: `perm:${id}:deny` },
            ],
          ],
        },
      },
    );
    const pending = this.perms.get(id);
    if (pending) pending.messageId = msg.message_id;
    return decision;
  }

  /** Returns true if `data` was a permission callback (handled or already expired). */
  handlePermissionCallback(data: string): boolean {
    const m = /^perm:(.+):(allow|deny)$/.exec(data);
    if (!m) return false;
    const [, id, verb] = m;
    const p = this.perms.get(id!);
    if (!p) return true; // already resolved / expired
    this.perms.delete(id!);
    p.resolve(verb === "allow" ? { allow: true } : { allow: false, message: "User denied this action." });
    void this.api.editMessageText?.(
      this.forumChatId,
      p.messageId,
      verb === "allow" ? "✅ Разрешено" : "⛔️ Запрещено",
    );
    return true;
  }

  // --- free-form questions: ask_user tool ---

  askUser(topicId: number, question: string): Promise<string> {
    void this.api.sendMessage(this.forumChatId, `❓ ${question}`, this.threadOpts(topicId));
    this.asks.get(topicId)?.("(superseded by a newer question)");
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (this.asks.delete(topicId)) resolve("(no answer — the user did not reply in time)");
      }, this.askTimeoutMs);
      this.asks.set(topicId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  hasPendingAsk(topicId: number): boolean {
    return this.asks.has(topicId);
  }

  /** Routes a user message to a pending ask_user. Returns true if it consumed it. */
  resolveAsk(topicId: number, answer: string): boolean {
    const r = this.asks.get(topicId);
    if (!r) return false;
    this.asks.delete(topicId);
    r(answer);
    return true;
  }
}

function summarize(req: PermissionRequest): string {
  const i = req.input;
  const head = (i.command ?? i.file_path ?? i.path ?? i.pattern) as unknown;
  let s = head != null ? String(head) : JSON.stringify(i);
  if (s.length > SUMMARY_LEN) s = s.slice(0, SUMMARY_LEN) + "…";
  return "`" + s.replace(/`/g, "'") + "`";
}
