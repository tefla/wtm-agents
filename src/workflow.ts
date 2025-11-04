import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { resolve, join } from 'node:path';

import chokidar, { FSWatcher } from 'chokidar';

import { Agent, MCPServerStdio, Runner } from '@openai/agents';

import {
  DEFAULT_DEVELOPER_DESCRIPTION,
  DEFAULT_MODEL,
  DeveloperContext,
  DeveloperDefinition,
  WorkflowConfig,
} from './types';
import { sanitizeBranchName, slugifyAgentName } from './utils';
import {
  ensureWtmWorkspace,
  listWorktrees,
  locateOrCreateWorktree,
  WtmContext,
} from './wtm';

const DEFAULT_TASK_PROMPT = 'Coordinate the team and deliver the requested outcome.';
const DEFAULT_WTM_BINARY = 'wtm';
const DEFAULT_CODEX_COMMAND = 'npx';
const DEFAULT_CODEX_ARGS = ['-y', 'codex', 'mcp-server'];
const DEFAULT_CLIENT_SESSION_TIMEOUT_SECONDS = 360_000;

export type ResolvedWorkflowConfig = {
  repoRoot: string;
  developers: NormalizedDeveloperDefinition[];
  model: string;
  taskPrompt: string;
  wtmBinary: string;
  codexCommand: string;
  codexArgs: string[];
  clientSessionTimeoutSeconds: number;
  maxTurns?: number;
};

type NormalizedDeveloperDefinition = Required<
  Pick<DeveloperDefinition, 'name' | 'branch'>
> &
  Omit<DeveloperDefinition, 'name' | 'branch'> & {
    description: string;
    taskFileName: string;
    statusFileName: string;
  };

export type WorkflowSessionStage =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowSessionStatusEvent = {
  stage: WorkflowSessionStage;
  message?: string;
  timestamp: string;
};

export type WorkflowSessionDeveloper = {
  name: string;
  description: string;
  branch: string;
  worktreePath: string;
  taskFile: string;
  statusFile: string;
  handoffToken: string;
};

export type WorkflowSessionFileKind = 'task' | 'status' | 'overview' | 'team';

export type WorkflowSessionFileEvent = {
  kind: WorkflowSessionFileKind;
  path: string;
  developerName?: string;
  content: string | null;
  timestamp: string;
};

export type WorkflowSessionRunnerEvent = {
  event: unknown;
  timestamp: string;
};

export type WorkflowSessionErrorEvent = {
  message: string;
  name?: string;
  stack?: string;
  scope?: string;
  path?: string;
  timestamp: string;
};

type WorkflowSessionEvents = {
  'session-status': [WorkflowSessionStatusEvent];
  developers: [WorkflowSessionDeveloper[]];
  'file-update': [WorkflowSessionFileEvent];
  'runner-event': [WorkflowSessionRunnerEvent];
  result: [unknown];
  error: [WorkflowSessionErrorEvent];
};

export async function runWorkflow(
  config: WorkflowConfig,
  task?: string,
): Promise<unknown> {
  const session = new WorkflowSession(config);
  return session.run(task);
}

export async function run(config: WorkflowConfig, task?: string): Promise<unknown> {
  return runWorkflow(config, task);
}

function resolveConfig(config: WorkflowConfig): ResolvedWorkflowConfig {
  const repoRoot = resolve(config.repoRoot);
  return {
    repoRoot,
    developers: config.developers.map(normalizeDeveloperDefinition),
    model: config.model ?? DEFAULT_MODEL,
    taskPrompt: config.taskPrompt ?? DEFAULT_TASK_PROMPT,
    wtmBinary: config.wtmBinary ?? DEFAULT_WTM_BINARY,
    codexCommand: config.codexCommand ?? DEFAULT_CODEX_COMMAND,
    codexArgs: config.codexArgs ?? DEFAULT_CODEX_ARGS,
    clientSessionTimeoutSeconds:
      config.clientSessionTimeoutSeconds ?? DEFAULT_CLIENT_SESSION_TIMEOUT_SECONDS,
    maxTurns: config.maxTurns,
  };
}

function normalizeDeveloperDefinition(definition: DeveloperDefinition): NormalizedDeveloperDefinition {
  return {
    ...definition,
    name: definition.name,
    branch: definition.branch,
    description: definition.description ?? DEFAULT_DEVELOPER_DESCRIPTION,
    taskFileName: definition.taskFileName ?? 'AGENT_TASKS.md',
    statusFileName: definition.statusFileName ?? 'STATUS.md',
  };
}

function prepareDevelopers(config: ResolvedWorkflowConfig): DeveloperContext[] {
  if (!existsSync(config.repoRoot)) {
    throw new Error(`Repository root does not exist: ${config.repoRoot}`);
  }

  const contexts: DeveloperContext[] = [];
  const wtmContext: WtmContext = {
    repoRoot: config.repoRoot,
    wtmBinary: config.wtmBinary,
  };

  ensureWtmWorkspace(wtmContext);
  let worktrees = listWorktrees(wtmContext);

  for (const definition of config.developers) {
    const branch = sanitizeBranchName(definition.branch);
    const located = locateOrCreateWorktree(wtmContext, branch, worktrees);
    worktrees = located.worktrees;
    const worktreePath = located.path;
    const taskFile = join(worktreePath, definition.taskFileName);
    const statusFile = join(worktreePath, definition.statusFileName);
    const handoffToken = `transfer_to_${slugifyAgentName(definition.name)}_agent`;
    contexts.push({
      definition,
      branch,
      worktreePath,
      taskFile,
      statusFile,
      handoffToken,
    });
  }

  return contexts;
}

function buildAgents(
  codexServer: MCPServerStdio,
  config: ResolvedWorkflowConfig,
  developers: DeveloperContext[],
): { projectManager: Agent; developerAgents: Agent[] } {
  const developerAgents = developers.map((ctx) => {
    return new Agent({
      name: ctx.definition.name,
      instructions: buildDeveloperInstructions(ctx),
      model: config.model,
      mcpServers: [codexServer],
      handoffs: [],
      handoffDescription: `${ctx.definition.description} based in worktree ${ctx.worktreePath}`,
    });
  });

  const projectManager = new Agent({
    name: 'Project Manager',
    instructions: buildProjectManagerInstructions(config, developers),
    model: config.model,
    mcpServers: [codexServer],
    handoffs: developerAgents,
    handoffDescription: 'Coordinates the developer fleet and verifies deliverables.',
  });

  for (const agent of developerAgents) {
    agent.handoffs = [projectManager];
  }

  return { projectManager, developerAgents };
}

function buildProjectManagerInstructions(
  config: ResolvedWorkflowConfig,
  developers: DeveloperContext[],
): string {
  const roster = developers
    .map((ctx) => {
      return [
        `- ${ctx.definition.name}: ${ctx.definition.description} (branch \`${ctx.branch}\`, worktree \`${ctx.worktreePath}\`)`,
        `  • Task list: \`${ctx.taskFile}\``,
        `  • Status log: \`${ctx.statusFile}\``,
        `  • Handoff command: \`${ctx.handoffToken}\``,
      ].join('\n');
    })
    .join('\n');

  return (
    'You are the Project Manager responsible for coordinating multiple developers.\n' +
    'Goals:\n' +
    '1. Clarify the project brief and capture a high-level plan in `PROJECT_OVERVIEW.md` at the repo root.\n' +
    '2. Maintain a source of truth in `TEAM_STATUS.md` summarising assignments and progress.\n' +
    "3. For each developer, create and update their dedicated task list file before handing off work.\n" +
    '4. Ensure each developer has the context they need and review outputs before moving to the next handoff.\n' +
    '5. Keep cycles tight—prioritise small, well-scoped deliveries and follow-ups.\n\n' +
    'Team roster:\n' +
    `${roster}\n\n` +
    'Workflow expectations:\n' +
    '- Use Codex MCP for all filesystem operations with {"approval-policy":"never","sandbox":"workspace-write"}.\n' +
    "- When ready to assign work, edit the developer's task file with actionable items, then use the listed handoff command.\n" +
    '- After a developer returns, verify deliverables (run quick checks with Codex MCP), update `TEAM_STATUS.md`, and either reassign or close out.\n' +
    '- Continue until the project goals are satisfied, then produce a concise final status update summarising outcomes and open questions.'
  );
}

function buildDeveloperInstructions(ctx: DeveloperContext): string {
  return (
    `You are ${ctx.definition.name}, a ${ctx.definition.description}\n` +
    `- Active branch: \`${ctx.branch}\`\n` +
    `- Worktree path: \`${ctx.worktreePath}\`\n` +
    `- Task list (authoritative source of work): \`${ctx.taskFile}\`\n` +
    `- Status log (append notes + checkpoints): \`${ctx.statusFile}\`\n\n` +
    'Responsibilities:\n' +
    '1. Read the latest tasks from your task list and clarify assumptions inline before coding.\n' +
    '2. Use Codex MCP for all edits with {"approval-policy":"never","sandbox":"workspace-write"}. ' +
    `Set the \`cwd\` to \`${ctx.worktreePath}\` when running commands or editing files.\n` +
    "3. Keep work scoped to your assigned worktree; do not modify other developers' directories.\n" +
    '4. Document progress in your status log and keep the task list up to date.\n' +
    '5. On completion (or if blocked), summarise what changed, note any TODOs, and hand off with `transfer_to_project_manager_agent`.'
  );
}

function composePrompt(
  task: string,
  config: ResolvedWorkflowConfig,
  developers: DeveloperContext[],
): string {
  const roster = developers
    .map((ctx) => `- ${ctx.definition.name} → branch \`${ctx.branch}\`, worktree \`${ctx.worktreePath}\``)
    .join('\n');

  return (
    `${task.trim()}\n\n` +
    'Workspace context:\n' +
    `- Repository root: ${config.repoRoot}\n` +
    `- wtm binary: ${config.wtmBinary}\n` +
    'Developers:\n' +
    `${roster}\n` +
    'The Project Manager coordinates the developers above. Ensure each workstream stays in its dedicated worktree.'
  );
}

type WatchedFileMeta = {
  path: string;
  kind: WorkflowSessionFileKind;
  developerName?: string;
};

function normalizeError(
  error: unknown,
  context: { scope?: string; path?: string } = {},
): WorkflowSessionErrorEvent {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
      scope: context.scope,
      path: context.path,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    message: String(error),
    scope: context.scope,
    path: context.path,
    timestamp: new Date().toISOString(),
  };
}

export class WorkflowSession extends EventEmitter<WorkflowSessionEvents> {
  private readonly config: WorkflowConfig;
  private resolved?: ResolvedWorkflowConfig;
  private server?: MCPServerStdio;
  private runner?: Runner;
  private developerContexts: DeveloperContext[] = [];
  private watchers: FSWatcher[] = [];
  private runnerCleanup?: () => void;
  private running = false;
  private stopRequested = false;

  constructor(config: WorkflowConfig) {
    super();
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  getDevelopers(): WorkflowSessionDeveloper[] {
    return this.developerContexts.map((ctx) => ({
      name: ctx.definition.name,
      description: ctx.definition.description ?? DEFAULT_DEVELOPER_DESCRIPTION,
      branch: ctx.branch,
      worktreePath: ctx.worktreePath,
      taskFile: ctx.taskFile,
      statusFile: ctx.statusFile,
      handoffToken: ctx.handoffToken,
    }));
  }

  async run(task?: string): Promise<unknown> {
    if (this.running) {
      throw new Error('Workflow session is already running.');
    }

    this.running = true;
    this.stopRequested = false;

    try {
      this.emitStatus('preparing', 'Preparing workflow configuration');

      const resolved = resolveConfig(this.config);
      if (!resolved.developers.length) {
        throw new Error('At least one developer must be configured.');
      }
      this.resolved = resolved;

      const contexts = prepareDevelopers(resolved);
      this.developerContexts = contexts;
      this.emitDevelopers(contexts);
      await this.setupFileWatchers(resolved, contexts);

      const prompt = composePrompt(task ?? resolved.taskPrompt, resolved, contexts);

      this.emitStatus('starting', 'Launching Codex MCP server');

      this.server = new MCPServerStdio({
        command: resolved.codexCommand,
        args: resolved.codexArgs,
        cwd: resolved.repoRoot,
        clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
      });

      await this.server.connect();

      try {
        const { projectManager, developerAgents } = buildAgents(
          this.server,
          resolved,
          contexts,
        );

        this.runner = new Runner();
        this.attachRunnerListeners(this.runner);

        this.emitStatus('running', 'Workflow running');

        const result = await this.runner.run(projectManager, prompt, {
          maxTurns: resolved.maxTurns,
        });

        for (const developer of developerAgents) {
          developer.handoffs = [projectManager];
        }

        this.emit('result', result);
        const finalStage: WorkflowSessionStage = this.stopRequested ? 'cancelled' : 'completed';
        this.emitStatus(
          finalStage,
          finalStage === 'completed' ? 'Workflow completed successfully' : 'Workflow cancelled',
        );
        return result;
      } finally {
        this.detachRunnerListeners();
        if (this.server) {
          try {
            await this.server.close();
          } catch (error) {
            this.emit('error', normalizeError(error, { scope: 'session' }));
          } finally {
            this.server = undefined;
          }
        }
      }
    } catch (error) {
      const normalized = normalizeError(error, { scope: 'session' });
      this.emit('error', normalized);
      this.emitStatus('failed', normalized.message);
      throw error;
    } finally {
      await this.teardownWatchers();
      this.runner = undefined;
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const runner = this.runner as unknown as {
      abort?: () => unknown;
      stop?: () => unknown;
      terminate?: () => unknown;
    };

    const methods: (keyof typeof runner)[] = ['abort', 'stop', 'terminate'];
    for (const method of methods) {
      const fn = runner?.[method];
      if (typeof fn === 'function') {
        try {
          const result = fn.call(runner);
          if (result instanceof Promise) {
            await result;
          }
        } catch (error) {
          this.emit('error', normalizeError(error, { scope: 'runner' }));
        }
        break;
      }
    }
  }

  private emitStatus(stage: WorkflowSessionStage, message?: string): void {
    this.emit('session-status', {
      stage,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private emitDevelopers(contexts: DeveloperContext[]): void {
    this.emit(
      'developers',
      contexts.map((ctx) => ({
        name: ctx.definition.name,
        description: ctx.definition.description ?? DEFAULT_DEVELOPER_DESCRIPTION,
        branch: ctx.branch,
        worktreePath: ctx.worktreePath,
        taskFile: ctx.taskFile,
        statusFile: ctx.statusFile,
        handoffToken: ctx.handoffToken,
      })),
    );
  }

  private async setupFileWatchers(
    config: ResolvedWorkflowConfig,
    contexts: DeveloperContext[],
  ): Promise<void> {
    const metas: WatchedFileMeta[] = [];

    for (const context of contexts) {
      metas.push({
        path: context.taskFile,
        kind: 'task',
        developerName: context.definition.name,
      });
      metas.push({
        path: context.statusFile,
        kind: 'status',
        developerName: context.definition.name,
      });
    }

    metas.push({
      path: join(config.repoRoot, 'PROJECT_OVERVIEW.md'),
      kind: 'overview',
    });
    metas.push({
      path: join(config.repoRoot, 'TEAM_STATUS.md'),
      kind: 'team',
    });

    const watchers = await Promise.all(
      metas.map(async (meta) => this.createWatcher(meta)),
    );
    this.watchers = watchers.filter((watcher): watcher is FSWatcher => Boolean(watcher));
  }

  private async createWatcher(meta: WatchedFileMeta): Promise<FSWatcher | undefined> {
    try {
      const watcher = chokidar.watch(meta.path, {
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
      });

      watcher.on('add', () => {
        void this.emitFileSnapshot(meta, true);
      });
      watcher.on('change', () => {
        void this.emitFileSnapshot(meta, true);
      });
      watcher.on('unlink', () => {
        void this.emitFileSnapshot(meta, false);
      });
      watcher.on('error', (watchError) => {
        this.emit('error', normalizeError(watchError, { scope: 'watcher', path: meta.path }));
      });

      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
        watcher.once('ready', finish);
        watcher.once('error', finish);
      });

      return watcher;
    } catch (error) {
      this.emit('error', normalizeError(error, { scope: 'watcher', path: meta.path }));
      return undefined;
    }
  }

  private async emitFileSnapshot(meta: WatchedFileMeta, exists: boolean): Promise<void> {
    if (!exists) {
      this.emit('file-update', {
        kind: meta.kind,
        path: meta.path,
        developerName: meta.developerName,
        content: null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const content = await readFile(meta.path, 'utf8');
      this.emit('file-update', {
        kind: meta.kind,
        path: meta.path,
        developerName: meta.developerName,
        content,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.emit('error', normalizeError(error, { scope: 'watcher', path: meta.path }));
    }
  }

  private async teardownWatchers(): Promise<void> {
    if (!this.watchers.length) {
      return;
    }

    await Promise.all(
      this.watchers.map(async (watcher) => {
        try {
          await watcher.close();
        } catch (error) {
          this.emit('error', normalizeError(error, { scope: 'watcher' }));
        }
      }),
    );

    this.watchers = [];
  }

  private attachRunnerListeners(runner: Runner): void {
    const candidate = runner as unknown as Partial<EventEmitter> & {
      subscribe?: (listener: (event: unknown) => void) => (() => void) | void;
      removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void;
    };

    if (typeof candidate.on === 'function') {
      const handler = (event: unknown) => {
        this.emit('runner-event', {
          event,
          timestamp: new Date().toISOString(),
        });
      };

      candidate.on('event' as unknown as string, handler);
      this.runnerCleanup = () => {
        if (typeof candidate.off === 'function') {
          candidate.off('event' as unknown as string, handler);
        } else if (typeof candidate.removeListener === 'function') {
          candidate.removeListener('event' as unknown as string, handler);
        }
      };
      return;
    }

    if (typeof candidate.subscribe === 'function') {
      const unsubscribe = candidate.subscribe((event) => {
        this.emit('runner-event', {
          event,
          timestamp: new Date().toISOString(),
        });
      });

      if (typeof unsubscribe === 'function') {
        this.runnerCleanup = () => {
          try {
            unsubscribe();
          } catch (error) {
            this.emit('error', normalizeError(error, { scope: 'runner' }));
          }
        };
      }
    }
  }

  private detachRunnerListeners(): void {
    if (!this.runnerCleanup) {
      return;
    }

    try {
      this.runnerCleanup();
    } catch (error) {
      this.emit('error', normalizeError(error, { scope: 'runner' }));
    } finally {
      this.runnerCleanup = undefined;
    }
  }
}
