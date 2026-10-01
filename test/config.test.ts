import { expect, test } from "bun:test";
import { baseSessionEnv, resolveSessionEnv } from "../src/config";

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

test("baseSessionEnv carries PATH/HOME but not the bot's secrets/config", () => {
  const e = baseSessionEnv({
    PATH: "/usr/bin", HOME: "/home/ape",
    BOT_TOKEN: "secret", DATA_DIR: "/d", GITHUB_CLIENT_ID: "x",
  } as any);
  expect(e.PATH).toBe("/usr/bin");
  expect(e.HOME).toBe("/home/ape");
  expect(e.BOT_TOKEN).toBeUndefined();
  expect(e.DATA_DIR).toBeUndefined();
  expect(e.GITHUB_CLIENT_ID).toBeUndefined();
});

test("baseSessionEnv falls back to a sane PATH when none is set", () => {
  expect(baseSessionEnv({} as any).PATH).toContain("/usr/bin");
});
