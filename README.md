# Schedule Task MCP

[![npm version](https://badge.fury.io/js/schedule-task-mcp.svg)](https://www.npmjs.com/package/schedule-task-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Schedule Task MCP is a scheduled-task management server that speaks the Model Context Protocol (MCP). It lets any MCP-aware agent create, inspect, and run jobs that trigger on intervals, cron expressions, or one-time dates, while persisting state in SQLite and returning rich task summaries that are easy for humans to read.

## ✨ Highlights

- **Natural-language friendly** – Designed so agents can take user phrases like “every morning at 9:30 send me an AI briefing” and turn them into actionable schedules.
- **Multiple trigger styles** – Interval, cron, and one-time date triggers are all supported, plus delay-based shortcuts (e.g., “in 30 minutes”).
- **Rich responses** – Every task operation returns a detailed Markdown summary *and* the raw JSON payload for downstream automation.
- **SQLite persistence** – Tasks live in `~/.schedule-task-mcp/tasks.db`; legacy `tasks.json` files are migrated automatically on first run.
- **Sampling-aware** – When `agent_prompt` is provided, the scheduler can call back into the agent via MCP sampling to execute natural-language instructions.

## 📦 Installation

### Via npm

```bash
npm install -g schedule-task-mcp
```

### From source

```bash
git clone https://github.com/liao1fan/schedule-task-mcp.git
cd schedule-task-mcp
npm install
npm run build
```

## 🚀 Registering the MCP Server

Add the server to your MCP client configuration. If you rely on the npm package, npx will fetch the latest build for you:

```json
{
  "mcpServers": {
    "schedule-task-mcp": {
      "command": "npx",
      "args": ["-y", "schedule-task-mcp"]
    }
  }
}
```

When developing from a local checkout, point the client to your compiled `dist/index.js`:

```json
{
  "mcpServers": {
    "schedule-task-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/schedule-task-mcp/dist/index.js"]
    }
  }
}
```

You can inject environment variables directly from the MCP configuration by adding an `env` block. For example:

```json
{
  "mcpServers": {
    "schedule-task-mcp": {
      "command": "npx",
      "args": ["-y", "schedule-task-mcp"],
      "env": {
        "SCHEDULE_TASK_TIMEZONE": "Asia/Shanghai",
        "SCHEDULE_TASK_DB_PATH": "~/scheduler/tasks.db",
        "SCHEDULE_TASK_SAMPLING_TIMEOUT": "300000"
      }
    }
  }
}
```

Any variables listed under `env` override the process defaults, so each MCP client can have its own scheduler settings without touching global shell configuration.

## ⚙️ Environment Variables

| Variable | Description |
| --- | --- |
| `SCHEDULE_TASK_DB_PATH` | Override the SQLite location (default `~/.schedule-task-mcp/tasks.db`). A legacy `tasks.json` found in the same folder is migrated once. |
| `SCHEDULE_TASK_TIMEZONE` | Force a timezone when formatting `*_local` timestamps; defaults to the host timezone. |
| `SCHEDULE_TASK_SAMPLING_TIMEOUT` | Timeout in milliseconds for `sampling/createMessage` calls (default `180000`, i.e., 3 minutes). |

## 🧰 Core Tools

All tools are exposed through MCP. While arguments are shown for completeness, most agents can rely on natural-language prompts; the server will parse scheduling phrases automatically.

| Tool | Purpose | Typical natural-language prompt |
| --- | --- | --- |
| `create_task` | Create a new schedule. Accepts `name`, `trigger_type`, `trigger_config`, and optional `agent_prompt`. | “Every weekday at 9am, check for new videos and email me the AI briefing.” |
| `list_tasks` | Display every task with status and next run. | “Show me all my scheduled jobs.” |
| `get_task` | Inspect a single task by ID. | “Give me the details for task-123.” |
| `update_task` | Modify an existing task (any field supported by `create_task`). | “Change task-123 so it runs every 2 hours instead.” |
| `delete_task` | Remove a task permanently. | “Delete task-123.” |
| `pause_task` / `resume_task` | Toggle execution without deleting. | “Pause task-123.” / “Resume task-123.” |
| `execute_task` | Run immediately (manual trigger). | “Run task-123 right now.” |
| `clear_task_history` | Wipe stored history for a task while keeping it scheduled. | “Clear the run history for task-123.” |
| `get_current_time` | Return the current time in the configured timezone. | “What time is it for the scheduler?” |

Every response includes:

- `summary`: a Markdown bullet list summarising name, ID, trigger, state, last/next execution, and agent instructions.
- `detail`: the raw `describeTask` JSON, including convenience fields such as `next_run_local`, `last_run_local`, and `trigger_config_local` for date triggers.

## 🧪 Usage Examples

- **Interval** – “Every 30 minutes, run ‘Check system health’.”
- **Cron** – “At 2 o’clock every morning, run ‘Daily backup’.”
- **One-time** – “Remind me about ‘Product launch meeting’ this Friday at 2 PM.”

The server fills in default names if omitted, parses the timing phrase, and stores any natural-language instruction into `agent_prompt` for later sampling.

## 🔧 Trigger Reference

### Interval

Use when you need a fixed gap between runs. `trigger_config` accepts any combination of `seconds`, `minutes`, `hours`, or `days`:

```json
{
  "trigger_type": "interval",
  "trigger_config": {
    "minutes": 30
  }
}
```

### Cron

For calendar-based repetition, supply a five-field cron expression. A few handy examples:

- `* * * * *` – every minute
- `0 * * * *` – hourly
- `0 9 * * *` – every day at 09:00
- `0 9 * * 1` – Mondays at 09:00
- `0 0 1 * *` – the first day of each month at midnight

### Date / Delay

For one-offs, either provide an explicit ISO timestamp or relative delay fields:

```json
{
  "trigger_type": "date",
  "trigger_config": {
    "delay_minutes": 10
  }
}
```

If the supplied timestamp is in the past, the server automatically adjusts it (using the delay if present, otherwise `now + 1s`). Date-based tasks mark themselves complete once they run.

## 🗄️ Storage

- Default database: `~/.schedule-task-mcp/tasks.db`
- A legacy `tasks.json` in the same folder is migrated to SQLite the first time the new server runs (backup saved as `tasks.json.bak`).

## 🔌 Integration Notes

You can still attach `mcp_server`, `mcp_tool`, and `mcp_arguments` to a task for future MCP-to-MCP orchestration. At present the scheduler doesn’t call other servers directly; instead, prefer `agent_prompt` so the agent can coordinate follow-up actions through sampling.

## 🛣️ Roadmap

- [ ] Task dependencies
- [ ] Extended execution history and search
- [ ] Webhooks / notifications on completion
- [ ] Retry policies
- [ ] Web dashboard for interactive management

## 🤝 Contributing

PRs are welcome! Please file an issue or open a pull request with improvements or bug fixes.

## 📄 License

[MIT License](LICENSE)

## 🙏 Acknowledgements

- [Model Context Protocol](https://modelcontextprotocol.io/) – specification and reference ecosystem
- [node-cron](https://github.com/node-cron/node-cron) – cron implementation used under the hood
- [APScheduler](https://apscheduler.readthedocs.io/) – inspiration for the scheduling model
