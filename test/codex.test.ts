import { expect, test } from "bun:test";
import { parseCodexLine, type CodexState } from "../src/engines/codex";

function fresh(): CodexState {
  return { sessionId: "", text: "", isError: false, failMsg: "" };
}

test("captures thread id, streams agent text, ends clean", () => {
  const st = fresh();
  const out: string[] = [];
  const lines = [
    '{"type":"thread.started","thread_id":"01a0f7cc-2df2-7723-956b-0872af1941a8"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Готово, собрал."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10}}',
  ];
  for (const l of lines) {
    const t = parseCodexLine(st, l);
    if (t) out.push(t);
  }
  expect(st.sessionId).toBe("01a0f7cc-2df2-7723-956b-0872af1941a8");
  expect(out).toEqual(["Готово, собрал."]); // reasoning is not streamed
  expect(st.text).toBe("Готово, собрал.");
  expect(st.isError).toBe(false);
});

test("turn.failed marks error with message; transient noise is ignored", () => {
  const st = fresh();
  parseCodexLine(st, '{"type":"error","message":"Reconnecting... 1/5"}'); // transient, not fatal
  parseCodexLine(st, "2026-… ERROR codex_api: not json"); // trace noise
  expect(st.isError).toBe(false);
  parseCodexLine(st, '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}');
  expect(st.isError).toBe(true);
  expect(st.failMsg).toContain("401");
});

test("blank and malformed lines are no-ops", () => {
  const st = fresh();
  expect(parseCodexLine(st, "")).toBeNull();
  expect(parseCodexLine(st, "   ")).toBeNull();
  expect(parseCodexLine(st, "{broken")).toBeNull();
  expect(st).toEqual(fresh());
});
