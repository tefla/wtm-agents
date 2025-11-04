import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

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
  private readonly db: Database;

  constructor(options: RegistryOptions) {
    const dbPath = resolve(options.dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  ensureProject(params: { name: string; repoRoot: string; defaultBranch: string }): ProjectRecord {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO projects (name, repo_root, default_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET repo_root=excluded.repo_root, default_branch=excluded.default_branch, updated_at=excluded.updated_at`,
      )
      .run(params.name, params.repoRoot, params.defaultBranch, now, now);

    const row = this.db
      .query<ProjectRow>(`SELECT * FROM projects WHERE name = ?`)
      .get(params.name);
    if (!row) {
      throw new Error(`Failed to load project '${params.name}' after upsert.`);
    }
    return mapProject(row);
  }

  findProjectByName(name: string): ProjectRecord | undefined {
    const row = this.db
      .query<ProjectRow>(`SELECT * FROM projects WHERE name = ?`)
      .get(name);
    return row ? mapProject(row) : undefined;
  }

  createTask(params: {
    projectId: number;
    title: string;
    pmAgent: string;
    externalRef?: string;
    status?: string;
  }): TaskRecord {
    const now = new Date().toISOString();
    const status = params.status ?? 'active';
    this.db
      .query(
        `INSERT INTO tasks (project_id, external_ref, title, pm_agent, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(params.projectId, params.externalRef ?? null, params.title, params.pmAgent, status, now, now);

    const id = this.db.query<{ id: number }>('SELECT last_insert_rowid() AS id').get()?.id;
    if (typeof id !== 'number') {
      throw new Error('Failed to retrieve inserted task id.');
    }
    const row = this.db
      .query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`)
      .get(id);
    if (!row) {
      throw new Error(`Inserted task ${id} could not be loaded.`);
    }
    return mapTask(row);
  }

  updateTaskStatus(taskId: number, status: string): TaskRecord {
    const now = new Date().toISOString();
    this.db
      .query(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, taskId);
    const row = this.db
      .query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId);
    if (!row) {
      throw new Error(`Task ${taskId} not found while updating status.`);
    }
    return mapTask(row);
  }

  createWorktree(params: {
    projectId: number;
    taskId: number;
    developerAgent: string;
    branch: string;
    baseRef: string;
    path: string;
    status?: string;
  }): WorktreeRecord {
    const now = new Date().toISOString();
    const status = params.status ?? 'active';
    this.db
      .query(
        `INSERT INTO worktrees (project_id, task_id, developer_agent, branch, base_ref, path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.projectId,
        params.taskId,
        params.developerAgent,
        params.branch,
        params.baseRef,
        params.path,
        status,
        now,
        now,
      );

    const id = this.db.query<{ id: number }>('SELECT last_insert_rowid() AS id').get()?.id;
    if (typeof id !== 'number') {
      throw new Error('Failed to retrieve inserted worktree id.');
    }
    const row = this.db
      .query<WorktreeRow>(`SELECT * FROM worktrees WHERE id = ?`)
      .get(id);
    if (!row) {
      throw new Error(`Inserted worktree ${id} could not be loaded.`);
    }
    return mapWorktree(row);
  }

  updateWorktreeStatus(worktreeId: number, status: string): WorktreeRecord {
    const now = new Date().toISOString();
    this.db
      .query(`UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, worktreeId);
    const row = this.db
      .query<WorktreeRow>(`SELECT * FROM worktrees WHERE id = ?`)
      .get(worktreeId);
    if (!row) {
      throw new Error(`Worktree ${worktreeId} not found while updating status.`);
    }
    return mapWorktree(row);
  }

  listActiveWorktrees(projectId: number): WorktreeRecord[] {
    const rows = this.db
      .query<WorktreeRow>(`SELECT * FROM worktrees WHERE project_id = ? AND status = 'active'`)
      .all(projectId);
    return rows.map(mapWorktree);
  }

  private migrate(): void {
    this.db.exec(`
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
    `);
  }
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
