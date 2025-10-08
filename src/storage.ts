/**
 * Task storage using JSON file
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TaskRecord {
  id: string;
  name: string;
  trigger_type: 'interval' | 'cron' | 'date';
  trigger_config: Record<string, any>;
  mcp_server?: string;
  mcp_tool?: string;
  mcp_arguments?: Record<string, any>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run?: string;
  last_status?: 'success' | 'error' | 'running';
  last_message?: string;
  next_run?: string;
}

export class TaskStorage {
  private dbPath: string;
  private tasks: Map<string, TaskRecord> = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf-8');
        const records: TaskRecord[] = JSON.parse(data);
        this.tasks = new Map(records.map(r => [r.id, r]));
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
      this.tasks = new Map();
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const records = Array.from(this.tasks.values());
      fs.writeFileSync(this.dbPath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save tasks:', error);
    }
  }

  upsert(task: TaskRecord): void {
    this.tasks.set(task.id, task);
    this.save();
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }

  delete(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) {
      this.save();
    }
    return existed;
  }

  updateStatus(id: string, status: Partial<Pick<TaskRecord, 'last_run' | 'last_status' | 'last_message' | 'next_run'>>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, status);
      task.updated_at = new Date().toISOString();
      this.save();
    }
  }
}
