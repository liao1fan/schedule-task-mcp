/**
 * Task storage using SQLite (with automatic migration from legacy JSON storage)
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'error';

export interface TaskHistoryEntry {
  run_at: string;
  status: 'success' | 'error';
  message?: string;
}

export interface TaskRecord {
  id: string;
  trigger_type: 'interval' | 'cron' | 'date';
  trigger_config: Record<string, any>;

  // Legacy MCP tool call (deprecated, use agent_prompt instead)
  mcp_server?: string;
  mcp_tool?: string;
  mcp_arguments?: Record<string, any>;

  // 🎯 New: Agent prompt for MCP Sampling
  agent_prompt?: string;

  enabled: boolean;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  last_run?: string;
  last_status?: 'success' | 'error' | 'running';
  last_message?: string;
  next_run?: string;
  history?: TaskHistoryEntry[];
}

type TaskRow = {
  id: string;
  trigger_type: string;
  trigger_config: string;
  mcp_server: string | null;
  mcp_tool: string | null;
  mcp_arguments: string | null;
  agent_prompt: string | null;
  enabled: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_run: string | null;
  last_status: string | null;
  last_message: string | null;
  next_run: string | null;
};

export class TaskStorage {
  private readonly originalPath: string;
  private readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.originalPath = dbPath;
    this.dbPath = this.resolveDbPath(dbPath);
    this.ensureDirectory();
    this.db = new DatabaseSync(this.dbPath);
    this.initialiseSchema();
    this.migrateLegacyNameColumn();
    this.migrateLegacyJson();
  }

  upsert(task: TaskRecord): void {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(`
        INSERT INTO tasks (
          id, trigger_type, trigger_config, mcp_server, mcp_tool, mcp_arguments,
          agent_prompt, enabled, status, created_at, updated_at, last_run, last_status,
          last_message, next_run
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          trigger_type = excluded.trigger_type,
          trigger_config = excluded.trigger_config,
          mcp_server = excluded.mcp_server,
          mcp_tool = excluded.mcp_tool,
          mcp_arguments = excluded.mcp_arguments,
          agent_prompt = excluded.agent_prompt,
          enabled = excluded.enabled,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_run = excluded.last_run,
          last_status = excluded.last_status,
          last_message = excluded.last_message,
          next_run = excluded.next_run
      `);

      insert.run(
        task.id,
        task.trigger_type,
        JSON.stringify(task.trigger_config ?? {}),
        task.mcp_server ?? null,
        task.mcp_tool ?? null,
        task.mcp_arguments ? JSON.stringify(task.mcp_arguments) : null,
        task.agent_prompt ?? null,
        task.enabled ? 1 : 0,
        task.status,
        task.created_at,
        task.updated_at,
        task.last_run ?? null,
        task.last_status ?? null,
        task.last_message ?? null,
        task.next_run ?? null,
      );

      if (Array.isArray(task.history)) {
        const deleteHistory = this.db.prepare('DELETE FROM task_history WHERE task_id = ?');
        deleteHistory.run(task.id);

        const insertHistory = this.db.prepare(`
          INSERT INTO task_history (task_id, run_at, status, message)
          VALUES (?, ?, ?, ?)
        `);

        for (const entry of task.history) {
          insertHistory.run(task.id, entry.run_at, entry.status, entry.message ?? null);
        }
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): TaskRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get<TaskRow>(id);
    if (!row) {
      return undefined;
    }

    const historyMap = this.loadHistory([id]);
    return this.mapRowToTask(row, historyMap.get(id) ?? []);
  }

  list(): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all<TaskRow>();
    if (rows.length === 0) {
      return [];
    }
    const historyMap = this.loadHistory(rows.map((row: TaskRow) => row.id));
    return rows.map((row: TaskRow) => this.mapRowToTask(row, historyMap.get(row.id) ?? []));
  }

  clearHistory(id: string): TaskRecord | undefined {
    const deleteHistory = this.db.prepare('DELETE FROM task_history WHERE task_id = ?');
    deleteHistory.run(id);

    const update = this.db.prepare('UPDATE tasks SET last_run = NULL, last_status = NULL, last_message = NULL, updated_at = ? WHERE id = ?');
    update.run(new Date().toISOString(), id);

    return this.get(id);
  }

  delete(id: string): boolean {
    const deleteHistory = this.db.prepare('DELETE FROM task_history WHERE task_id = ?');
    deleteHistory.run(id);

    const deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    const result = deleteTask.run(id);
    return result.changes > 0;
  }

  updateStatus(id: string, status: Partial<Pick<TaskRecord, 'last_run' | 'last_status' | 'last_message' | 'next_run'>>): void {
    const fields: string[] = [];
    const values: Array<string | null> = [];

    if (status.last_run !== undefined) {
      fields.push('last_run = ?');
      values.push(status.last_run ?? null);
    }
    if (status.last_status !== undefined) {
      fields.push('last_status = ?');
      values.push(status.last_status ?? null);
    }
    if (status.last_message !== undefined) {
      fields.push('last_message = ?');
      values.push(status.last_message ?? null);
    }
    if (status.next_run !== undefined) {
      fields.push('next_run = ?');
      values.push(status.next_run ?? null);
    }

    if (fields.length === 0) {
      return;
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private resolveDbPath(input: string): string {
    if (!input) {
      return input;
    }
    const ext = path.extname(input).toLowerCase();
    if (ext === '.json') {
      return input.slice(0, -5) + '.db';
    }
    if (!ext) {
      return `${input}.db`;
    }
    return input;
  }

  private initialiseSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        trigger_config TEXT NOT NULL,
        mcp_server TEXT,
        mcp_tool TEXT,
        mcp_arguments TEXT,
        agent_prompt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run TEXT,
        last_status TEXT,
        last_message TEXT,
        next_run TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
  }

  private migrateLegacyNameColumn(): void {
    let columns: Array<{ name: string }> = [];
    try {
      columns = this.db.prepare('PRAGMA table_info(tasks)').all<{ name: string }>();
    } catch (error) {
      console.error('[schedule-task-mcp] Failed to inspect tasks table schema:', error);
      return;
    }

    const hasNameColumn = columns.some((column) => column.name === 'name');
    if (!hasNameColumn) {
      return;
    }

    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          trigger_type TEXT NOT NULL,
          trigger_config TEXT NOT NULL,
          mcp_server TEXT,
          mcp_tool TEXT,
          mcp_arguments TEXT,
          agent_prompt TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run TEXT,
          last_status TEXT,
          last_message TEXT,
          next_run TEXT
        );
      `);

      this.db.exec(`
        INSERT INTO tasks_new (
          id, trigger_type, trigger_config, mcp_server, mcp_tool, mcp_arguments,
          agent_prompt, enabled, status, created_at, updated_at, last_run,
          last_status, last_message, next_run
        )
        SELECT
          id, trigger_type, trigger_config, mcp_server, mcp_tool, mcp_arguments,
          agent_prompt, enabled, status, created_at, updated_at, last_run,
          last_status, last_message, next_run
        FROM tasks;
      `);

      this.db.exec('DROP TABLE tasks;');
      this.db.exec('ALTER TABLE tasks_new RENAME TO tasks;');

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateLegacyJson(): void {
    try {
      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM tasks').get<{ count: number }>();
      if (countRow && countRow.count > 0) {
        return;
      }
    } catch (error) {
      console.error('[schedule-task-mcp] Failed to inspect tasks table during migration:', error);
      return;
    }

    const candidates = new Set<string>();
    if (this.originalPath && this.originalPath.endsWith('.json')) {
      candidates.add(this.originalPath);
    }
    const defaultJsonPath = path.join(path.dirname(this.dbPath), 'tasks.json');
    candidates.add(defaultJsonPath);

    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) {
        continue;
      }

      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const data = JSON.parse(raw);

        if (Array.isArray(data)) {
          for (const record of data) {
            const task: TaskRecord = {
              id: record.id,
              trigger_type: record.trigger_type,
              trigger_config: record.trigger_config ?? {},
              mcp_server: record.mcp_server ?? undefined,
              mcp_tool: record.mcp_tool ?? undefined,
              mcp_arguments: record.mcp_arguments ?? undefined,
              agent_prompt: record.agent_prompt ?? undefined,
              enabled: Boolean(record.enabled),
              status: record.status ?? 'scheduled',
              created_at: record.created_at,
              updated_at: record.updated_at,
              last_run: record.last_run ?? undefined,
              last_status: record.last_status ?? undefined,
              last_message: record.last_message ?? undefined,
              next_run: record.next_run ?? undefined,
              history: Array.isArray(record.history) ? record.history : [],
            };
            this.upsert(task);
          }

          const backupPath = `${candidate}.bak`;
          fs.renameSync(candidate, backupPath);
          console.log(`[schedule-task-mcp] Migrated legacy tasks from ${candidate} to SQLite (backup: ${backupPath})`);
        }
      } catch (error) {
        console.error(`[schedule-task-mcp] Failed to migrate legacy tasks from ${candidate}:`, error);
      }
    }
  }

  private loadHistory(taskIds: string[]): Map<string, TaskHistoryEntry[]> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const placeholders = taskIds.map(() => '?').join(',');
    const historyRows = this.db.prepare(
      `SELECT task_id, run_at, status, message
       FROM task_history
       WHERE task_id IN (${placeholders})
       ORDER BY run_at DESC`
    ).all<{ task_id: string; run_at: string; status: 'success' | 'error'; message: string | null }>(...taskIds);

    const historyMap = new Map<string, TaskHistoryEntry[]>();
    for (const row of historyRows) {
      if (!historyMap.has(row.task_id)) {
        historyMap.set(row.task_id, []);
      }
      historyMap.get(row.task_id)!.push({
        run_at: row.run_at,
        status: row.status,
        message: row.message ?? undefined,
      });
    }
    return historyMap;
  }

  private mapRowToTask(row: TaskRow, history: TaskHistoryEntry[]): TaskRecord {
    return {
      id: row.id,
      trigger_type: row.trigger_type as TaskRecord['trigger_type'],
      trigger_config: this.safeParse(row.trigger_config, {}),
      mcp_server: row.mcp_server ?? undefined,
      mcp_tool: row.mcp_tool ?? undefined,
      mcp_arguments: this.safeParse(row.mcp_arguments, undefined),
      agent_prompt: row.agent_prompt ?? undefined,
      enabled: Boolean(row.enabled),
      status: row.status as TaskStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_run: row.last_run ?? undefined,
      last_status: (row.last_status ?? undefined) as TaskRecord['last_status'],
      last_message: row.last_message ?? undefined,
      next_run: row.next_run ?? undefined,
      history,
    };
  }

  private safeParse<T>(value: string | null, fallback: T): T {
    if (!value) {
      return fallback;
    }
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
}
