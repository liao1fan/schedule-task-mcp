/**
 * Task scheduler with support for interval, cron, and date triggers
 */

import * as cron from 'node-cron';
import cronParser from 'cron-parser';
import { TaskStorage, TaskRecord, TaskStatus, TaskHistoryEntry } from './storage.js';
import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { formatInTimezone, getSystemTimeZone } from './format.js';

const HISTORY_LIMIT = 10;

interface IntervalTriggerConfig {
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
}

export interface SchedulerConfig {
  dbPath: string;
  mcpServer?: Server;  // 🎯 MCP server used to send sampling requests
}

export class TaskScheduler {
  private storage: TaskStorage;
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private intervalTimers: Map<string, NodeJS.Timeout> = new Map();
  private mcpServer?: Server;

  private readonly timeZone: string;
  private readonly samplingTimeoutMs: number;

  constructor(config: SchedulerConfig) {
    this.storage = new TaskStorage(config.dbPath);
    this.mcpServer = config.mcpServer;
    this.timeZone = process.env.SCHEDULE_TASK_TIMEZONE || getSystemTimeZone();
    const timeoutEnv = process.env.SCHEDULE_TASK_SAMPLING_TIMEOUT;
    const parsedTimeout = timeoutEnv ? Number(timeoutEnv) : NaN;
    this.samplingTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 180_000;
  }

  private computeIntervalMs(config: IntervalTriggerConfig): number {
    let intervalMs = 0;
    if (config.seconds) intervalMs += config.seconds * 1000;
    if (config.minutes) intervalMs += config.minutes * 60 * 1000;
    if (config.hours) intervalMs += config.hours * 60 * 60 * 1000;
    if (config.days) intervalMs += config.days * 24 * 60 * 60 * 1000;
    return intervalMs;
  }

  private computeNextRun(task: TaskRecord, fromDate: Date = new Date()): string | undefined {
    if (!task.enabled || task.status === 'completed') {
      return task.next_run;
    }

    if (task.trigger_type === 'interval') {
      if (task.next_run) {
        const existing = new Date(task.next_run);
        if (existing > fromDate) {
          return existing.toISOString();
        }
      }
      const intervalMs = this.computeIntervalMs(task.trigger_config as IntervalTriggerConfig);
      if (intervalMs <= 0) {
        return undefined;
      }
      return new Date(fromDate.getTime() + intervalMs).toISOString();
    }

    if (task.trigger_type === 'cron') {
      if (task.next_run) {
        const existing = new Date(task.next_run);
        if (existing > fromDate) {
          return existing.toISOString();
        }
      }
      try {
        const interval = cronParser.parseExpression(task.trigger_config.expression, {
          currentDate: fromDate,
          tz: this.timeZone,
        });
        const nextDate = interval.next().toDate();
        return nextDate.toISOString();
      } catch (error) {
        console.error(`[${task.id}] Failed to compute cron next run:`, error);
        return undefined;
      }
    }

    if (task.trigger_type === 'date') {
      const runDate = new Date(task.trigger_config.run_date);
      if (runDate <= fromDate) {
        return undefined;
      }
      return runDate.toISOString();
    }

    return undefined;
  }

  private getTriggerSummary(task: TaskRecord): string {
    switch (task.trigger_type) {
      case 'interval': {
        const parts: string[] = [];
        const config = task.trigger_config as IntervalTriggerConfig;
        if (config.days) parts.push(`${config.days}天`);
        if (config.hours) parts.push(`${config.hours}小时`);
        if (config.minutes) parts.push(`${config.minutes}分钟`);
        if (config.seconds) parts.push(`${config.seconds}秒`);
        return parts.length ? `每${parts.join('')}` : '间隔任务（未配置）';
      }
      case 'cron':
        return `Cron: ${task.trigger_config.expression}`;
      case 'date': {
        const runDate = (task.trigger_config as Record<string, any>).run_date;
        if (!runDate) {
          return '一次性 @ 未指定';
        }
        const localized = formatInTimezone(runDate, this.timeZone, runDate);
        return `一次性 @ ${localized ?? runDate}`;
      }
      default:
        return task.trigger_type;
    }
  }

  private appendHistory(task: TaskRecord, entry: TaskHistoryEntry): void {
    if (!task.history) {
      task.history = [];
    }
    task.history.unshift(entry);
    if (task.history.length > HISTORY_LIMIT) {
      task.history = task.history.slice(0, HISTORY_LIMIT);
    }
  }

  private determineStatus(task: TaskRecord, now: Date = new Date()): TaskStatus {
    if (!task.enabled) {
      return task.status === 'completed' ? 'completed' : 'paused';
    }

    if (task.status === 'running') {
      return 'running';
    }

    if (task.trigger_type === 'date') {
      const runDate = new Date(task.trigger_config.run_date);
      if (task.history && task.history[0]?.status === 'success') {
        return 'completed';
      }
      if (runDate <= now) {
        return 'completed';
      }
      return 'scheduled';
    }

    if (task.last_status === 'error') {
      return 'error';
    }

    return 'scheduled';
  }

  private normaliseTask(task: TaskRecord): TaskRecord {
    const now = new Date();
    if (task.history && task.history.length > HISTORY_LIMIT) {
      task.history = task.history.slice(0, HISTORY_LIMIT);
    }
    task.status = this.determineStatus(task, now);

    if (task.trigger_type === 'date' && task.status === 'completed') {
      task.enabled = false;
    }

    task.next_run = this.computeNextRun(task, now);
    task.updated_at = task.updated_at || new Date().toISOString();
    return task;
  }

  public describeTask(task: TaskRecord): TaskRecord & {
    trigger_summary: string;
    next_run_local?: string;
    last_run_local?: string;
    created_at_local?: string;
    updated_at_local?: string;
    history?: Array<TaskHistoryEntry & { run_at_local?: string }>;
    trigger_config_local?: Record<string, any>;
  } {
    const createdAtLocal = formatInTimezone(task.created_at, this.timeZone, task.created_at);
    const updatedAtLocal = formatInTimezone(task.updated_at, this.timeZone, task.updated_at);
    const nextRunLocal = task.next_run ? formatInTimezone(task.next_run, this.timeZone, task.next_run) : undefined;
    const lastRunLocal = task.last_run ? formatInTimezone(task.last_run, this.timeZone, task.last_run) : undefined;
    const historyWithLocal = task.history?.map((entry) => ({
      ...entry,
      run_at_local: formatInTimezone(entry.run_at, this.timeZone, entry.run_at),
    }));

    let triggerConfigLocal: Record<string, any> | undefined;
    if (task.trigger_type === 'date' && task.trigger_config) {
      const config = task.trigger_config as Record<string, any>;
      const runDate = config.run_date;
      if (runDate) {
        triggerConfigLocal = {
          ...config,
          run_date_local: formatInTimezone(runDate, this.timeZone, runDate),
        };
      }
    }

    return {
      ...task,
      history: historyWithLocal,
      trigger_summary: this.getTriggerSummary(task),
      next_run_local: nextRunLocal,
      last_run_local: lastRunLocal,
      created_at_local: createdAtLocal,
      updated_at_local: updatedAtLocal,
      trigger_config_local: triggerConfigLocal,
    };
  }

  /**
   * Initialize scheduler and restore tasks from storage
   */
  async initialize(): Promise<void> {
    const tasks = this.storage.list();
    for (const task of tasks) {
      const normalised = this.normaliseTask(task);
      this.storage.upsert(normalised);
      if (normalised.enabled && normalised.status !== 'completed') {
        await this.scheduleTask(normalised);
      }
    }
  }

  /**
   * Create a new task
   */
  async createTask(params: {
    name: string;
    trigger_type: 'interval' | 'cron' | 'date';
    trigger_config: Record<string, any>;
    mcp_server?: string;
    mcp_tool?: string;
    mcp_arguments?: Record<string, any>;
    agent_prompt?: string;  // 🎯 New: Agent prompt for sampling
  }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: this.generateId(),
      name: params.name,
      trigger_type: params.trigger_type,
      trigger_config: params.trigger_config,
      mcp_server: params.mcp_server,
      mcp_tool: params.mcp_tool,
      mcp_arguments: params.mcp_arguments,
      agent_prompt: params.agent_prompt,  // 🎯 Store agent prompt
      enabled: true,
      status: 'scheduled',
      created_at: now,
      updated_at: now,
      history: [],
    };

    task.next_run = this.computeNextRun(task);

    this.storage.upsert(task);

    if (task.enabled) {
      await this.scheduleTask(task);
    }

    return task;
  }

  /**
   * List all tasks
   */
  listTasks(): TaskRecord[] {
    const tasks = this.storage.list();
    const normalised: TaskRecord[] = [];
    for (const task of tasks) {
      const updated = this.normaliseTask({ ...task });
      this.storage.upsert(updated);
      normalised.push(updated);
    }
    return normalised;
  }

  /**
   * Get a specific task
   */
  getTask(id: string): TaskRecord | undefined {
    const task = this.storage.get(id);
    if (!task) {
      return undefined;
    }
    const updated = this.normaliseTask({ ...task });
    this.storage.upsert(updated);
    return updated;
  }

  /**
   * Update a task
   */
  async updateTask(
    id: string,
    updates: Partial<Pick<TaskRecord, 'name' | 'trigger_type' | 'trigger_config' | 'mcp_server' | 'mcp_tool' | 'mcp_arguments' | 'agent_prompt' | 'enabled'>>
  ): Promise<TaskRecord> {
    const task = this.storage.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    Object.assign(task, updates);
    task.updated_at = new Date().toISOString();

    task.status = this.determineStatus(task);
    task.next_run = this.computeNextRun(task);

    this.storage.upsert(task);

    // Reschedule if needed
    this.unscheduleTask(id);
    if (task.enabled && task.status !== 'completed') {
      await this.scheduleTask(task);
    }

    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<boolean> {
    this.unscheduleTask(id);
    return this.storage.delete(id);
  }

  async clearTaskHistory(id: string): Promise<TaskRecord> {
    const task = this.storage.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.history = [];
    task.last_message = undefined;
    task.last_status = undefined;
    task.updated_at = new Date().toISOString();
    this.storage.upsert(task);

    return task;
  }

  /**
   * Pause a task
   */
  async pauseTask(id: string): Promise<TaskRecord> {
    return this.updateTask(id, { enabled: false });
  }

  /**
   * Resume a task
   */
  async resumeTask(id: string): Promise<TaskRecord> {
    return this.updateTask(id, { enabled: true });
  }

  /**
   * Execute a task immediately (manual trigger)
   */
  async executeTask(id: string): Promise<{ success: boolean; message: string }> {
    const task = this.storage.get(id);
    if (!task) {
      return { success: false, message: `Task not found: ${id}` };
    }

    return await this.runTask(task);
  }

  /**
   * Schedule a task based on its trigger type
   */
  private async scheduleTask(task: TaskRecord): Promise<void> {
    if (task.trigger_type === 'interval') {
      this.scheduleInterval(task);
    } else if (task.trigger_type === 'cron') {
      this.scheduleCron(task);
    } else if (task.trigger_type === 'date') {
      this.scheduleDate(task);
    }
  }

  /**
   * Schedule interval-based task
   */
  private scheduleInterval(task: TaskRecord): void {
    const intervalMs = this.computeIntervalMs(task.trigger_config as IntervalTriggerConfig);

    if (intervalMs <= 0) {
      console.error(`Invalid interval configuration for task ${task.id}`);
      return;
    }

    const normalizedInterval = Math.max(1, Math.round(intervalMs));

    const timer = setInterval(async () => {
      await this.runTask(task);
    }, normalizedInterval);

    this.intervalTimers.set(task.id, timer);

    // Calculate next run time
    const nextRun = new Date(Date.now() + normalizedInterval).toISOString();
    task.next_run = nextRun;
    task.updated_at = new Date().toISOString();
    this.storage.upsert(task);
  }

  /**
   * Schedule cron-based task
   */
  private scheduleCron(task: TaskRecord): void {
    const expression = task.trigger_config.expression;

    if (!cron.validate(expression)) {
      console.error(`Invalid cron expression for task ${task.id}: ${expression}`);
      return;
    }

    const cronJob = cron.schedule(expression, async () => {
      await this.runTask(task);
    }, {
      timezone: this.timeZone,
    });

    this.cronJobs.set(task.id, cronJob);

    const nextRun = this.computeNextRun(task);
    if (nextRun) {
      task.next_run = nextRun;
      task.updated_at = new Date().toISOString();
      this.storage.upsert(task);
    }
  }

  /**
   * Schedule date-based (one-time) task
   */
  private scheduleDate(task: TaskRecord): void {
    const runDate = new Date(task.trigger_config.run_date);
    const now = new Date();

    if (runDate <= now) {
      console.error(`Run date is in the past for task ${task.id}`);
      return;
    }

    const delay = runDate.getTime() - now.getTime();

    const timer = setTimeout(async () => {
      this.intervalTimers.delete(task.id);
      await this.runTask(task);
    }, delay);

    this.intervalTimers.set(task.id, timer);
    task.next_run = runDate.toISOString();
    task.updated_at = new Date().toISOString();
    this.storage.upsert(task);
  }

  /**
   * Unschedule a task
   */
  private unscheduleTask(id: string): void {
    const cronJob = this.cronJobs.get(id);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(id);
    }

    const timer = this.intervalTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.intervalTimers.delete(id);
    }
  }

  /**
   * Run a task
   */
  private async runTask(task: TaskRecord): Promise<{ success: boolean; message: string }> {
    const start = new Date();
    const startIso = start.toISOString();

    task.status = 'running';
    task.last_run = startIso;
    task.last_status = 'running';
    task.last_message = undefined;
    task.updated_at = startIso;
    this.storage.upsert(task);

    try {
      let message: string;

      // 🎯 New: Use MCP Sampling if agent_prompt is provided
      if (task.agent_prompt) {
        if (this.mcpServer) {
          console.error(`[${task.id}] Executing via MCP Sampling: "${task.agent_prompt}"`);

          const response = await this.mcpServer.request(
            {
              method: 'sampling/createMessage',
              params: {
                messages: [{
                  role: 'user',
                  content: {
                    type: 'text',
                    text: task.agent_prompt
                  }
                }],
                includeContext: 'allServers',
                maxTokens: 2000
              }
            },
            CreateMessageResultSchema,
            {
              timeout: this.samplingTimeoutMs,
            }
          );

          const content = (response as any).content?.text || JSON.stringify(response);
          message = `Sampling response: ${content}`;
          console.error(`[${task.id}] Sampling completed: ${content.substring(0, 200)}...`);
        } else {
          message = 'Task configured with agent_prompt but MCP server is not ready to send sampling requests';
          console.error(`[${task.id}] ${message}`);
        }

      } else if (task.mcp_server && task.mcp_tool) {
        // Legacy: Log MCP tool call (but don't actually call it - servers can't call each other)
        message = `Task configured (legacy): ${task.mcp_server}.${task.mcp_tool}`;
        console.error(`[${task.id}] ${message} - Note: MCP servers cannot directly call other servers. Consider using agent_prompt with sampling instead.`);

      } else {
        // No action configured
        message = `Task executed: ${task.name} (no action configured)`;
        console.error(`[${task.id}] ${message}`);
      }

      task.last_status = 'success';
      task.last_message = message;
      task.status = task.trigger_type === 'date' ? 'completed' : 'scheduled';

      const historyEntry: TaskHistoryEntry = {
        run_at: startIso,
        status: 'success',
        message,
      };
      this.appendHistory(task, historyEntry);

      if (task.trigger_type === 'date') {
        task.enabled = false;
        task.next_run = undefined;
      } else {
        task.next_run = this.computeNextRun(task, start);
      }

      task.updated_at = new Date().toISOString();
      this.storage.upsert(task);

      return { success: true, message };

    } catch (error: any) {
      let errorMessage = error?.message || String(error);
      if (error?.code === -32001) {
        errorMessage = `Sampling request timed out after ${Math.round(this.samplingTimeoutMs / 1000)}s`;
      }
      console.error(`[${task.id}] Task failed:`, error);

      task.last_status = 'error';
      task.last_message = errorMessage;
      task.status = 'error';
      task.next_run = this.computeNextRun(task, new Date());

      const historyEntry: TaskHistoryEntry = {
        run_at: startIso,
        status: 'error',
        message: errorMessage,
      };
      this.appendHistory(task, historyEntry);

      task.updated_at = new Date().toISOString();
      this.storage.upsert(task);

      return { success: false, message: errorMessage };
    }
  }

  /**
   * Shutdown scheduler
   */
  async shutdown(): Promise<void> {
    // Stop all cron jobs
    for (const cronJob of this.cronJobs.values()) {
      cronJob.stop();
    }
    this.cronJobs.clear();

    // Clear all timers
    for (const timer of this.intervalTimers.values()) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.intervalTimers.clear();
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
