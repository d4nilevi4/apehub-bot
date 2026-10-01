import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveSessionEnv } from "../src/config";
import { CredStore, LoginManager } from "../src/login";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apehub-creds-"));
  const store = new CredStore(dir);
  return { dir, store, login: new LoginManager(store) };
}

test("claude: valid OAuth token is stored and the login clears", () => {
  const { dir, login } = setup();
  login.start("claude", 1, 0);
  expect(login.isPending()).toBe(true);
  expect(login.submit("sk-ant-oat01-abc").ok).toBe(true);
  expect(login.isPending()).toBe(false);
  expect(readFileSync(join(dir, "anthropic"), "utf8")).toBe("sk-ant-oat01-abc");
});

test("claude: junk is rejected and login stays open; API key then accepted", () => {
  const { login } = setup();
  login.start("claude", 1, 0);
  expect(login.submit("hello there").ok).toBe(false);
  expect(login.isPending()).toBe(true);
  expect(login.submit("sk-ant-api03-xyz").ok).toBe(true);
  expect(login.isPending()).toBe(false);
});

test("codex: auth.json is stored under codex/auth.json", () => {
  const { dir, login } = setup();
  login.start("codex", 1, 0);
  expect(login.submit('{"tokens":{"access":"x"}}').ok).toBe(true);
  expect(existsSync(join(dir, "codex", "auth.json"))).toBe(true);
});

test("codex: invalid JSON rejected; API key stored", () => {
  const { dir, login } = setup();
  login.start("codex", 1, 0);
  expect(login.submit("{not json").ok).toBe(false);
  expect(login.submit("sk-proj-123").ok).toBe(true);
  expect(readFileSync(join(dir, "codex-api-key"), "utf8")).toBe("sk-proj-123");
});

test("submit with no pending login errors; cancel reports whether something was open", () => {
  const { login } = setup();
  expect(login.submit("x").ok).toBe(false);
  expect(login.cancel()).toBe(false);
  login.start("claude", 1, 0);
  expect(login.cancel()).toBe(true);
  expect(login.isPending()).toBe(false);
});

test("resolveSessionEnv reads the logged-in credential from credsDir (wins over env)", () => {
  const { dir, login } = setup();
  login.start("claude", 1, 0);
  login.submit("sk-ant-oat01-live");
  const env = resolveSessionEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-stale" } as any, dir);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-live");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});
