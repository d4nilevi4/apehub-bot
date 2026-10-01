import { expect, test } from "bun:test";
import type { BrokerJob } from "../src/broker";
import { Commands } from "../src/commands";
import type { Config } from "../src/config";
import { Db, type Project } from "../src/db";
import { getEngine } from "../src/engines";

function base(over: Partial<Project>): Project {
  return {
    topicId: 10, name: "proj", engine: "claude", cwd: "/tmp/p",
    sessionId: null, state: "idle", createdAt: 1, updatedAt: 1,
    model: null, autocompact: true, auto: false, autocompactAt: null, seed: null, lastModel: null, ctxUsed: null,
    ...over,
  };
}

function setup(
  project?: Partial<Project>,
  active = false,
  githubUser: { login: string } | null = null,
  weeek = false,
  jobs: BrokerJob[] = [],
) {
  const db = new Db(":memory:");
  db.upsertProject(base({ topicId: 0, name: "General" }));
  if (project) db.upsertProject(base(project));
  const calls = { interrupt: [] as number[], compact: [] as number[] };
  const sessions = {
    interrupt: (t: number) => {
      calls.interrupt.push(t);
      return active;
    },
    compact: async (t: number) => {
      calls.compact.push(t);
    },
    isActive: () => active,
  };
  const cmd = new Commands(
    db,
    {} as Config,
    sessions,
    getEngine,
    { getGithubUser: () => githubUser, hasWeeek: () => weeek },
    { list: () => jobs },
  );
  return { db, cmd, calls };
}

test("status shows engine, model and context %", () => {
  const { cmd } = setup({ topicId: 10, lastModel: "claude-opus-4-8", ctxUsed: 100_000 });
  const t = cmd.status(10).text;
  expect(t).toContain("Движок: claude");
  expect(t).toContain("claude-opus-4-8");
  expect(t).toContain("10%"); // 100k of 1M window
});

test("switchmodel without arg offers the engine's model buttons", () => {
  const { cmd } = setup({ topicId: 10, engine: "claude" });
  const r = cmd.switchModel(10);
  expect(r.buttons?.flat().map((b) => b.data)).toEqual(["sm:opus", "sm:sonnet", "sm:haiku"]);
});

test("switchmodel with arg (and the sm: callback) stores the model", () => {
  const { db, cmd } = setup({ topicId: 10 });
  expect(cmd.switchModel(10, "sonnet").text).toContain("sonnet");
  expect(db.getProject(10)?.model).toBe("sonnet");
  cmd.handleCallback(10, "sm:haiku");
  expect(db.getProject(10)?.model).toBe("haiku");
});

test("context reports emptiness, then a filled bar", () => {
  const { db, cmd } = setup({ topicId: 10 });
  expect(cmd.context(10).text).toContain("пуст");
  db.setUsage(10, "opus", 20_000);
  expect(cmd.context(10).text).toContain("2%"); // 20k/1M
});

test("new/reset clears session, seed and usage", () => {
  const { db, cmd } = setup({ topicId: 10, sessionId: "s1", seed: "x", ctxUsed: 5 });
  cmd.reset(10);
  const p = db.getProject(10)!;
  expect(p.sessionId).toBeNull();
  expect(p.seed).toBeNull();
  expect(p.ctxUsed).toBeNull();
});

test("stop and compact delegate to the session manager", () => {
  const { cmd, calls } = setup({ topicId: 10 });
  cmd.stop(10);
  expect(calls.interrupt).toEqual([10]);
  expect(cmd.compact(10)).toBeNull();
  expect(calls.compact).toEqual([10]);
});

test("autocompact toggles and reports", () => {
  const { db, cmd } = setup({ topicId: 10 });
  expect(cmd.autocompact(10).text).toContain("вкл"); // default on
  cmd.autocompact(10, "off");
  expect(db.getProject(10)?.autocompact).toBe(false);
  cmd.autocompact(10, "on");
  expect(db.getProject(10)?.autocompact).toBe(true);
});

test("autocompact accepts a token threshold, and on resets it to default", () => {
  const { db, cmd } = setup({ topicId: 10 });
  expect(cmd.autocompact(10, "150k").text).toContain("150k");
  expect(db.getProject(10)?.autocompact).toBe(true);
  expect(db.getProject(10)?.autocompactAt).toBe(150000);
  cmd.autocompact(10, "on");
  expect(db.getProject(10)?.autocompactAt).toBeNull();
});

test("auto toggles and reports", () => {
  const { db, cmd } = setup({ topicId: 10 });
  expect(cmd.auto(10).text).toContain("выкл"); // default off
  cmd.auto(10, "on");
  expect(db.getProject(10)?.auto).toBe(true);
  cmd.auto(10, "off");
  expect(db.getProject(10)?.auto).toBe(false);
});

test("engine switch clears session; General stays claude", () => {
  const { db, cmd } = setup({ topicId: 10, sessionId: "s1", engine: "claude" });
  expect(cmd.engine(10, "codex").text).toContain("codex");
  const p = db.getProject(10)!;
  expect(p.engine).toBe("codex");
  expect(p.sessionId).toBeNull();
  // General (topic 0) refuses an engine change
  expect(cmd.engine(0).text).toContain("General");
  expect(cmd.setEngine(0, "codex").text).toContain("General");
  expect(db.getProject(0)?.engine).toBe("claude");
});

test("codex engine offers its own model list", () => {
  const { cmd } = setup({ topicId: 10, engine: "codex" });
  expect(cmd.switchModel(10).buttons?.flat().map((b) => b.data)).toEqual(["sm:gpt-5-codex", "sm:gpt-5", "sm:o3"]);
});

test("status reflects working vs idle state", () => {
  expect(setup({ topicId: 10, sessionId: "s1" }, false).cmd.status(10).text).toContain("простаивает");
  expect(setup({ topicId: 10, sessionId: "s1" }, true).cmd.status(10).text).toContain("работает");
});

test("sleep interrupts an active turn, reassures when idle", () => {
  expect(setup({ topicId: 10 }, true).cmd.sleep(10).text).toContain("Усыпляю");
  expect(setup({ topicId: 10 }, false).cmd.sleep(10).text).toContain("простаивает");
});

test("skills reports an empty/absent hub", () => {
  const { cmd } = setup({ topicId: 10 });
  expect(cmd.skills().text).toContain("пуст");
});

test("jobs lists the broker queue", () => {
  expect(setup({ topicId: 10 }).cmd.jobs().text).toContain("пуста");
  const withJobs = setup({ topicId: 10 }, false, null, false, [
    { id: 1, kind: "unity", command: "blender render", state: "running" },
  ]).cmd.jobs().text;
  expect(withJobs).toContain("#1");
  expect(withJobs).toContain("unity");
});

test("status shows GitHub and Weeek connection", () => {
  const off = setup({ topicId: 10 }, false, null, false).cmd.status(10).text;
  expect(off).toContain("GitHub: не подключён");
  expect(off).toContain("Weeek: не подключён");
  const on = setup({ topicId: 10 }, false, { login: "octocat" }, true).cmd.status(10).text;
  expect(on).toContain("octocat");
  expect(on).toContain("Weeek: подключён");
});
