import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';

import chokidar, { FSWatcher } from 'chokidar';
import { Agent, MCPServerStdio, Runner } from '@openai/agents';

import {
  BIGBOSS_NAME,
  DEFAULT_DEVELOPER_DESCRIPTION,
  DEFAULT_MODEL,
  DeveloperContext,
  DeveloperDefinition,
  PM_NAME,
  TaskContext,
  WorkflowConfig,
} from './types';
import { sanitizeBranchName, slugifyAgentName } from './utils';
import { createWorktree, GitContext, listWorktrees } from './git';
import { CoordinatorRegistry, ProjectRecord, TaskRecord } from './registry';

const DEFAULT_TASK_PROMPT = 'Coordinate the team and deliver the requested outcome.';
const DEFAULT_CODEX_COMMAND = 'npx';
const DEFAULT_CODEX_ARGS = ['-y', 'codex', 'mcp-server'];
const DEFAULT_CLIENT_SESSION_TIMEOUT_SECONDS = 360_000;

type NormalizedDeveloperDefinition = Required<DeveloperDefinition>;

export type ResolvedWorkflowConfig = {
  repoRoot: string;
  projectName: string;
  defaultBranch: string;
  developers: NormalizedDeveloperDefinition[];
  model: string;
  taskPrompt: string;
  registryPath: string;
  codexCommand: string;
  codexArgs: string[];
  clientSessionTimeoutSeconds: number;
  maxTurns?: number;
};

type WorkflowBootstrap = {
  resolved: ResolvedWorkflowConfig;
  registry: CoordinatorRegistry;
  project: ProjectRecord;
  taskContext: TaskContext;
  developerContexts: DeveloperContext[];
  prompt: string;
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
  const bootstrap = bootstrapWorkflow(config, task);
  const { resolved, registry, project, taskContext, developerContexts, prompt } = bootstrap;

  try {
    const server = new MCPServerStdio({
      command: resolved.codexCommand,
      args: resolved.codexArgs,
      cwd: resolved.repoRoot,
      clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
    });

    await server.connect();
    try {
      const { bigBoss, pmAgent, developerAgents } = buildAgents(
        server,
        resolved,
        project,
        taskContext,
        developerContexts,
      );

      const runner = new Runner();
      const result = await runner.run(bigBoss, prompt, {
        maxTurns: resolved.maxTurns,
      });

      pmAgent.handoffs = [bigBoss, ...developerAgents];
      for (const developer of developerAgents) {
        developer.handoffs = [pmAgent, bigBoss];
      }
      bigBoss.handoffs = [pmAgent];

      return result;
    } finally {
      await server.close();
    }
  } finally {
    registry.close();
  }
}

export async function run(config: WorkflowConfig, task?: string): Promise<unknown> {
  return runWorkflow(config, task);
}

function bootstrapWorkflow(config: WorkflowConfig, task?: string): WorkflowBootstrap {
  const resolved = resolveConfig(config);
  if (!existsSync(resolved.repoRoot)) {
    throw new Error(`Repository root does not exist: ${resolved.repoRoot}`);
  }

  const registry = new CoordinatorRegistry({ dbPath: resolved.registryPath });
  try {
    const project = registry.ensureProject({
      name: resolved.projectName,
      repoRoot: resolved.repoRoot,
      defaultBranch: resolved.defaultBranch,
    });

    const taskRecord = createTaskRecord(registry, project, task ?? resolved.taskPrompt);
    const taskContext: TaskContext = { id: taskRecord.id, title: taskRecord.title };
    const developerContexts = prepareDevelopers(resolved, project, taskContext, registry);
    const prompt = composePrompt(taskContext.title, resolved, project, taskContext, developerContexts);

    return {
      resolved,
      registry,
      project,
      taskContext,
      developerContexts,
      prompt,
    };
  } catch (error) {
    registry.close();
    throw error;
  }
}

function resolveConfig(config: WorkflowConfig): ResolvedWorkflowConfig {
  const repoRoot = resolve(config.repoRoot);
  return {
    repoRoot,
    projectName: config.projectName,
    defaultBranch: config.defaultBranch,
    developers: buildDeveloperDefinitions(config.developers),
    model: config.model ?? DEFAULT_MODEL,
    taskPrompt: config.taskPrompt ?? DEFAULT_TASK_PROMPT,
    registryPath: resolveRegistryPath(config.registryPath, repoRoot),
    codexCommand: config.codexCommand ?? DEFAULT_CODEX_COMMAND,
    codexArgs: config.codexArgs ?? DEFAULT_CODEX_ARGS,
    clientSessionTimeoutSeconds:
      config.clientSessionTimeoutSeconds ?? DEFAULT_CLIENT_SESSION_TIMEOUT_SECONDS,
    maxTurns: config.maxTurns,
  };
}

function resolveRegistryPath(customPath: string | undefined, repoRoot: string): string {
  if (customPath && customPath.trim()) {
    return resolve(customPath.trim());
  }
  const home = process.env.HOME;
  const base = home && home.trim() ? home : repoRoot;
  return resolve(base, '.agent_hub', 'bigboss.db');
}

function buildDeveloperDefinitions(
  provided?: DeveloperDefinition[],
): NormalizedDeveloperDefinition[] {
  const defaults: DeveloperDefinition[] = [
    { name: 'Chris', description: DEFAULT_DEVELOPER_DESCRIPTION },
    { name: 'Rimon', description: DEFAULT_DEVELOPER_DESCRIPTION },
  ];

  const source = provided && provided.length ? provided : defaults;
  return source.map((definition, index) => ({
    name: definition.name?.trim() || `Developer ${index + 1}`,
    description: definition.description ?? DEFAULT_DEVELOPER_DESCRIPTION,
    taskFileName: definition.taskFileName ?? 'AGENT_TASKS.md',
    statusFileName: definition.statusFileName ?? 'STATUS.md',
  }));
}

function createTaskRecord(
  registry: CoordinatorRegistry,
  project: ProjectRecord,
  rawTitle: string,
): TaskRecord {
  const title = rawTitle.trim() || DEFAULT_TASK_PROMPT;
  return registry.createTask({
    projectId: project.id,
    title,
    pmAgent: PM_NAME,
  });
}

function prepareDevelopers(
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  task: TaskContext,
  registry: CoordinatorRegistry,
): DeveloperContext[] {
  const gitContext: GitContext = { repoRoot: config.repoRoot };
  const contexts: DeveloperContext[] = [];
  let worktrees = listWorktrees(gitContext);

  for (const definition of config.developers) {
    const branch = buildDeveloperBranch(config, task, definition);
    if (worktrees.some((entry) => entry.branch === branch)) {
      throw new Error(`Worktree for branch '${branch}' already exists.`);
    }

    const developerSlug = slugifyAgentName(definition.name);
    const worktreePath = join(
      config.repoRoot,
      '.bigboss',
      'worktrees',
      `task-${task.id}`,
      developerSlug,
    );

    if (existsSync(worktreePath)) {
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    mkdirSync(dirname(worktreePath), { recursive: true });

    createWorktree(gitContext, {
      branch,
      baseRef: config.defaultBranch,
      worktreePath,
    });

    worktrees = listWorktrees(gitContext);

    const record = registry.createWorktree({
      projectId: project.id,
      taskId: task.id,
      developerAgent: definition.name,
      branch,
      baseRef: config.defaultBranch,
      path: worktreePath,
    });

    const taskFile = join(worktreePath, definition.taskFileName);
    const statusFile = join(worktreePath, definition.statusFileName);
    const handoffToken = `transfer_to_${slugifyAgentName(definition.name)}_agent`;

    contexts.push({
      definition,
      branch,
      worktreePath,
      worktreeRecordId: record.id,
      taskFile,
      statusFile,
      handoffToken,
    });
  }

  return contexts;
}

function buildDeveloperBranch(
  config: ResolvedWorkflowConfig,
  task: TaskContext,
  definition: NormalizedDeveloperDefinition,
): string {
  const projectSlug = sanitizeBranchName(config.projectName.toLowerCase());
  const taskSegment = `task-${task.id}`;
  const developerSlug = sanitizeBranchName(slugifyAgentName(definition.name));
  return sanitizeBranchName(`tasks/${projectSlug}/${taskSegment}/${developerSlug}`);
}

function buildAgents(
  codexServer: MCPServerStdio,
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  task: TaskContext,
  developers: DeveloperContext[],
): { bigBoss: Agent; pmAgent: Agent; developerAgents: Agent[] } {
  const developerAgents = developers.map((ctx) => {
    return new Agent({
      name: ctx.definition.name,
      instructions: buildDeveloperInstructions(project, task, ctx),
      model: config.model,
      mcpServers: [codexServer],
      handoffs: [],
      handoffDescription: `${ctx.definition.description} working in ${ctx.worktreePath}`,
    });
  });

  const pmAgent = new Agent({
    name: PM_NAME,
    instructions: buildPmInstructions(config, project, task, developers),
    model: config.model,
    mcpServers: [codexServer],
    handoffs: developerAgents,
    handoffDescription: 'PM who manages task boards, planning, and developer handoffs.',
  });

  for (const agent of developerAgents) {
    agent.handoffs = [pmAgent];
  }

  const bigBoss = new Agent({
    name: BIGBOSS_NAME,
    instructions: buildCoordinatorInstructions(config, project, task, developers),
    model: config.model,
    mcpServers: [codexServer],
    handoffs: [pmAgent],
    handoffDescription: 'Coordinator and single user-facing agent.',
  });

  pmAgent.handoffs = [bigBoss, ...developerAgents];

  return { bigBoss, pmAgent, developerAgents };
}

function buildCoordinatorInstructions(
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  task: TaskContext,
  developers: DeveloperContext[],
): string {
  const roster = developers
    .map((ctx) => {
      return [
        `- ${ctx.definition.name}: ${ctx.definition.description}`,
        `  • Worktree: \`${ctx.worktreePath}\` (branch \`${ctx.branch}\`)`,
        `  • Task board: \`${ctx.taskFile}\``,
        `  • Status log: \`${ctx.statusFile}\``,
        `  • Handoff token: \`${ctx.handoffToken}\``,
      ].join('\n');
    })
    .join('\n');

  return (
    `You are ${BIGBOSS_NAME}, the coordinator and single user-facing agent.` +
    `\n- Registry database: ${config.registryPath}` +
    `\n- Project: ${project.name} (${project.repoRoot})` +
    `\n- Default base branch: ${config.defaultBranch}` +
    `\n- Active task #${task.id}: ${task.title}` +
    '\n\nResponsibilities:\n' +
    '1. Own all communication with the human and translate requests into actionable plans.\n' +
    `2. Coordinate with ${PM_NAME} for planning and status aggregation; the PM relays work to developers.` +
    '\n3. Ensure every developer stays inside their assigned git worktree/branch and avoids main/develop.\n' +
    '4. Keep the SQLite registry accurate by noting new tasks/worktrees that were pre-registered for this session.\n' +
    '5. Request concise updates and verify deliverables before closing the loop with the human.\n\n' +
    'Team roster:\n' +
    roster +
    '\n\nWorkflow expectations:\n' +
    `- Use git worktree commands for branch management (already prepared for you).` +
    '\n- Use Codex MCP with {"approval-policy":"never","sandbox":"workspace-write"} for all filesystem operations.\n' +
    `- When delegating, provide ${PM_NAME} with clear objectives, constraints, and success criteria.` +
    '\n- When developers return, ensure status files and task boards reflect reality before reporting back to the human.'
  );
}

function buildPmInstructions(
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  task: TaskContext,
  developers: DeveloperContext[],
): string {
  const developerOverview = developers
    .map((ctx) => `- ${ctx.definition.name}: \`${ctx.worktreePath}\` (branch \`${ctx.branch}\`)`)
    .join('\n');

  return (
    `You are ${PM_NAME}, the project manager working under ${BIGBOSS_NAME}.` +
    `\nActive task #${task.id}: ${task.title}` +
    `\nRegistry database: ${config.registryPath}` +
    `\nProject root: ${project.repoRoot}` +
    '\n\nResponsibilities:\n' +
    '1. Capture the plan and updates in `PROJECT_OVERVIEW.md` and `TEAM_STATUS.md` at the repo root.\n' +
    '2. Prepare each developer by writing actionable items into their task files before handing off.\n' +
    '3. Keep git worktrees aligned with the registry records and avoid touching main/develop.\n' +
    `4. Relay progress back to ${BIGBOSS_NAME} with clear risks, blockers, and next steps.` +
    '\n5. When developers finish, verify outputs, update status logs, and either redelegate or signal completion.' +
    '\n\nDeveloper assignments:\n' +
    developerOverview +
    '\n\nTooling reminders:\n' +
    '- Use Codex MCP for file edits/commands (sandbox workspace-write, approval-policy never).\n' +
    '- Git worktrees already exist; focus on task coordination and documentation.'
  );
}

function buildDeveloperInstructions(
  project: ProjectRecord,
  task: TaskContext,
  ctx: DeveloperContext,
): string {
  return `You are ${ctx.definition.name}, a ${ctx.definition.description}
- Project: ${project.name}
- Task #${task.id}: ${task.title}
- Assigned branch: \`${ctx.branch}\`
- Worktree path: \`${ctx.worktreePath}\`
- Task list: \`${ctx.taskFile}\`
- Status log: \`${ctx.statusFile}\`
- Registry record id: ${ctx.worktreeRecordId}

Responsibilities:
1. Operate exclusively within your worktree; do not touch other branches or the main repo root.
2. Upkeep your task list before and after coding; capture assumptions, TODOs, and scope changes.
3. Log progress and blockers in your status file so ${PM_NAME} can summarize accurately.
4. Use Codex MCP for edits and commands with sandbox workspace-write / approval-policy never, set \`cwd\` to your worktree.
5. When ready to hand back, summarise the changes, note any follow-ups, and hand off using \`${ctx.handoffToken}\`.`;
}

function composePrompt(
  task: string,
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  taskContext: TaskContext,
  developers: DeveloperContext[],
): string {
  const developerSummary = developers
    .map((ctx) => `- ${ctx.definition.name}: branch \`${ctx.branch}\`, worktree \`${ctx.worktreePath}\``)
    .join('\n');

  return (
    `${task.trim() || DEFAULT_TASK_PROMPT}\n\n` +
    'Workspace context:\n' +
    `- Repository root: ${config.repoRoot}\n` +
    `- Registry: ${config.registryPath}\n` +
    `- Project: ${project.name}\n` +
    `- Task id: ${taskContext.id}\n` +
    `- Base branch: ${config.defaultBranch}\n` +
    'Developers:\n' +
    developerSummary +
    '\n\nBigBoss is the sole user-facing agent; all other agents communicate through BigBoss.'
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
  private project?: ProjectRecord;
  private taskContext?: TaskContext;
  private prompt?: string;
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

    let registry: CoordinatorRegistry | undefined;

    try {
      this.emitStatus('preparing', 'Preparing workflow configuration');

      const bootstrap = bootstrapWorkflow(this.config, task);
      registry = bootstrap.registry;
      this.resolved = bootstrap.resolved;
      this.project = bootstrap.project;
      this.taskContext = bootstrap.taskContext;
      this.prompt = bootstrap.prompt;
      this.developerContexts = bootstrap.developerContexts;

      this.emitDevelopers(this.developerContexts);
      await this.setupFileWatchers(bootstrap.resolved, this.developerContexts);

      registry.close();
      registry = undefined;

      this.emitStatus('starting', 'Launching Codex MCP server');

      this.server = new MCPServerStdio({
        command: bootstrap.resolved.codexCommand,
        args: bootstrap.resolved.codexArgs,
        cwd: bootstrap.resolved.repoRoot,
        clientSessionTimeoutSeconds: bootstrap.resolved.clientSessionTimeoutSeconds,
      });

      await this.server.connect();

      try {
        const { bigBoss, pmAgent, developerAgents } = buildAgents(
          this.server,
          bootstrap.resolved,
          bootstrap.project,
          bootstrap.taskContext,
          this.developerContexts,
        );

        this.runner = new Runner();
        this.attachRunnerListeners(this.runner);

        this.emitStatus('running', 'Workflow running');

        const result = await this.runner.run(bigBoss, bootstrap.prompt, {
          maxTurns: bootstrap.resolved.maxTurns,
        });

        for (const developer of developerAgents) {
          developer.handoffs = [pmAgent];
        }
        pmAgent.handoffs = [bigBoss, ...developerAgents];
        bigBoss.handoffs = [pmAgent];

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
      if (registry) {
        registry.close();
      }
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

    const watchers = await Promise.all(metas.map(async (meta) => this.createWatcher(meta)));
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
