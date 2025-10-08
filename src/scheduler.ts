/**
 * Task scheduler with support for interval, cron, and date triggers
 */

import * as cron from 'node-cron';
import { TaskStorage, TaskRecord } from './storage.js';

export interface SchedulerConfig {
  dbPath: string;
}

export class TaskScheduler {
  private storage: TaskStorage;
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private intervalTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: SchedulerConfig) {
    this.storage = new TaskStorage(config.dbPath);
  }

  /**
   * Initialize scheduler and restore tasks from storage
   */
  async initialize(): Promise<void> {
    const tasks = this.storage.list();
    for (const task of tasks) {
      if (task.enabled) {
        await this.scheduleTask(task);
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
      enabled: true,
      created_at: now,
      updated_at: now,
    };

    this.storage.upsert(task);
    await this.scheduleTask(task);

    return task;
  }

  /**
   * List all tasks
   */
  listTasks(): TaskRecord[] {
    return this.storage.list();
  }

  /**
   * Get a specific task
   */
  getTask(id: string): TaskRecord | undefined {
    return this.storage.get(id);
  }

  /**
   * Update a task
   */
  async updateTask(
    id: string,
    updates: Partial<Pick<TaskRecord, 'name' | 'trigger_type' | 'trigger_config' | 'mcp_server' | 'mcp_tool' | 'mcp_arguments' | 'enabled'>>
  ): Promise<TaskRecord> {
    const task = this.storage.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    Object.assign(task, updates);
    task.updated_at = new Date().toISOString();

    this.storage.upsert(task);

    // Reschedule if needed
    this.unscheduleTask(id);
    if (task.enabled) {
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
    const { minutes, hours, days } = task.trigger_config;
    let intervalMs = 0;

    if (minutes) intervalMs += minutes * 60 * 1000;
    if (hours) intervalMs += hours * 60 * 60 * 1000;
    if (days) intervalMs += days * 24 * 60 * 60 * 1000;

    if (intervalMs === 0) {
      console.error(`Invalid interval configuration for task ${task.id}`);
      return;
    }

    const timer = setInterval(async () => {
      await this.runTask(task);
    }, intervalMs);

    this.intervalTimers.set(task.id, timer);

    // Calculate next run time
    const nextRun = new Date(Date.now() + intervalMs).toISOString();
    this.storage.updateStatus(task.id, { next_run: nextRun });
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
    });

    this.cronJobs.set(task.id, cronJob);

    // Note: cron library doesn't provide next run time easily
    // This is a simplified approach
    this.storage.updateStatus(task.id, { next_run: 'Scheduled (cron)' });
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
      await this.runTask(task);
      // Disable after one-time execution
      await this.pauseTask(task.id);
    }, delay);

    this.intervalTimers.set(task.id, timer);
    this.storage.updateStatus(task.id, { next_run: runDate.toISOString() });
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
    const startTime = new Date().toISOString();

    this.storage.updateStatus(task.id, {
      last_run: startTime,
      last_status: 'running',
      last_message: undefined,
    });

    try {
      // In a real implementation, this would call the MCP tool
      // For now, we just simulate success
      const message = `Task executed: ${task.name}`;
      if (task.mcp_server && task.mcp_tool) {
        console.log(`[${task.id}] Would call ${task.mcp_server}.${task.mcp_tool} with args:`, task.mcp_arguments);
      }

      this.storage.updateStatus(task.id, {
        last_status: 'success',
        last_message: message,
      });

      // Update next run for interval tasks
      if (task.trigger_type === 'interval') {
        const { minutes = 0, hours = 0, days = 0 } = task.trigger_config;
        const intervalMs = (minutes * 60 + hours * 3600 + days * 86400) * 1000;
        const nextRun = new Date(Date.now() + intervalMs).toISOString();
        this.storage.updateStatus(task.id, { next_run: nextRun });
      }

      return { success: true, message };
    } catch (error: any) {
      const errorMessage = error.message || String(error);

      this.storage.updateStatus(task.id, {
        last_status: 'error',
        last_message: errorMessage,
      });

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
