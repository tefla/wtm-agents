import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type GitContext = {
  repoRoot: string;
};

export class GitCommandError extends Error {
  readonly command: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string[], exitCode: number, stdout: string, stderr: string) {
    super(`git command failed (${exitCode}): ${command.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    this.name = 'GitCommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function runGitCommand(context: GitContext, args: string[]): string {
  const command = ['git', ...args];
  const result = Bun.spawnSync(command, {
    cwd: context.repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';

  if (result.exitCode !== 0) {
    throw new GitCommandError(command, result.exitCode ?? -1, stdout, stderr);
  }

  return stdout.trim();
}

export function resolveRepoRoot(startPath: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: startPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';

  if (result.exitCode !== 0) {
    throw new GitCommandError(['git', 'rev-parse', '--show-toplevel'], result.exitCode ?? -1, stdout, stderr);
  }

  const repoRoot = stdout.trim();
  if (!existsSync(repoRoot)) {
    throw new Error(`Resolved repo root does not exist: ${repoRoot}`);
  }
  return resolve(repoRoot);
}

export type WorktreeEntry = {
  path: string;
  branch?: string;
};

export function listWorktrees(context: GitContext): WorktreeEntry[] {
  let output: string;
  try {
    output = runGitCommand(context, ['worktree', 'list', '--porcelain']);
  } catch (error) {
    if (error instanceof GitCommandError && error.stderr.includes('No worktree found')) {
      return [];
    }
    throw error;
  }

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      const path = line.slice('worktree '.length).trim();
      current = { path: resolve(path) };
    } else if (line.startsWith('branch ') && current) {
      const branch = line.slice('branch '.length).trim();
      if (branch && branch !== '(detached)') {
        current.branch = branch;
      }
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

export type CreateWorktreeOptions = {
  branch: string;
  baseRef: string;
  worktreePath: string;
};

export function createWorktree(context: GitContext, options: CreateWorktreeOptions): void {
  const branch = validateTaskBranch(options.branch);
  runGitCommand(context, [
    'worktree',
    'add',
    options.worktreePath,
    options.baseRef,
    '-b',
    branch,
  ]);
}

export function removeWorktree(context: GitContext, worktreePath: string): void {
  runGitCommand(context, ['worktree', 'remove', worktreePath]);
}

export function pruneWorktrees(context: GitContext): void {
  runGitCommand(context, ['worktree', 'prune']);
}

export function validateTaskBranch(branch: string): string {
  const normalized = branch.trim().replace(/\s+/g, '-');
  const prohibited = new Set(['main', 'master', 'develop', 'development']);
  if (prohibited.has(normalized)) {
    throw new Error(`Task branches cannot reuse protected branch name '${normalized}'.`);
  }
  return normalized;
}
