import { mkdirSync } from "node:fs";
import type { EngineName } from "./config";
import type { Db, Project } from "./db";

/** The slice of grammY's bot.api that project lifecycle needs. */
export interface ProjectsApi {
  createForumTopic(chatId: number, name: string, opts?: unknown): Promise<{ message_thread_id: number }>;
  closeForumTopic(chatId: number, messageThreadId: number, opts?: unknown): Promise<unknown>;
  sendMessage(chatId: number, text: string, opts?: unknown): Promise<unknown>;
}

export interface ProjectsCtx {
  api: ProjectsApi;
  db: Db;
  forumChatId: number;
  projectsRoot: string;
  defaultEngine: EngineName;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

export async function createProject(
  ctx: ProjectsCtx,
  name: string,
  engine?: EngineName,
): Promise<Project> {
  const topic = await ctx.api.createForumTopic(ctx.forumChatId, name);
  const topicId = topic.message_thread_id;
  const cwd = `${ctx.projectsRoot}/${slugify(name)}-${topicId}`;
  mkdirSync(cwd, { recursive: true });
  const now = Date.now();
  const project: Project = {
    topicId,
    name,
    engine: engine ?? ctx.defaultEngine,
    cwd,
    sessionId: null,
    state: "idle",
    createdAt: now,
    updatedAt: now,
    model: null,
    autocompact: true,
    seed: null,
    lastModel: null,
    ctxUsed: null,
  };
  ctx.db.upsertProject(project);
  await ctx.api.sendMessage(
    ctx.forumChatId,
    `🐒 Проект *${name}* создан (движок: ${project.engine}). Пишите сюда — я разбужу сессию.`,
    { message_thread_id: topicId, parse_mode: "Markdown" },
  );
  return project;
}

export async function archiveProject(ctx: ProjectsCtx, topicId: number): Promise<void> {
  ctx.db.setState(topicId, "archived");
  try {
    await ctx.api.closeForumTopic(ctx.forumChatId, topicId);
  } catch {
    /* topic may already be closed/gone */
  }
}

export function listProjects(ctx: ProjectsCtx): Project[] {
  return ctx.db.listProjects().filter((p) => p.topicId > 0 && p.state !== "archived");
}
