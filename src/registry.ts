import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import sqlite3 from 'sqlite3';

sqlite3.verbose();

export type RegistryOptions = {
  dbPath: string;
};

export type ProjectRecord = {
  id: number;
  name: string;
  repoRoot: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskRecord = {
  id: number;
  projectId: number;
  externalRef?: string | null;
  title: string;
  pmAgent: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeRecord = {
  id: number;
  projectId: number;
  taskId: number;
  developerAgent: string;
  branch: string;
  baseRef: string;
  path: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = {
  id: number;
  name: string;
  repo_root: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: number;
  project_id: number;
  external_ref?: string | null;
  title: string;
  pm_agent: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type WorktreeRow = {
  id: number;
  project_id: number;
  task_id: number;
  developer_agent: string;
  branch: string;
  base_ref: string;
  path: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export class CoordinatorRegistry {
  private constructor(private readonly db: sqlite3.Database) {}

  static async open(options: RegistryOptions): Promise<CoordinatorRegistry> {
    const dbPath = resolve(options.dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openDatabase(dbPath);
    const registry = new CoordinatorRegistry(db);
    await registry.initialize();
    return registry;
  }

  async close(): Promise<void> {
    await closeDatabase(this.db);
  }

  async ensureProject(params: {
    name: string;
    repoRoot: string;
    defaultBranch: string;
  }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    await run(this.db, `
      INSERT INTO projects (name, repo_root, default_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        repo_root = excluded.repo_root,
        default_branch = excluded.default_branch,
        updated_at = excluded.updated_at
    `, [params.name, params.repoRoot, params.defaultBranch, now, now]);

    const row = await get<ProjectRow>(this.db, `SELECT * FROM projects WHERE name = ?`, [
      params.name,
    ]);
    if (!row) {
      throw new Error(`Failed to load project '${params.name}' after upsert.`);
    }
    return mapProject(row);
  }

  async findProjectByName(name: string): Promise<ProjectRecord | undefined> {
    const row = await get<ProjectRow>(this.db, `SELECT * FROM projects WHERE name = ?`, [name]);
    return row ? mapProject(row) : undefined;
  }

  async createTask(params: {
    projectId: number;
    title: string;
    pmAgent: string;
    externalRef?: string;
    status?: string;
  }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const status = params.status ?? 'active';
    await run(
      this.db,
      `INSERT INTO tasks (project_id, external_ref, title, pm_agent, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        params.projectId,
        params.externalRef ?? null,
        params.title,
        params.pmAgent,
        status,
        now,
        now,
      ],
    );

    const idRow = await get<{ id: number }>(this.db, 'SELECT last_insert_rowid() AS id', []);
    const id = idRow?.id;
    if (typeof id !== 'number') {
      throw new Error('Failed to retrieve inserted task id.');
    }
    const row = await get<TaskRow>(this.db, `SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!row) {
      throw new Error(`Inserted task ${id} could not be loaded.`);
    }
    return mapTask(row);
  }

  async updateTaskStatus(taskId: number, status: string): Promise<TaskRecord> {
    const now = new Date().toISOString();
    await run(this.db, `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`, [
      status,
      now,
      taskId,
    ]);
    const row = await get<TaskRow>(this.db, `SELECT * FROM tasks WHERE id = ?`, [taskId]);
    if (!row) {
      throw new Error(`Task ${taskId} not found while updating status.`);
    }
    return mapTask(row);
  }

  async createWorktree(params: {
    projectId: number;
    taskId: number;
    developerAgent: string;
    branch: string;
    baseRef: string;
    path: string;
    status?: string;
  }): Promise<WorktreeRecord> {
    const now = new Date().toISOString();
    const status = params.status ?? 'active';
    await run(
      this.db,
      `INSERT INTO worktrees (project_id, task_id, developer_agent, branch, base_ref, path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.projectId,
        params.taskId,
        params.developerAgent,
        params.branch,
        params.baseRef,
        params.path,
        status,
        now,
        now,
      ],
    );

    const idRow = await get<{ id: number }>(this.db, 'SELECT last_insert_rowid() AS id', []);
    const id = idRow?.id;
    if (typeof id !== 'number') {
      throw new Error('Failed to retrieve inserted worktree id.');
    }
    const row = await get<WorktreeRow>(this.db, `SELECT * FROM worktrees WHERE id = ?`, [id]);
    if (!row) {
      throw new Error(`Inserted worktree ${id} could not be loaded.`);
    }
    return mapWorktree(row);
  }

  async updateWorktreeStatus(worktreeId: number, status: string): Promise<WorktreeRecord> {
    const now = new Date().toISOString();
    await run(this.db, `UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?`, [
      status,
      now,
      worktreeId,
    ]);
    const row = await get<WorktreeRow>(this.db, `SELECT * FROM worktrees WHERE id = ?`, [
      worktreeId,
    ]);
    if (!row) {
      throw new Error(`Worktree ${worktreeId} not found while updating status.`);
    }
    return mapWorktree(row);
  }

  async listActiveWorktrees(projectId: number): Promise<WorktreeRecord[]> {
    const rows = await all<WorktreeRow>(
      this.db,
      `SELECT * FROM worktrees WHERE project_id = ? AND status = 'active'`,
      [projectId],
    );
    return rows.map(mapWorktree);
  }

  private async initialize(): Promise<void> {
    await exec(this.db, 'PRAGMA foreign_keys = ON');
    await exec(
      this.db,
      `
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        repo_root TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        external_ref TEXT,
        title TEXT NOT NULL,
        pm_agent TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        developer_agent TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, developer_agent, status) WHERE status = 'active'
      );
    `,
    );
  }
}

function openDatabase(filePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(db);
      }
    });
  });
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function run(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function get<T>(db: sqlite3.Database, sql: string, params: unknown[]): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
      } else {
        resolve((row as T | undefined) ?? undefined);
      }
    });
  });
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
      } else {
        resolve((rows as T[]) ?? []);
      }
    });
  });
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    repoRoot: row.repo_root,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    externalRef: row.external_ref ?? undefined,
    title: row.title,
    pmAgent: row.pm_agent,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorktree(row: WorktreeRow): WorktreeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    developerAgent: row.developer_agent,
    branch: row.branch,
    baseRef: row.base_ref,
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
