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

// Default database path
const DEFAULT_DB_PATH = path.join(os.homedir(), '.schedule-task-mcp', 'tasks.json');
const DB_PATH = process.env.SCHEDULE_TASK_DB_PATH || DEFAULT_DB_PATH;

// Initialize scheduler
const scheduler = new TaskScheduler({ dbPath: DB_PATH });

// Create MCP server
const server = new Server(
  {
    name: 'schedule-task-mcp',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Define tools
const tools: Tool[] = [
  {
    name: 'create_task',
    description: 'Create a new scheduled task with interval, cron, or date trigger',
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
          type: 'object',
          description: 'Trigger configuration. For interval: {minutes, hours, days}. For cron: {expression}. For date: {run_date}'
        },
        mcp_server: {
          type: 'string',
          description: 'MCP server name to call (optional)'
        },
        mcp_tool: {
          type: 'string',
          description: 'MCP tool name to call (optional)'
        },
        mcp_arguments: {
          type: 'object',
          description: 'Arguments to pass to the MCP tool (optional)'
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
      properties: {}
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
  }
];

// Tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'create_task': {
        const task = await scheduler.createTask({
          name: args?.name as string,
          trigger_type: args?.trigger_type as 'interval' | 'cron' | 'date',
          trigger_config: args?.trigger_config as Record<string, any>,
          mcp_server: args?.mcp_server as string | undefined,
          mcp_tool: args?.mcp_tool as string | undefined,
          mcp_arguments: args?.mcp_arguments as Record<string, any> | undefined,
        });

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
        const tasks = scheduler.listTasks();

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
        const taskId = args?.task_id as string;
        const task = scheduler.getTask(taskId);

        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }

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
        const taskId = args?.task_id as string;
        const updates: any = {};

        if (args?.name) updates.name = args.name;
        if (args?.trigger_type) updates.trigger_type = args.trigger_type;
        if (args?.trigger_config) updates.trigger_config = args.trigger_config;
        if (args?.mcp_server) updates.mcp_server = args.mcp_server;
        if (args?.mcp_tool) updates.mcp_tool = args.mcp_tool;
        if (args?.mcp_arguments) updates.mcp_arguments = args.mcp_arguments;

        const task = await scheduler.updateTask(taskId, updates);

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
        const taskId = args?.task_id as string;
        const deleted = await scheduler.deleteTask(taskId);

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

      case 'pause_task': {
        const taskId = args?.task_id as string;
        const task = await scheduler.pauseTask(taskId);

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
        const taskId = args?.task_id as string;
        const task = await scheduler.resumeTask(taskId);

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
        const taskId = args?.task_id as string;
        const result = await scheduler.executeTask(taskId);

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
  await scheduler.initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Schedule Task MCP Server running on stdio');
  console.error(`Database path: ${DB_PATH}`);

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
