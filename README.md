# apehub-bot

Per-user Telegram bot for the **ape-hub** platform. One bot per user, bound to a Telegram
**forum supergroup** where each **topic = a project**. The bot routes messages to per-project
AI coding sessions, wakes/sleeps them on demand, and surfaces the agent's questions and
permission prompts as inline buttons so nothing ever blocks on a terminal.

## How it works
- **Topic = project.** Each forum topic maps to a project with its own working dir, engine, and
  resumable session. Any message wakes the session (`resume`); it goes cold (0 RAM) when idle.
- **General topic = assistant.** The General topic is a concierge agent with orchestration tools
  (`create_project`, `list_projects`, `project_status`, `archive_project`). Talk to it in natural
  language; it creates/closes forum topics and reports status. Destructive actions ask to confirm.
- **No terminal blocking.** A custom contract + the `ask_user` tool mean the agent asks the user in
  chat instead of waiting on stdin. Tool permissions become ✅/⛔️ inline buttons (`canUseTool`).
- **Engines.** `claude` is live (Claude Agent SDK). `opencode` / `codex` are stubs, fixed per project.

## Stack
Bun · [grammY](https://grammy.dev) · TypeScript · `bun:sqlite` · `@anthropic-ai/claude-agent-sdk`

## Run (dev)
```sh
cp .env.example .env   # fill BOT_TOKEN + FORUM_CHAT_ID
bun install
export ANTHROPIC_API_KEY=...   # dev only; prod uses systemd LoadCredential
bun run start
```

## Test
```sh
bun test          # full suite (engine mocked; no network, no API key needed)
bun run typecheck # tsc --noEmit
```

## Security
No secrets live in this repo. The bot reads only its own `BOT_TOKEN`. The model API key never
sits in the bot's config — systemd injects it into sessions via `LoadCredential`
(`$CREDENTIALS_DIRECTORY/anthropic`). Per-user keys, DB, and working dirs are isolated per Unix user.

## Commands
- `/ping` — health check
- `/whereami` — reports `chat_id` and `topic_id`
- everything else: just talk (General → assistant, a topic → that project's agent)
