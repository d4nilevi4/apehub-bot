import { expect, test } from "bun:test";
import { Db, type Project } from "../src/db";

function mkProject(over: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    topicId: 10,
    name: "demo",
    engine: "claude",
    cwd: "/tmp/demo",
    sessionId: null,
    state: "idle",
    createdAt: now,
    updatedAt: now,
    model: null,
    autocompact: true,
    seed: null,
    lastModel: null,
    ctxUsed: null,
    ...over,
  };
}

test("upsert + get round-trips a project", () => {
  const db = new Db(":memory:");
  const p = mkProject();
  db.upsertProject(p);
  expect(db.getProject(10)).toEqual(p);
  expect(db.getProject(999)).toBeNull();
});

test("upsert on same topic_id updates in place", () => {
  const db = new Db(":memory:");
  db.upsertProject(mkProject({ name: "old" }));
  db.upsertProject(mkProject({ name: "new", engine: "codex" }));
  expect(db.listProjects()).toHaveLength(1);
  expect(db.getProject(10)?.name).toBe("new");
  expect(db.getProject(10)?.engine).toBe("codex");
});

test("setSession and setState persist", () => {
  const db = new Db(":memory:");
  db.upsertProject(mkProject());
  db.setSession(10, "sess-abc");
  db.setState(10, "archived");
  const p = db.getProject(10)!;
  expect(p.sessionId).toBe("sess-abc");
  expect(p.state).toBe("archived");
});

test("listProjects returns all rows", () => {
  const db = new Db(":memory:");
  db.upsertProject(mkProject({ topicId: 1, name: "a" }));
  db.upsertProject(mkProject({ topicId: 2, name: "b" }));
  expect(db.listProjects().map((p) => p.name).sort()).toEqual(["a", "b"]);
});

test("model / autocompact / seed / usage setters round-trip", () => {
  const db = new Db(":memory:");
  db.upsertProject(mkProject());
  db.setModel(10, "opus");
  db.setAutocompact(10, false);
  db.setSeed(10, "summary text");
  db.setUsage(10, "claude-opus-4-8", 45000);
  db.setSession(10, null);
  const p = db.getProject(10)!;
  expect(p.model).toBe("opus");
  expect(p.autocompact).toBe(false);
  expect(p.seed).toBe("summary text");
  expect(p.lastModel).toBe("claude-opus-4-8");
  expect(p.ctxUsed).toBe(45000);
  expect(p.sessionId).toBeNull();
});
