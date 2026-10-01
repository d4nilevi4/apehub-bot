import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Db } from "../src/db";
import { archiveProject, createProject, listProjects, type ProjectsCtx } from "../src/projects";
import { FakeApi } from "./helpers";

function setup(): { ctx: ProjectsCtx; api: FakeApi; db: Db } {
  const api = new FakeApi();
  const db = new Db(":memory:");
  const projectsRoot = mkdtempSync(join(tmpdir(), "apehub-"));
  return { api, db, ctx: { api, db, forumChatId: -100, projectsRoot, defaultEngine: "claude" } };
}

test("createProject creates topic, dir, db row, and announces it", async () => {
  const { ctx, api, db } = setup();
  const p = await createProject(ctx, "My Game");
  expect(api.topics[0]?.name).toBe("My Game");
  expect(p.topicId).toBeGreaterThan(0);
  expect(existsSync(p.cwd)).toBe(true);
  expect(db.getProject(p.topicId)?.name).toBe("My Game");
  // announced into the new topic
  expect(api.sent.some((m) => (m.opts as any)?.message_thread_id === p.topicId)).toBe(true);
});

test("createProject honors a chosen engine", async () => {
  const { ctx } = setup();
  const p = await createProject(ctx, "x", "codex");
  expect(p.engine).toBe("codex");
});

test("archiveProject closes the topic and marks it archived", async () => {
  const { ctx, api, db } = setup();
  const p = await createProject(ctx, "temp");
  await archiveProject(ctx, p.topicId);
  expect(api.closed).toContain(p.topicId);
  expect(db.getProject(p.topicId)?.state).toBe("archived");
});

test("listProjects hides archived and the General row", async () => {
  const { ctx, db } = setup();
  await createProject(ctx, "keep");
  const b = await createProject(ctx, "drop");
  db.upsertProject({
    topicId: 0, name: "General", engine: "claude", cwd: "/tmp/g",
    sessionId: null, state: "idle", createdAt: 1, updatedAt: 1,
    model: null, autocompact: true, seed: null, lastModel: null, ctxUsed: null,
  });
  await archiveProject(ctx, b.topicId);
  const names = listProjects(ctx).map((p) => p.name);
  expect(names).toContain("keep");
  expect(names).not.toContain("drop");
  expect(names).not.toContain("General");
});
