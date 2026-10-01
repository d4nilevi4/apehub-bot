/** Shared display helpers for context usage (status, /context, per-message header). */

/** Default auto-compact trigger as a fraction of the context window. */
export const AUTOCOMPACT_FRACTION = 0.8;

export function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

/** Default token threshold for auto-compact given the window (undefined if window unknown). */
export function defaultAutocompactAt(window?: number): number | undefined {
  return window ? Math.floor(window * AUTOCOMPACT_FRACTION) : undefined;
}

/**
 * The context line shown at the top of each reply, e.g.
 *   🧮 58k / 200k (29%)
 *   ▰▰▰▱▱▱▱▱▱▱
 * Falls back to a token count when the window is unknown, or "" when there is nothing to show.
 */
export function contextHeader(ctxUsed: number | null, window?: number): string {
  if (window) {
    const used = ctxUsed ?? 0;
    const pct = Math.round((used / window) * 100);
    return `🧮 ${fmtK(used)} / ${fmtK(window)} (${pct}%)\n${bar(pct)}`;
  }
  if (ctxUsed != null) return `🧮 ~${fmtK(ctxUsed)} токенов`;
  return "";
}
