import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { makeAssistant } from "../src/assistant";
import { Db } from "../src/db";
import type { ProjectsCtx } from "../src/projects";
import { FakeApi } from "./helpers";

function setup() {
  const api = new FakeApi();
  const db = new Db(":memory:");
  const ctx: ProjectsCtx = {
    api,
    db,
    forumChatId: -100,
    projectsRoot: mkdtempSync(join(tmpdir(), "apehub-")),
    defaultEngine: "claude",
  };
  const githubLogin = { start: async () => "🔐 GitHub: открой ссылку, код ABCD-1234" };
  return { ...makeAssistant(ctx, { githubLogin }), api, db };
}

function textOf(r: { content: { type: "text"; text: string }[] }): string {
  return r.content.map((c) => c.text).join("\n");
}

test("create_project tool creates a project", async () => {
  const { handlers, api } = setup();
  const r = await handlers.create_project({ name: "Alpha" });
  expect(api.topics[0]?.name).toBe("Alpha");
  expect(textOf(r)).toContain("Alpha");
});

test("list_projects reflects created projects", async () => {
  const { handlers } = setup();
  await handlers.create_project({ name: "Alpha" });
  await handlers.create_project({ name: "Beta", engine: "codex" });
  const r = textOf(await handlers.list_projects());
  expect(r).toContain("Alpha");
  expect(r).toContain("Beta — codex");
});

test("archive_project closes and reports; unknown name is handled", async () => {
  const { handlers, api } = setup();
  await handlers.create_project({ name: "Gamma" });
  expect(textOf(await handlers.archive_project({ name: "Gamma" }))).toContain("Archived");
  expect(api.closed).toHaveLength(1);
  expect(textOf(await handlers.archive_project({ name: "nope" }))).toContain("No project");
});

test("github_login tool starts the device flow", async () => {
  const { handlers } = setup();
  expect(textOf(await handlers.github_login())).toContain("ABCD-1234");
});

test("server exposes the orchestration tools", () => {
  const { server } = setup();
  expect(server).toBeDefined();
  // createSdkMcpServer returns an sdk-type server config
  expect((server as any).type).toBe("sdk");
});
