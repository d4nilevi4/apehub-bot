import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveWeeekToken } from "./config";

export const WEEEK_DEFAULT_BASE = "https://api.weeek.net/public/v1";

/**
 * One Weeek Public API call. Bearer token = the user's own token, so every action
 * is attributed to that user. On a non-2xx, throws with the API's error body so the
 * agent (and we) can see exactly what Weeek rejected — paths/fields are easy to fix.
 */
export async function weeekRequest(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<any> {
  const res = await fetchFn(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { raw };
  }
  if (!res.ok) throw new Error(`Weeek ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const asText = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * Per-user Weeek MCP server handed to sessions. The token is read fresh from the
 * gateway (credsDir) on each call — so /login weeek takes effect without a restart,
 * and the model never sees the token. Claude sessions only (in-process SDK MCP).
 */
export function makeWeeekServer(credsDir: string, base: string = WEEEK_DEFAULT_BASE) {
  const token = (): string => {
    const t = resolveWeeekToken(credsDir);
    if (!t) throw new Error("Weeek не подключён — /login weeek");
    return t;
  };
  const call = (method: string, path: string, body?: unknown) => weeekRequest(base, token(), method, path, body);

  return createSdkMcpServer({
    name: "weeek",
    version: "1.0.0",
    tools: [
      tool("weeek_list_projects", "List Weeek projects in the workspace.", {}, async () => {
        const j = await call("GET", "/tm/projects");
        return asText(JSON.stringify(j.projects ?? j).slice(0, 2000));
      }),
      tool(
        "weeek_list_tasks",
        "List Weeek tasks, optionally filtered by project id.",
        { projectId: z.number().optional().describe("Weeek project id") },
        async (a) => {
          const j = await call("GET", `/tm/tasks${a.projectId ? `?projectId=${a.projectId}` : ""}`);
          return asText(JSON.stringify(j.tasks ?? j).slice(0, 3000));
        },
      ),
      tool(
        "weeek_create_task",
        "Create a Weeek task (attributed to the logged-in user).",
        {
          title: z.string().describe("Task title"),
          projectId: z.number().optional().describe("Project id to create the task in"),
          description: z.string().optional(),
        },
        async (a) => {
          const j = await call("POST", "/tm/tasks", { title: a.title, projectId: a.projectId, description: a.description });
          return asText(`Создана задача: ${JSON.stringify(j.task ?? j).slice(0, 500)}`);
        },
      ),
      tool(
        "weeek_complete_task",
        "Mark a Weeek task completed by its id.",
        { taskId: z.number().describe("Task id") },
        async (a) => {
          const j = await call("PUT", `/tm/tasks/${a.taskId}`, { isCompleted: true });
          return asText(`Обновлено: ${JSON.stringify(j.task ?? j).slice(0, 300)}`);
        },
      ),
    ],
  });
}

export const WEEEK_TOOLS = [
  "mcp__weeek__weeek_list_projects",
  "mcp__weeek__weeek_list_tasks",
  "mcp__weeek__weeek_create_task",
  "mcp__weeek__weeek_complete_task",
];
