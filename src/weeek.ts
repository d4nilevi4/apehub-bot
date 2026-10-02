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

/** Drop keys whose value is undefined, so a PATCH/POST only sends what was given. */
export function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

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
    version: "1.1.0",
    tools: [
      tool("weeek_list_projects", "List Weeek projects in the workspace.", {}, async () => {
        const j = await call("GET", "/tm/projects");
        return asText(JSON.stringify(j.projects ?? j).slice(0, 2000));
      }),

      tool(
        "weeek_list_members",
        "List workspace members (id, name, email, role). Use a member id as an assignee for tasks.",
        {},
        async () => {
          const j = await call("GET", "/ws/members");
          const members = (Array.isArray(j.members) ? j.members : []).map((m: any) => ({
            id: m.id,
            name: [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email,
            email: m.email,
            role: m.roleType,
          }));
          return asText(JSON.stringify(members).slice(0, 2500));
        },
      ),

      tool(
        "weeek_list_boards",
        "List boards in a project (id, name).",
        { projectId: z.number().describe("Project id") },
        async (a) => {
          const j = await call("GET", `/tm/boards?projectId=${a.projectId}`);
          return asText(JSON.stringify(j.boards ?? j).slice(0, 2000));
        },
      ),

      tool(
        "weeek_list_board_columns",
        "List the columns of a board — use a column id to place a task on the board.",
        { boardId: z.number().describe("Board id") },
        async (a) => {
          const j = await call("GET", `/tm/board-columns?boardId=${a.boardId}`);
          return asText(JSON.stringify(j.boardColumns ?? j.columns ?? j).slice(0, 2000));
        },
      ),

      tool(
        "weeek_create_board",
        "Create a board in a project.",
        {
          name: z.string().describe("Board name"),
          projectId: z.number().describe("Project id"),
        },
        async (a) => {
          const j = await call("POST", "/tm/boards", { name: a.name, projectId: a.projectId });
          return asText(`Создана доска: ${JSON.stringify(j.board ?? j).slice(0, 500)}`);
        },
      ),

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
        "Create a Weeek task. Optionally place it on a board/column, assign members (ids from weeek_list_members), and set a due date (YYYY-MM-DD).",
        {
          title: z.string().describe("Task title"),
          projectId: z.number().optional().describe("Project id to create the task in"),
          description: z.string().optional(),
          boardId: z.number().optional().describe("Board to place the task on"),
          boardColumnId: z.number().optional().describe("Column on that board"),
          assignees: z.array(z.string()).optional().describe("Member ids to assign"),
          dueDate: z.string().optional().describe("Due date, YYYY-MM-DD"),
          parentId: z.number().optional().describe("Parent task id → creates a subtask"),
          priority: z.number().optional().describe("Priority level 0–3"),
          tags: z.array(z.number()).optional().describe("Tag ids from weeek_list_tags"),
        },
        async (a) => {
          const j = await call(
            "POST",
            "/tm/tasks",
            clean({
              title: a.title,
              projectId: a.projectId,
              description: a.description,
              boardId: a.boardId,
              boardColumnId: a.boardColumnId,
              assignees: a.assignees,
              dueDate: a.dueDate,
              parentId: a.parentId,
              priority: a.priority,
              tags: a.tags,
            }),
          );
          return asText(`Создана задача: ${JSON.stringify(j.task ?? j).slice(0, 500)}`);
        },
      ),

      tool(
        "weeek_update_task",
        "Update a task. `assignees` are member ids from weeek_list_members and REPLACE the current assignee list. Other fields (due date, column, title, complete) change only if passed.",
        {
          taskId: z.number().describe("Task id"),
          title: z.string().optional(),
          description: z.string().optional(),
          assignees: z.array(z.string()).optional().describe("Member ids from weeek_list_members — replaces the assignee list"),
          dueDate: z.string().optional().describe("Due date, YYYY-MM-DD"),
          boardColumnId: z.number().optional(),
          isCompleted: z.boolean().optional(),
          priority: z.number().optional().describe("Priority level 0–3"),
          tags: z.array(z.number()).optional().describe("Tag ids from weeek_list_tags (replaces the list)"),
          customFields: z
            .array(z.object({ id: z.string(), value: z.string() }))
            .optional()
            .describe("Set custom-field values; value format depends on the field type (text=string, select=option id)"),
        },
        async (a) => {
          const { taskId, assignees, ...rest } = a;
          const done: string[] = [];
          const body = clean(rest);
          if (Object.keys(body).length) {
            const j = await call("PUT", `/tm/tasks/${taskId}`, body);
            done.push(JSON.stringify(j.task ?? j).slice(0, 250));
          }
          if (assignees) {
            // Weeek keeps assignees on a sub-resource; PUT /tm/tasks/{id} silently ignores them.
            const j = await call("POST", `/tm/tasks/${taskId}/assignees`, { assignees });
            done.push(`assignees=${JSON.stringify(j.task?.assignees ?? j.assignees ?? assignees)}`);
          }
          return asText(`Обновлено: ${done.join(" | ") || "(нет полей для изменения)"}`);
        },
      ),

      tool("weeek_list_tags", "List workspace tags (id, title) — pass a tag id to a task's `tags`.", {}, async () => {
        const j = await call("GET", "/ws/tags");
        const tags = (Array.isArray(j.tags) ? j.tags : []).map((t: any) => ({ id: t.id, title: t.title }));
        return asText(JSON.stringify(tags).slice(0, 1800));
      }),

      tool(
        "weeek_list_comments",
        "List a task's comments.",
        { taskId: z.number().describe("Task id") },
        async (a) => {
          const j = await call("GET", `/tm/tasks/${a.taskId}/comments`);
          return asText(JSON.stringify(j.comments ?? j).slice(0, 2500));
        },
      ),

      tool(
        "weeek_add_comment",
        "Add a comment to a task (markdown).",
        { taskId: z.number().describe("Task id"), markdown: z.string().describe("Comment body (markdown)") },
        async (a) => {
          const j = await call("POST", `/tm/tasks/${a.taskId}/comments`, { markdown: a.markdown });
          return asText(`Комментарий добавлен: ${JSON.stringify(j.comment ?? j).slice(0, 300)}`);
        },
      ),

      tool(
        "weeek_log_time",
        "Log a time entry on a task. `duration` is in minutes; `userId` comes from weeek_list_members.",
        {
          taskId: z.number().describe("Task id"),
          userId: z.string().describe("Member id (whose time this is)"),
          date: z.string().describe("Date, YYYY-MM-DD"),
          duration: z.number().describe("Minutes spent"),
        },
        async (a) => {
          const j = await call("POST", `/tm/tasks/${a.taskId}/time-entries`, {
            userId: a.userId,
            date: a.date,
            duration: a.duration,
          });
          return asText(`Время записано: ${JSON.stringify(j.data ?? j).slice(0, 300)}`);
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
  "mcp__weeek__weeek_list_members",
  "mcp__weeek__weeek_list_boards",
  "mcp__weeek__weeek_list_board_columns",
  "mcp__weeek__weeek_create_board",
  "mcp__weeek__weeek_list_tasks",
  "mcp__weeek__weeek_create_task",
  "mcp__weeek__weeek_update_task",
  "mcp__weeek__weeek_list_tags",
  "mcp__weeek__weeek_list_comments",
  "mcp__weeek__weeek_add_comment",
  "mcp__weeek__weeek_log_time",
  "mcp__weeek__weeek_complete_task",
];
