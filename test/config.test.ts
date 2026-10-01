import { expect, test } from "bun:test";
import { resolveSessionEnv } from "../src/config";

test("subscription OAuth token is detected by prefix", () => {
  const e = resolveSessionEnv({ ANTHROPIC_API_KEY: "sk-ant-oat01-abc" } as any);
  expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abc");
  expect(e.ANTHROPIC_API_KEY).toBeUndefined();
});

test("a non-oat credential is treated as an API key", () => {
  const e = resolveSessionEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-xyz" } as any);
  expect(e.ANTHROPIC_API_KEY).toBe("sk-ant-api03-xyz");
  expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("nothing configured yields an empty env", () => {
  expect(resolveSessionEnv({} as any)).toEqual({});
});
