#!/usr/bin/env node

/**
 * Schedule Task MCP Server
 * A universal scheduled task management MCP server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as os from 'os';
import { TaskScheduler } from './scheduler.js';
import * as cron from 'node-cron';
import { formatInTimezone, getSystemTimeZone } from './format.js';

// Default database path and timezone
const DEFAULT_DB_PATH = path.join(os.homedir(), '.schedule-task-mcp', 'tasks.db');
const DB_PATH = process.env.SCHEDULE_TASK_DB_PATH || DEFAULT_DB_PATH;
const TIMEZONE = process.env.SCHEDULE_TASK_TIMEZONE || getSystemTimeZone();


// Initialize scheduler (will receive MCP client after server starts)
let scheduler: TaskScheduler;

type IntervalTriggerConfig = {
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
};

type CronTriggerConfig = {
  expression: string;
};

type DateTriggerConfig = {
  run_date: string;
};

type SupportedTriggerConfig = IntervalTriggerConfig | CronTriggerConfig | DateTriggerConfig;

type SupportedTriggerType = 'interval' | 'cron' | 'date';

function ensureNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value);
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  throw new Error(`Invalid numeric value for ${field}`);
}

function validateIntervalConfig(rawConfig: Record<string, any>): IntervalTriggerConfig {
  const allowedKeys = ['seconds', 'minutes', 'hours', 'days'];
  const config: IntervalTriggerConfig = {};
  let totalMs = 0;

  for (const key of Object.keys(rawConfig)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unknown interval option: ${key}`);
    }
  }

  if ('seconds' in rawConfig) {
    const seconds = ensureNumber(rawConfig.seconds, 'trigger_config.seconds');
    if (seconds < 0.001) {
      throw new Error('Seconds must be greater than 0');
    }
    config.seconds = seconds;
    totalMs += seconds * 1000;
  }

  if ('minutes' in rawConfig) {
    const minutes = ensureNumber(rawConfig.minutes, 'trigger_config.minutes');
    if (minutes < 0.001) {
      throw new Error('Minutes must be greater than 0');
    }
    config.minutes = minutes;
    totalMs += minutes * 60 * 1000;
  }

  if ('hours' in rawConfig) {
    const hours = ensureNumber(rawConfig.hours, 'trigger_config.hours');
    if (hours < 0.001) {
      throw new Error('Hours must be greater than 0');
    }
    config.hours = hours;
    totalMs += hours * 60 * 60 * 1000;
  }

  if ('days' in rawConfig) {
    const days = ensureNumber(rawConfig.days, 'trigger_config.days');
    if (days < 0.001) {
      throw new Error('Days must be greater than 0');
    }
    config.days = days;
    totalMs += days * 24 * 60 * 60 * 1000;
  }

  if (totalMs <= 0) {
    throw new Error('Interval trigger requires at least one positive duration field');
  }

  return config;
}

function validateCronConfig(rawConfig: Record<string, any>): CronTriggerConfig {
  if (typeof rawConfig.expression !== 'string' || rawConfig.expression.trim().length === 0) {
    throw new Error('Cron trigger requires a non-empty expression');
  }

  if (!cron.validate(rawConfig.expression)) {
    throw new Error(`Invalid cron expression: ${rawConfig.expression}`);
  }

  return { expression: rawConfig.expression };
}

function validateDateConfig(rawConfig: Record<string, any>): DateTriggerConfig {
  const config = { ...rawConfig };
  const now = new Date();

  const delayFields: Array<[keyof typeof config, number]> = [
    ['delay_seconds', 1000],
    ['delay_minutes', 60 * 1000],
    ['delay_hours', 60 * 60 * 1000],
    ['delay_days', 24 * 60 * 60 * 1000],
  ];

  let delayMs = 0;
  for (const [field, multiplier] of delayFields) {
    if (config[field] !== undefined) {
      const value = ensureNumber(config[field], `trigger_config.${String(field)}`);
      if (value < 0) {
        throw new Error(`${String(field)} must be >= 0`);
      }
      delayMs += value * multiplier;
      delete config[field];
    }
  }

  let runDate: Date | undefined;

  if (typeof config.run_date === 'string' && config.run_date.trim().length > 0) {
    runDate = new Date(config.run_date);
    if (Number.isNaN(runDate.getTime())) {
      throw new Error(`Invalid ISO date string for run_date: ${config.run_date}`);
    }
  }

  if (!runDate && delayMs > 0) {
    runDate = new Date(now.getTime() + delayMs);
  }

  if (!runDate) {
    throw new Error('Date trigger requires either run_date or delay fields (delay_seconds/minutes/hours/days)');
  }

  if (runDate.getTime() <= now.getTime()) {
    if (delayMs > 0) {
      runDate = new Date(now.getTime() + delayMs);
    } else {
      console.warn('[schedule-task-mcp] run_date was in the past, auto-adjusting to now + 1s');
      runDate = new Date(now.getTime() + 1000);
    }
  }

  return { run_date: runDate.toISOString() };
}

function validateTriggerConfig(triggerType: SupportedTriggerType, rawConfig: any): SupportedTriggerConfig {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('trigger_config must be an object');
  }

  if (triggerType === 'interval') {
    return validateIntervalConfig(rawConfig);
  }
  if (triggerType === 'cron') {
    return validateCronConfig(rawConfig);
  }
  if (triggerType === 'date') {
    return validateDateConfig(rawConfig);
  }
  throw new Error(`Unsupported trigger_type: ${triggerType}`);
}

function sanitizeAgentPrompt(value: any): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('agent_prompt must be a non-empty string when provided');
  }
  return value.trim();
}

function extractAgentPrompt(args: Record<string, any> | undefined): string | undefined {
  const prompt = sanitizeAgentPrompt(args?.agent_prompt);

  if (prompt) {
    return prompt;
  }

  const legacyPrompt = sanitizeAgentPrompt(args?.mcp_arguments?.agent_prompt);
  return legacyPrompt;
}

// Create MCP server
const server = new Server(
  {
    name: 'schedule-task-mcp',
    version: '0.2.0'  // 🎯 Version bump for sampling support
  },
  {
    capabilities: {
      tools: {},
      sampling: {}  // 🎯 Enable sampling capability
    }
  }
);

// Define tools
const tools: Tool[] = [
  {
    name: 'create_task',
    description: 'Create a new scheduled task with interval, cron, or date trigger. Use agent_prompt for AI-powered task execution via MCP Sampling.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Task name/description'
        },
        trigger_type: {
          type: 'string',
          enum: ['interval', 'cron', 'date'],
          description: 'Trigger type: interval (recurring), cron (cron expression), or date (one-time)'
        },
        trigger_config: {
          description: 'Trigger configuration. Choose fields that match the trigger_type.',
          oneOf: [
            {
              title: 'Interval trigger',
              type: 'object',
              properties: {
                seconds: {
                  type: 'number',
                  minimum: 0.001,
                  description: 'Number of seconds between runs'
                },
                minutes: {
                  type: 'number',
                  minimum: 0.001,
                  description: 'Number of minutes between runs'
                },
                hours: {
                  type: 'number',
                  minimum: 0.001,
                  description: 'Number of hours between runs'
                },
                days: {
                  type: 'number',
                  minimum: 0.001,
                  description: 'Number of days between runs'
                }
              },
              additionalProperties: false,
              minProperties: 1,
              description: 'Provide any combination of seconds/minutes/hours/days. Must sum to a positive duration.'
            },
            {
              title: 'Cron trigger',
              type: 'object',
              properties: {
                expression: {
                  type: 'string',
                  description: 'Cron expression (e.g. "0 9 * * *" for 9am daily)'
                }
              },
              required: ['expression'],
              additionalProperties: false
            },
            {
              title: 'Date trigger',
              type: 'object',
              properties: {
                run_date: {
                  type: 'string',
                  format: 'date-time',
                  description: 'ISO 8601 timestamp for one-time execution. Must be in the future.'
                },
                delay_seconds: {
                  type: 'number',
                  minimum: 0,
                  description: 'Delay in seconds before first run (alternative to run_date)'
                },
                delay_minutes: {
                  type: 'number',
                  minimum: 0,
                  description: 'Delay in minutes before first run (alternative to run_date)'
                },
                delay_hours: {
                  type: 'number',
                  minimum: 0,
                  description: 'Delay in hours before first run (alternative to run_date)'
                },
                delay_days: {
                  type: 'number',
                  minimum: 0,
                  description: 'Delay in days before first run (alternative to run_date)'
                }
              },
              additionalProperties: false,
              minProperties: 1,
              description: 'Provide either run_date or delay fields (delay_seconds/minutes/hours/days).'
            }
          ]
        },
        agent_prompt: {
          type: 'string',
          description: 'Primary instruction executed when the task runs (recommended). Extract the user intent **after removing the scheduling phrase**, keep it as natural-language steps (e.g. "检查新视频，整理成AI早报并发送到某邮箱"). Do NOT provide code, function calls, or tool names here.',
          examples: [
            '检查新视频，整理成AI早报并发送到liaofanyishi1@163.com',
            '获取今天的最新视频并生成摘要后发邮件给团队'
          ]
        },
        mcp_server: {
          type: 'string',
          description: 'DEPRECATED: MCP server name to call (use agent_prompt instead)'
        },
        mcp_tool: {
          type: 'string',
          description: 'DEPRECATED: MCP tool name to call (use agent_prompt instead)'
        },
        mcp_arguments: {
          type: 'object',
          description: 'DEPRECATED: Arguments to pass to the MCP tool (use agent_prompt instead)'
        }
      },
      required: ['name', 'trigger_type', 'trigger_config']
    }
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional status filter (scheduled, running, paused, completed, error)',
        }
      }
    }
  },
  {
    name: 'get_task',
    description: 'Get details of a specific task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'update_task',
    description: 'Update an existing task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        name: {
          type: 'string',
          description: 'New task name (optional)'
        },
        trigger_type: {
          type: 'string',
          enum: ['interval', 'cron', 'date'],
          description: 'New trigger type (optional)'
        },
        trigger_config: {
          type: 'object',
          description: 'New trigger configuration (optional)'
        },
        mcp_server: {
          type: 'string',
          description: 'New MCP server name (optional)'
        },
        mcp_tool: {
          type: 'string',
          description: 'New MCP tool name (optional)'
        },
        mcp_arguments: {
          type: 'object',
          description: 'New MCP arguments (optional)'
        },
        agent_prompt: {
          type: 'string',
          description: 'Updated agent prompt instruction (recommended). It should remain the natural-language task description **with scheduling wording removed**, without tool/function syntax.',
          examples: [
            '重新检查最新视频并只整理前3条，再发送邮件给运营',
            '生成AI早报后发到liaofanyishi1@163.com'
          ]
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'clear_task_history',
    description: 'Clear run history and reset last run info for a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to clear history for'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'pause_task',
    description: 'Pause a task (disable execution)',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'execute_task',
    description: 'Execute a task immediately (manual trigger)',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_current_time',
    description: 'Get current date and time in the configured timezone (SCHEDULE_TASK_TIMEZONE env var, defaults to Asia/Shanghai). Returns ISO 8601 format timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['iso', 'readable'],
          description: 'Output format: "iso" for ISO 8601 (default), "readable" for human-readable format'
        }
      }
    }
  }
];

// Tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'create_task': {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) {
          throw new Error('Task name is required');
        }

        const triggerType = args.trigger_type as SupportedTriggerType;
        if (!['interval', 'cron', 'date'].includes(triggerType)) {
          throw new Error('trigger_type must be one of interval, cron, date');
        }

        const triggerConfig = validateTriggerConfig(triggerType, args.trigger_config);
        const agentPrompt = extractAgentPrompt(args);

        const created = await scheduler.createTask({
          name: args.name.trim(),
          trigger_type: triggerType,
          trigger_config: triggerConfig as Record<string, any>,
          mcp_server: args.mcp_server as string | undefined,
          mcp_tool: args.mcp_tool as string | undefined,
          mcp_arguments: args.mcp_arguments as Record<string, any> | undefined,
          agent_prompt: agentPrompt,
        });

        const task = scheduler.describeTask(created);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'list_tasks': {
        const statusFilter = args.status as string | undefined;
        const tasks = scheduler
          .listTasks()
          .filter((task) => (statusFilter ? task.status === statusFilter : true))
          .map((task) => scheduler.describeTask(task));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                count: tasks.length,
                tasks
              }, null, 2)
            }
          ]
        };
      }

      case 'get_task': {
        const taskId = args.task_id;
        if (typeof taskId !== 'string' || taskId.trim().length === 0) {
          throw new Error('task_id is required');
        }

        const taskRecord = scheduler.getTask(taskId);

        if (!taskRecord) {
          throw new Error(`Task not found: ${taskId}`);
        }

        const task = scheduler.describeTask(taskRecord);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'update_task': {
        const taskIdRaw = args.task_id;
        if (typeof taskIdRaw !== 'string' || taskIdRaw.trim().length === 0) {
          throw new Error('task_id is required');
        }
        const taskId = taskIdRaw.trim();

        const existingTask = scheduler.getTask(taskId);
        if (!existingTask) {
          throw new Error(`Task not found: ${taskId}`);
        }

        const updates: any = {};

        if (typeof args.name === 'string' && args.name.trim().length > 0) {
          updates.name = args.name.trim();
        }

        const hasTriggerType = typeof args.trigger_type === 'string';
        const nextTriggerType = (hasTriggerType ? args.trigger_type : existingTask.trigger_type) as SupportedTriggerType;
        if (!['interval', 'cron', 'date'].includes(nextTriggerType)) {
          throw new Error('trigger_type must be one of interval, cron, date');
        }

        if (hasTriggerType) {
          updates.trigger_type = nextTriggerType;
        }

        const hasTriggerConfig = Object.prototype.hasOwnProperty.call(args, 'trigger_config');
        if (hasTriggerConfig) {
          updates.trigger_config = validateTriggerConfig(nextTriggerType, args.trigger_config) as Record<string, any>;
        } else if (hasTriggerType) {
          throw new Error('Updating trigger_type requires providing trigger_config');
        }

        if (typeof args.mcp_server === 'string') updates.mcp_server = args.mcp_server;
        if (typeof args.mcp_tool === 'string') updates.mcp_tool = args.mcp_tool;
        if (Object.prototype.hasOwnProperty.call(args, 'mcp_arguments')) updates.mcp_arguments = args.mcp_arguments;
        if (Object.prototype.hasOwnProperty.call(args, 'agent_prompt')) {
          updates.agent_prompt = sanitizeAgentPrompt(args.agent_prompt);
        }

        const updated = await scheduler.updateTask(taskId, updates);
        const task = scheduler.describeTask(updated);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'delete_task': {
        const deleteId = args.task_id;
        if (typeof deleteId !== 'string' || deleteId.trim().length === 0) {
          throw new Error('task_id is required');
        }
        const deleted = await scheduler.deleteTask(deleteId.trim());

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: deleted,
                message: deleted ? 'Task deleted' : 'Task not found'
              }, null, 2)
            }
          ]
        };
      }

      case 'clear_task_history': {
        const clearId = args.task_id;
        if (typeof clearId !== 'string' || clearId.trim().length === 0) {
          throw new Error('task_id is required');
        }

        const cleared = await scheduler.clearTaskHistory(clearId.trim());
        const task = scheduler.describeTask(cleared);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Task history cleared',
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'pause_task': {
        const pauseId = args.task_id;
        if (typeof pauseId !== 'string' || pauseId.trim().length === 0) {
          throw new Error('task_id is required');
        }
        const paused = await scheduler.pauseTask(pauseId.trim());
        const task = scheduler.describeTask(paused);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Task paused',
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'resume_task': {
        const resumeId = args.task_id;
        if (typeof resumeId !== 'string' || resumeId.trim().length === 0) {
          throw new Error('task_id is required');
        }
        const resumed = await scheduler.resumeTask(resumeId.trim());
        const task = scheduler.describeTask(resumed);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Task resumed',
                task
              }, null, 2)
            }
          ]
        };
      }

      case 'execute_task': {
        const executeId = args.task_id;
        if (typeof executeId !== 'string' || executeId.trim().length === 0) {
          throw new Error('task_id is required');
        }
        const result = await scheduler.executeTask(executeId.trim());

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'get_current_time': {
        const format = typeof args.format === 'string' ? args.format : 'iso';
        const now = new Date();

        // Convert to configured timezone
        const timeInTimezone = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));

        let result;
        if (format === 'readable') {
          result = {
            success: true,
            timezone: TIMEZONE,
            current_time: timeInTimezone.toLocaleString('zh-CN', { timeZone: TIMEZONE }),
            iso_time: timeInTimezone.toISOString(),
            timestamp: timeInTimezone.getTime()
          };
        } else {
          result = {
            success: true,
            timezone: TIMEZONE,
            current_time: timeInTimezone.toISOString(),
            timestamp: timeInTimezone.getTime()
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            stack: error.stack
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 🎯 Initialize scheduler with access to this MCP server for sampling
  scheduler = new TaskScheduler({
    dbPath: DB_PATH,
    mcpServer: server
  });

  await scheduler.initialize();

  console.error('Schedule Task MCP Server running on stdio');
  console.error(`Database path: ${DB_PATH}`);
  console.error('✅ MCP Sampling enabled - tasks with agent_prompt will execute via sampling');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await scheduler.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await scheduler.shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
