<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="ApeHub logo">
</p>

<h1 align="center">🦍 ApeHub Bot</h1>

<p align="center">
  Персональный Telegram-бот для AI-кодинга: один инстанс на коллегу, форум-супергруппа
  как рабочее пространство, <b>каждый топик = проект</b> со своей AI-сессией.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.x-000?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/grammY-Telegram-2CA5E0?logo=telegram&logoColor=white" alt="grammY">
  <img src="https://img.shields.io/badge/Claude%20Agent%20SDK-0.3-D97757" alt="Claude Agent SDK">
  <img src="https://img.shields.io/badge/tests-93%20passing-3FB950" alt="tests">
</p>

---

## Что это

Бот превращает Telegram-форум в пульт для AI-агентов. Пишешь в топик — просыпается сессия
соответствующего проекта (Claude или Codex), работает в своей рабочей папке, задаёт вопросы и
просит разрешения прямо в чате кнопками. Простаивает — засыпает (0 RAM), контекст сохранён на диске.
Один сервер держит несколько **изолированных** инстансов — по одному на человека.

```mermaid
flowchart LR
  U["👤 Коллега"] -->|"топик = проект"| F["Forum supergroup"]
  F --> B["apehub-bot · grammY"]
  B --> SM["SessionManager<br/>(cold-resume, watchdog)"]
  SM --> E{"Engine"}
  E -->|claude| CA["Claude Agent SDK"]
  E -->|codex| CX["Codex CLI (exec --json)"]
  SM --> M["MCP-серверы:<br/>comms · weeek · broker · skills hub"]
  B -. "✅/⛔ кнопки, вопросы" .-> U
```

## Возможности

- 🧠 **Два движка, один интерфейс.** `claude` (Claude Agent SDK) и `codex` (ChatGPT/Codex CLI) за
  единым `Engine`-швом. Команды универсальны — бот сам понимает, какой движок открыт в топике.
- 💬 **Ничего не висит в терминале.** Вопросы агента приходят как сообщения (`ask_user`), а запросы
  на инструменты — как inline-кнопки ✅/⛔ (`canUseTool`). Есть `/auto` — авто-подтверждение.
- 🔑 **Вход через бота** (`/login`), без перезапуска: токены читаются на лету. Подписка **или**
  API-ключ определяются автоматически по префиксу.
- 🧩 **Хаб скилов/плагинов.** Общий git-маркетплейс грузится в каждую сессию (`options.plugins`);
  `/skills` показывает каталог. Люди подключают тот же репо через `/plugin marketplace add`.
- 📋 **Weeek per-user.** Проекты, доски, колонки, задачи, исполнители, сроки — от имени твоего токена.
- 🏗 **Брокер тяжёлых задач.** Долгие джобы (сборки, рендеры) уходят в очередь с лимитами
  (`systemd-run --user`), агент не блокируется — `/jobs`.
- 😴 **Тёплые/холодные сессии.** Cold-resume по `session_id`; watchdog усыпляет **только** простаивающий
  ход и никогда — работающий агент. Ручной `/sleep`.
- 📊 **Точный контекст.** Шапка `🧮 58k / 1M (6%) ▰▰▱…` в каждом ответе, из того же источника, что
  `/context` в Claude Code (`getContextUsage`). Авто-компакт с настраиваемым порогом (`/autocompact`).
- 🐙 **GitHub per-user.** Device-flow логин; git-операции и авторство коммитов — от имени вошедшего.

## Команды

Видны в меню Telegram (`/`). Работают для текущего движка топика.

| Команда | Что делает |
|---|---|
| `/status` | движок, модель, сессия, контекст %, автокомпакт, авто-режим, GitHub/Weeek |
| `/context` | заполнение окна контекста |
| `/switchmodel [имя]` | сменить модель (без имени — кнопки-пикер) |
| `/engine [claude\|codex]` | сменить движок проекта |
| `/compact` | сжать историю: резюме → свежая сессия |
| `/autocompact on\|off\|<токены>` | авто-сжатие и его порог (напр. `/autocompact 150k`) |
| `/auto on\|off` | выполнять команды без запроса разрешения |
| `/skills` | каталог скилов из маркетплейса |
| `/jobs` | очередь тяжёлых задач (брокер) |
| `/new` | начать новую сессию |
| `/sleep` | усыпить сессию вручную |
| `/stop` | прервать текущий ответ |
| `/login …` | входы (см. ниже) · `/cancel` — отменить ввод |
| `/help` · `/ping` | справка · проверка связи |

## Входы (`/login`)

| | Что прислать |
|---|---|
| `/login claude` | `claude setup-token` (Pro/Max) → `sk-ant-oat…`, либо API-ключ `sk-ant-api…` |
| `/login codex` | содержимое `~/.codex/auth.json` (подписка ChatGPT) или OpenAI API-ключ `sk-…` |
| `/login github` | device flow — заходишь в свой GitHub; git работает от твоего имени |
| `/login weeek` | токен из *workspace → настройки → API*; задачи ставятся от твоего имени |

Сообщение с токеном бот удаляет сразу после сохранения; креды лежат `0600` в каталоге `0700`.

## Движки

| Движок | Статус | Бэкенд | Модели | Окно |
|---|---|---|---|---|
| `claude` | ✅ live | Claude Agent SDK | opus · sonnet · haiku | 1M |
| `codex` | ✅ live | `codex exec --json` + `resume` | gpt-5-codex · gpt-5 · o3 | — |
| `opencode` | 🚧 stub | — | — | — |

## Weeek — инструменты агента

Доступны в Claude-сессиях после `/login weeek`, все действия — от имени токена:

`list_projects` · `list_members` · `list_boards` · `list_board_columns` · `create_board` ·
`list_tasks` · `create_task` (доска/колонка, исполнители, срок) · `update_task` (назначить/передатировать/
перенести/закрыть) · `complete_task`.

## Конфигурация

Через env (`.env` в dev, `~/.config/apehub/bot.env` в проде):

| Переменная | Дефолт | Назначение |
|---|---|---|
| `BOT_TOKEN` | — | токен Telegram-бота (обязательно) |
| `FORUM_CHAT_ID` | — | id форум-супергруппы (обязательно) |
| `DATA_DIR` | `./data` | sqlite + creds + рабочие папки проектов |
| `HUB_DIR` | `/opt/apehub-hub` | клон общего маркетплейса скилов |
| `CONTEXT_WINDOW` | `1000000` | окно модели для шкалы контекста |
| `SLEEP_AFTER_MS` | `1800000` | простой до авто-сна (30 мин) |
| `DEFAULT_ENGINE` | `claude` | движок новых проектов |
| `GITHUB_CLIENT_ID` | — | client id OAuth-app для device flow (публичный) |
| `MODEL` | — | модель по умолчанию |

## Запуск (dev)

```sh
cp .env.example .env     # заполни BOT_TOKEN + FORUM_CHAT_ID
bun install
export ANTHROPIC_API_KEY=...   # только для dev; в проде — /login или systemd LoadCredential
bun run start
```

## Тесты

```sh
bun test           # полный набор (движок замокан; без сети и ключей)
bun run typecheck  # tsc --noEmit
```

## Архитектура (модули)

| Файл | Ответственность |
|---|---|
| `src/sessions.ts` | очередь на топик, cold-resume, watchdog-сон, авто-компакт, сборка MCP + env |
| `src/engine.ts` + `src/engines/*` | `Engine`-шов и реализации (claude/codex/stub) |
| `src/commands.ts` · `src/telegram.ts` | универсальные команды и роутинг grammY |
| `src/bridge.ts` | разрешения-кнопки и `ask_user` |
| `src/login.ts` · `src/github.ts` · `src/config.ts` | хранение кредов, device flow, резолв env |
| `src/weeek.ts` · `src/hub.ts` · `src/broker.ts` | Weeek MCP, маркетплейс скилов, брокер джоб |
| `src/db.ts` | состояние проектов (`bun:sqlite`, авто-миграции) |

## Безопасность

Секретов в репозитории нет. Бот custody'ит креды через `/login` — файлы `0600` в каталоге `0700`,
по одному Unix-юзеру на инстанс (свои sqlite, creds, рабочие папки). Агенты работают под
**непривилегированным** пользователем (без root). Модельный ключ в проде приходит через `/login`
или systemd `LoadCredential`, не лежит в конфиге бота. Доступ к боту = членство в его форум-группе.
`GITHUB_CLIENT_ID` — публичный, не секрет.

## Стек

Bun · [grammY](https://grammy.dev) · TypeScript · `bun:sqlite` · `@anthropic-ai/claude-agent-sdk` · Codex CLI
