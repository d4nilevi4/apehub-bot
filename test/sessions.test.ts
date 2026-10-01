import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Bridge } from "../src/bridge";
import { loadConfig, type Config } from "../src/config";
import { ASSISTANT_CONTRACT, TELEGRAM_CONTRACT } from "../src/constants";
import { Db, type Project } from "../src/db";
import { SessionManager } from "../src/sessions";
import { FakeApi, FakeEngine } from "./helpers";

process.env.ANTHROPIC_API_KEY = "test-key";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function setup(engine = new FakeEngine(), sleepMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "apehub-"));
  const config: Config = loadConfig({
    BOT_TOKEN: "x",
    FORUM_CHAT_ID: "-100",
    DATA_DIR: dir,
    ...(sleepMs ? { SLEEP_AFTER_MS: String(sleepMs) } : {}),
  } as any);
  const db = new Db(":memory:");
  const api = new FakeApi();
  const bridge = new Bridge(api, config.forumChatId, 1000);
  const sent: { topicId: number; text: string }[] = [];
  const sm = new SessionManager({
    config,
    db,
    getEngine: () => engine,
    bridge,
    send: (topicId, text) => void sent.push({ topicId, text }),
    assistantServer: { type: "sdk", name: "apehub" },
  });
  return { sm, db, api, bridge, engine, sent, config };
}

function mkProject(db: Db, topicId = 10): Project {
  const p: Project = {
    topicId, name: "proj", engine: "claude", cwd: "/tmp/proj",
    sessionId: null, state: "idle", createdAt: 1, updatedAt: 1,
    model: null, autocompact: true, seed: null, lastModel: null, ctxUsed: null,
  };
  db.upsertProject(p);
  return p;
}

test("project turn: runs engine, streams text, persists session id", async () => {
  const { sm, db, engine, sent } = setup();
  mkProject(db);
  await sm.handle(10, "hi");
  expect(engine.calls).toHaveLength(1);
  expect(engine.calls[0]!.prompt).toBe("hi");
  expect(engine.calls[0]!.systemPromptAppend).toBe(TELEGRAM_CONTRACT);
  expect(engine.calls[0]!.allowedTools).toContain("mcp__apehub-comms__ask_user");
  expect(sent.some((m) => m.text.includes("hello from agent"))).toBe(true);
  expect(db.getProject(10)?.sessionId).toBe("sess-1");
  expect(db.getProject(10)?.state).toBe("idle");
});

test("second turn resumes the stored session", async () => {
  const { sm, db, engine } = setup();
  mkProject(db);
  await sm.handle(10, "first");
  await sm.handle(10, "second");
  expect(engine.calls[1]!.resumeSessionId).toBe("sess-1");
});

test("messages on one topic are serialized (second sees first's session)", async () => {
  const { sm, db, engine } = setup();
  mkProject(db);
  const a = sm.handle(10, "a");
  const b = sm.handle(10, "b");
  await Promise.all([a, b]);
  expect(engine.calls).toHaveLength(2);
  expect(engine.calls[0]!.resumeSessionId).toBeUndefined();
  expect(engine.calls[1]!.resumeSessionId).toBe("sess-1");
});

test("General topic gets the assistant contract and orchestration MCP server", async () => {
  const { sm, engine } = setup();
  await sm.handle(0, "make me a project");
  expect(engine.calls[0]!.systemPromptAppend).toBe(ASSISTANT_CONTRACT);
  const mcp = engine.calls[0]!.mcpServers!;
  expect(Object.keys(mcp)).toContain("apehub");
  expect(Object.keys(mcp)).toContain("apehub-comms");
});

test("permission requests from the engine reach Telegram and resolve", async () => {
  const engine = new FakeEngine();
  engine.permissionTool = "Bash";
  const { sm, db, api, bridge } = setup(engine);
  mkProject(db);
  const done = sm.handle(10, "run a command");
  await tick();
  const data = api.lastButtonData();
  expect(data).toBeDefined();
  bridge.handlePermissionCallback(data!);
  await done;
  expect(engine.lastDecision).toEqual({ allow: true });
});

test("codex project: bails without auth, runs with CODEX_HOME once a key is stored", async () => {
  const { sm, db, engine, sent, config } = setup();
  db.upsertProject({
    topicId: 20, name: "cx", engine: "codex", cwd: "/tmp/cx",
    sessionId: null, state: "idle", createdAt: 1, updatedAt: 1,
    model: null, autocompact: true, seed: null, lastModel: null, ctxUsed: null,
  });
  await sm.handle(20, "hi");
  expect(engine.calls).toHaveLength(0);
  expect(sent.some((m) => m.text.includes("/login codex"))).toBe(true);

  mkdirSync(join(config.credsDir, "codex"), { recursive: true });
  writeFileSync(join(config.credsDir, "codex-api-key"), "sk-proj-abc");
  await sm.handle(20, "again");
  expect(engine.calls).toHaveLength(1);
  expect(engine.calls[0]!.env.CODEX_HOME).toBe(join(config.credsDir, "codex"));
  expect(engine.calls[0]!.env.CODEX_API_KEY).toBe("sk-proj-abc");
  expect(engine.calls[0]!.model).toBeUndefined();
});

test("project model overrides default and usage is recorded", async () => {
  const engine = new FakeEngine();
  engine.nextModel = "claude-opus-4-8";
  engine.nextCtxUsed = 1234;
  const { sm, db } = setup(engine);
  mkProject(db);
  db.setModel(10, "sonnet");
  await sm.handle(10, "hi");
  expect(engine.calls[0]!.model).toBe("sonnet");
  expect(db.getProject(10)?.lastModel).toBe("claude-opus-4-8");
  expect(db.getProject(10)?.ctxUsed).toBe(1234);
});

test("a pending seed is prepended to the next message then cleared", async () => {
  const { sm, db, engine } = setup();
  mkProject(db);
  db.setSeed(10, "PRIOR SUMMARY");
  await sm.handle(10, "continue");
  expect(engine.calls[0]!.prompt).toContain("PRIOR SUMMARY");
  expect(engine.calls[0]!.prompt).toContain("continue");
  expect(db.getProject(10)?.seed).toBeNull();
});

test("autocompact triggers a summary + reseed when the window is nearly full", async () => {
  const engine = new FakeEngine();
  engine.window = 200_000;
  engine.nextCtxUsed = 170_000; // 85% → over threshold
  const { sm, db } = setup(engine);
  mkProject(db);
  await sm.handle(10, "big task");
  expect(engine.calls).toHaveLength(2); // the turn + the auto summary
  expect(db.getProject(10)?.seed).toBeTruthy();
  expect(db.getProject(10)?.sessionId).toBeNull();
});

test("compact summarizes the session and reseeds", async () => {
  const { sm, db, engine } = setup();
  mkProject(db);
  await sm.handle(10, "do work");
  expect(db.getProject(10)?.sessionId).toBe("sess-1");
  await sm.compact(10);
  expect(engine.calls).toHaveLength(2);
  expect(db.getProject(10)?.sessionId).toBeNull();
  expect(db.getProject(10)?.seed).toBeTruthy();
});

test("interrupt returns false when nothing is running", () => {
  const { sm } = setup();
  expect(sm.interrupt(10)).toBe(false);
});

test("watchdog sleeps a fully idle (stalled) turn and keeps it resumable", async () => {
  const engine = new FakeEngine();
  engine.stall = true;
  const { sm, db, sent } = setup(engine, 100); // sleep after 100ms of no activity
  mkProject(db);
  await sm.handle(10, "go quiet");
  expect(sent.some((m) => m.text.includes("Усыпил"))).toBe(true);
  expect(db.getProject(10)?.sessionId).toBe("sess-1"); // resumable
  expect(sm.isActive(10)).toBe(false);
});

test("watchdog does NOT sleep a turn that keeps showing activity", async () => {
  const engine = new FakeEngine();
  engine.beats = 6;
  engine.beatMs = 30; // 180ms of activity, 30ms gaps < 100ms threshold
  const { sm, db, sent } = setup(engine, 100);
  mkProject(db);
  await sm.handle(10, "work hard");
  expect(sent.some((m) => m.text.includes("Усыпил"))).toBe(false);
  expect(sent.some((m) => m.text.includes("hello from agent"))).toBe(true);
  expect(db.getProject(10)?.sessionId).toBe("sess-1");
});

test("no model auth: bails with a clear message, no engine run", async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  const prevOat = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const { sm, db, engine, sent } = setup();
    mkProject(db);
    await sm.handle(10, "hi");
    expect(engine.calls).toHaveLength(0);
    expect(sent.some((m) => m.text.includes("/login"))).toBe(true);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    if (prevOat !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOat;
  }
});
