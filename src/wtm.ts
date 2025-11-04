import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type WtmContext = {
  repoRoot: string;
  wtmBinary: string;
};

export class WTMCommandError extends Error {
  readonly command: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string[], exitCode: number, stdout: string, stderr: string) {
    super(
      `wtm command failed (${exitCode}): ${command.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    this.name = 'WTMCommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export type WorktreeInfo = {
  path: string;
  branch?: string;
};

export function runWtmCommand(context: WtmContext, args: string[]): string {
  const command = [context.wtmBinary, ...args];
  const bunAvailable = typeof Bun !== 'undefined' && typeof Bun.spawnSync === 'function';

  if (bunAvailable) {
    const result = Bun.spawnSync(command, {
      cwd: context.repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';
    const exitCode = result.exitCode ?? -1;

    if (exitCode !== 0) {
      throw new WTMCommandError(command, exitCode, stdout, stderr);
    }

    return stdout.trim();
  }

  const result = nodeSpawnSync(command[0] as string, command.slice(1), {
    cwd: context.repoRoot,
    encoding: 'utf8',
  });

  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : ((result.stdout as Buffer | undefined)?.toString('utf8') ?? '');
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : ((result.stderr as Buffer | undefined)?.toString('utf8') ?? '');
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.signal
        ? 1
        : -1;

  if (exitCode !== 0) {
    throw new WTMCommandError(command, exitCode, stdout, stderr);
  }

  return stdout.trim();
}

export function ensureWtmWorkspace(context: WtmContext): void {
  const wtmDir = resolve(context.repoRoot, '.wtm');
  if (existsSync(wtmDir)) {
    return;
  }
  runWtmCommand(context, ['init']);
}

export function listWorktrees(context: WtmContext): WorktreeInfo[] {
  let output: string;
  try {
    output = runWtmCommand(context, ['worktree', 'list']);
  } catch (error) {
    if (error instanceof WTMCommandError && error.stderr.includes('No git worktrees found')) {
      return [];
    }
    throw error;
  }

  const entries: WorktreeInfo[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split('|').map((part) => part.trim());
    const entry: WorktreeInfo = {
      path: resolve(parts[0]),
    };
    for (const part of parts.slice(1)) {
      if (part.startsWith('branch:')) {
        entry.branch = part.split(':', 2)[1]?.trim();
      }
    }
    entries.push(entry);
  }
  return entries;
}

export function locateOrCreateWorktree(
  context: WtmContext,
  branch: string,
  existing: WorktreeInfo[],
): { path: string; worktrees: WorktreeInfo[] } {
  for (const info of existing) {
    if (info.branch === branch) {
      return { path: info.path, worktrees: [...existing] };
    }
  }

  runWtmCommand(context, ['worktree', 'add', branch]);
  const refreshed = listWorktrees(context);
  const located = refreshed.find((info) => info.branch === branch);
  if (!located) {
    throw new Error(`Failed to determine worktree path for branch '${branch}'.`);
  }
  return { path: located.path, worktrees: refreshed };
}
