import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { archiveProject, createProject, listProjects, type ProjectsCtx } from "./projects";

type TextResult = { content: { type: "text"; text: string }[] };
const text = (s: string): TextResult => ({ content: [{ type: "text", text: s }] });

/**
 * The General-topic assistant's orchestration tools. Handlers are exported so
 * they can be unit-tested without going through the MCP transport. `archive_project`
 * is intentionally left out of the session's allowlist so it prompts for confirmation.
 */
export function makeAssistant(ctx: ProjectsCtx) {
  const handlers = {
    create_project: async (a: { name: string; engine?: "claude" | "opencode" | "codex" }) => {
      const p = await createProject(ctx, a.name, a.engine);
      return text(`Created project "${p.name}" (topic ${p.topicId}, engine ${p.engine}).`);
    },
    list_projects: async () => {
      const ps = listProjects(ctx);
      return text(ps.length ? ps.map((p) => `• ${p.name} — ${p.engine} — ${p.state}`).join("\n") : "No projects yet.");
    },
    project_status: async (a: { name: string }) => {
      const p = findByName(ctx, a.name);
      return text(
        p
          ? `${p.name}: ${p.state}, engine ${p.engine}, session ${p.sessionId ?? "cold"}`
          : `No project named "${a.name}".`,
      );
    },
    archive_project: async (a: { name: string }) => {
      const p = findByName(ctx, a.name);
      if (!p) return text(`No project named "${a.name}".`);
      await archiveProject(ctx, p.topicId);
      return text(`Archived "${p.name}".`);
    },
  };

  const server = createSdkMcpServer({
    name: "apehub",
    version: "1.0.0",
    tools: [
      tool(
        "create_project",
        "Create a new project — a new forum topic the user can open to work in.",
        {
          name: z.string().describe("Project name / topic title"),
          engine: z.enum(["claude", "opencode", "codex"]).optional().describe("Coding engine (default claude)"),
        },
        handlers.create_project,
      ),
      tool("list_projects", "List the user's active projects.", {}, handlers.list_projects),
      tool(
        "project_status",
        "Show the status of one project by name.",
        { name: z.string() },
        handlers.project_status,
      ),
      tool(
        "archive_project",
        "Archive (close) a project topic. Destructive — the user is asked to confirm.",
        { name: z.string() },
        handlers.archive_project,
      ),
    ],
  });

  return { handlers, server };
}

function findByName(ctx: ProjectsCtx, name: string) {
  return listProjects(ctx).find((p) => p.name.toLowerCase() === name.toLowerCase());
}
