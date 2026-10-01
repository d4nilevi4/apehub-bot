# apehub-bot

Per-user Telegram bot for the **ape-hub** platform. One bot per user, bound to a Telegram
**forum supergroup** where each **topic = a project**. The bot routes messages to per-project
AI coding sessions (Claude Code / opencode / codex), wakes and sleeps them on demand, and
surfaces the agent's questions as inline buttons so nothing ever blocks on a terminal.

> Status: **early build.** Increment 1 = Telegram connectivity (`/ping`, `/whereami`).

## Stack
- [Bun](https://bun.sh) runtime
- [grammY](https://grammy.dev) Telegram framework
- TypeScript
- `bun:sqlite` for local state (project ↔ topic, session registry)

## Run (dev)
```sh
cp .env.example .env   # fill in BOT_TOKEN from @BotFather
bun install
bun run start
```

## Security
No secrets live in this repo. The bot reads only its own `BOT_TOKEN` from `.env` (gitignored).
Per-user API keys (model, search, etc.) never pass through the bot — they are injected into the
agent sessions by systemd and held by a per-user capabilities gateway.

## Commands (increment 1)
- `/ping` — health check
- `/whereami` — reports `chat_id` and `topic_id` (handy while wiring up the forum)
