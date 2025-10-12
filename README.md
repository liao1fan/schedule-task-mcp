# Schedule Task MCP

[![npm version](https://badge.fury.io/js/schedule-task-mcp.svg)](https://www.npmjs.com/package/schedule-task-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Schedule Task MCP** is a universal scheduled task management MCP (Model Context Protocol) server that allows you to create, manage, and execute scheduled tasks with support for interval, cron, and date-based triggers.

## ✨ Features

- ⏰ **Multiple Trigger Types** - Support for interval, cron expressions, and one-time date triggers
- 🔄 **Task Management** - Create, update, pause, resume, and delete tasks
- 💾 **Persistent Storage** - Tasks are saved to JSON file and restored on restart
- 🎯 **MCP Integration** - Can trigger other MCP tools (extensible architecture)
- 📊 **Status Tracking** - Track last run time, status, and next scheduled run
- 🚀 **Easy to Use** - Simple API through MCP protocol

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

## 🚀 Usage

### Configure MCP Client

This is a standard MCP server that can be used with any MCP client. Configure it in your MCP client's configuration file.

**Example configuration:**

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

Or if installed globally:

```json
{
  "mcpServers": {
    "schedule-task-mcp": {
      "command": "schedule-task-mcp"
    }
  }
}
```

### Environment Variables

- `SCHEDULE_TASK_DB_PATH` - Custom path for tasks database (default: `~/.schedule-task-mcp/tasks.db`)
- `SCHEDULE_TASK_TIMEZONE` - Override the detected system timezone when formatting `*_local` timestamps
- `SCHEDULE_TASK_SAMPLING_TIMEOUT` - Timeout (ms) for `sampling/createMessage` requests (default: `180000`)

## 🛠️ Available Tools

### 1. `create_task`

Create a new scheduled task.

**Parameters:**
- `name` (string, required): Task name/description
- `trigger_type` (string, required): One of `interval`, `cron`, or `date`
- `trigger_config` (object, required): Trigger configuration
  - For `interval`: `{minutes?: number, hours?: number, days?: number}`
  - For `cron`: `{expression: string}` (e.g., `"0 9 * * *"` for daily at 9 AM)
  - For `date`: `{run_date: string}` (ISO date string)
- `mcp_server` (string, optional): MCP server to call
- `mcp_tool` (string, optional): MCP tool to call
- `mcp_arguments` (object, optional): Arguments to pass to the tool

**Example:**
```
Create a task that runs every 5 minutes
```

### 2. `list_tasks`

List all scheduled tasks with their status.

**Example:**
```
List all my scheduled tasks
```

### 3. `get_task`

Get details of a specific task.

**Parameters:**
- `task_id` (string, required): Task ID

**Example:**
```
Show me the details of task task-123456
```

### 4. `update_task`

Update an existing task.

**Parameters:**
- `task_id` (string, required): Task ID
- Any fields from `create_task` (optional)

**Example:**
```
Update task task-123456 to run every 10 minutes instead
```

### 5. `delete_task`

Delete a task permanently.

**Parameters:**
- `task_id` (string, required): Task ID

**Example:**
```
Delete task task-123456
```

### 6. `pause_task`

Pause a task (stop execution without deleting).

**Parameters:**
- `task_id` (string, required): Task ID

**Example:**
```
Pause task task-123456
```

### 7. `resume_task`

Resume a paused task.

**Parameters:**
- `task_id` (string, required): Task ID

**Example:**
```
Resume task task-123456
```

### 8. `execute_task`

Execute a task immediately (manual trigger).

**Parameters:**
- `task_id` (string, required): Task ID

**Example:**
```
Run task task-123456 now
```

## 📖 Usage Examples

### Example 1: Simple Interval Task

```
Create a task named "Check system status" that runs every 30 minutes
```

This creates an interval-based task with trigger configuration:
```json
{
  "name": "Check system status",
  "trigger_type": "interval",
  "trigger_config": {
    "minutes": 30
  }
}
```

### Example 2: Cron-based Task

```
Create a task named "Daily backup" that runs every day at 2 AM using cron expression "0 2 * * *"
```

### Example 3: One-time Task

```
Create a task named "Meeting reminder" that runs once on 2025-10-09T14:00:00Z
```

### Example 4: Task with MCP Tool Integration

```
Create a task that calls the tool "check_new_videos" from server "juya-mcp" every 5 minutes
```

This would create:
```json
{
  "name": "Monitor new videos",
  "trigger_type": "interval",
  "trigger_config": {
    "minutes": 5
  },
  "mcp_server": "juya-mcp",
  "mcp_tool": "check_new_videos",
  "mcp_arguments": {
    "count": 10
  }
}
```

## 🔧 Trigger Types

### Interval Trigger

Recurring tasks that run at fixed intervals.

**Configuration:**
```json
{
  "trigger_type": "interval",
  "trigger_config": {
    "minutes": 30,    // Optional: minutes
    "hours": 2,       // Optional: hours
    "days": 1         // Optional: days
  }
}
```

At least one field (minutes, hours, or days) must be provided.

### Cron Trigger

Tasks scheduled using cron expressions.

**Configuration:**
```json
{
  "trigger_type": "cron",
  "trigger_config": {
    "expression": "0 9 * * *"  // Daily at 9 AM
  }
}
```

**Common cron expressions:**
- `* * * * *` - Every minute
- `0 * * * *` - Every hour
- `0 9 * * *` - Daily at 9 AM
- `0 9 * * 1` - Every Monday at 9 AM
- `0 0 1 * *` - First day of every month at midnight

### Date Trigger

One-time tasks that run at a specific date/time.

**Configuration:**
```json
{
  "trigger_type": "date",
  "trigger_config": {
    "run_date": "2025-10-09T14:00:00Z"  // ISO 8601 format
  }
}
```

Alternatively, omit `run_date` and provide delay fields (`delay_seconds`, `delay_minutes`, `delay_hours`, `delay_days`):
```json
{
  "trigger_type": "date",
  "trigger_config": {
    "delay_minutes": 5
  }
}
```

When a provided `run_date` is in the past, the server automatically adjusts it to the nearest future time (using the supplied delay when available, otherwise `now + 1s`).

Date-based tasks are automatically paused after execution.

## 📂 Task Storage

Tasks are stored in a SQLite database:
- Default: `~/.schedule-task-mcp/tasks.db`
- Custom: Set via `SCHEDULE_TASK_DB_PATH` environment variable
- On first run, any existing `tasks.json` will be migrated automatically (a `.bak` backup is kept)

## 🔌 Integration with Other MCP Servers

Schedule Task MCP can trigger tools from other MCP servers. Simply specify:
- `mcp_server`: The name of the MCP server (as configured in your MCP client)
- `mcp_tool`: The tool name to call
- `mcp_arguments`: Arguments to pass

**Note:** Currently, the MCP protocol doesn't support direct inter-server communication. This feature is designed for future extensibility when such capabilities become available.

## 🛣️ Roadmap

- [ ] Add support for task dependencies
- [ ] Add task execution history/logs
- [ ] Add webhooks for task completion
- [ ] Support for task retry logic
- [ ] Web UI for task management

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

[MIT License](LICENSE)

## 👤 Author

**liao1fan** <liaofanyishi1@gmail.com>

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [node-cron](https://github.com/node-cron/node-cron) - Cron implementation
- [APScheduler](https://apscheduler.readthedocs.io/) - Inspiration for the design

## 📚 Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - Official MCP documentation
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - Official MCP server implementations
- [MCP Clients](https://github.com/modelcontextprotocol) - Various MCP client implementations
