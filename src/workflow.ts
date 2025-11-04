import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';

import chokidar, { FSWatcher } from 'chokidar';
import {
  Agent,
  MCPServerStdio,
  RunItem,
  RunMessageOutputItem,
  Runner,
  type AgentInputItem,
  user,
} from '@openai/agents';

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
const DEFAULT_CONVERSATION_PROMPT =
  'Greet the human, summarize the projects we currently track, and offer to register a new project if needed.';
const DEFAULT_CODEX_COMMAND = 'npx';
const DEFAULT_CODEX_ARGS = ['-y', 'codex', 'mcp-server'];
const DEFAULT_CLIENT_SESSION_TIMEOUT_SECONDS = 360_000;

function createConversationId(): string {
  return `conv_${randomUUID().replace(/-/g, '')}`;
}

type NormalizedDeveloperDefinition = Required<DeveloperDefinition>;

type WorkflowMode = 'full' | 'conversation';

export type ResolvedWorkflowConfig = {
  mode: WorkflowMode;
  repoRoot: string | null;
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ChatTurnOptions = {
  announceUser?: boolean;
  initial?: boolean;
};

export type WorkflowSessionStage =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'interactive'
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

export type WorkflowSessionChatRole = 'user' | 'agent';

export type WorkflowSessionChatMessage = {
  id: string;
  role: WorkflowSessionChatRole;
  sender: string;
  agentName?: string;
  content: string;
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
  'chat-message': [WorkflowSessionChatMessage];
  error: [WorkflowSessionErrorEvent];
};

export async function runWorkflow(
  config: WorkflowConfig,
  task?: string,
): Promise<unknown> {
  const resolved = resolveConfig(config);

  if (resolved.mode === 'full') {
    const bootstrap = await bootstrapFullWorkflow(resolved, task);
    const { registry, project, taskContext, developerContexts, prompt } = bootstrap;

    try {
      const server = new MCPServerStdio({
        command: resolved.codexCommand,
        args: resolved.codexArgs,
        cwd: resolved.repoRoot ?? process.cwd(),
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
      await registry.close();
    }
  }

  const bootstrap = await bootstrapConversationWorkflow(resolved, task);
  const { registry, projects, prompt } = bootstrap;

  try {
    const server = new MCPServerStdio({
      command: resolved.codexCommand,
      args: resolved.codexArgs,
      cwd: resolved.repoRoot ?? process.cwd(),
      clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
    });

    await server.connect();
    try {
      const bigBoss = new Agent({
        name: BIGBOSS_NAME,
        instructions: buildConversationInstructions(resolved, projects),
        model: resolved.model,
        mcpServers: [server],
        handoffs: [],
        handoffDescription: 'Coordinator and single user-facing agent in discovery mode.',
      });

      const runner = new Runner();
      const result = await runner.run(bigBoss, prompt, {
        maxTurns: resolved.maxTurns,
      });
      return result;
    } finally {
      await server.close();
    }
  } finally {
    await registry.close();
  }
}

export async function run(config: WorkflowConfig, task?: string): Promise<unknown> {
  return runWorkflow(config, task);
}

async function bootstrapFullWorkflow(
  resolved: ResolvedWorkflowConfig,
  task?: string,
): Promise<WorkflowBootstrap> {
  if (!resolved.repoRoot) {
    throw new Error('Repository root is required for a full workflow session.');
  }
  if (!existsSync(resolved.repoRoot)) {
    throw new Error(`Repository root does not exist: ${resolved.repoRoot}`);
  }

  const registry = await CoordinatorRegistry.open({ dbPath: resolved.registryPath });
  try {
    const project = await registry.ensureProject({
      name: resolved.projectName,
      repoRoot: resolved.repoRoot,
      defaultBranch: resolved.defaultBranch,
    });

    const taskRecord = await createTaskRecord(registry, project, task ?? resolved.taskPrompt);
    const taskContext: TaskContext = { id: taskRecord.id, title: taskRecord.title };
    const developerContexts = await prepareDevelopers(resolved, project, taskContext, registry);
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
    await registry.close();
    throw error;
  }
}

type ConversationBootstrap = {
  resolved: ResolvedWorkflowConfig;
  registry: CoordinatorRegistry;
  projects: ProjectRecord[];
  prompt: string;
};

async function bootstrapConversationWorkflow(
  resolved: ResolvedWorkflowConfig,
  task?: string,
): Promise<ConversationBootstrap> {
  const registry = await CoordinatorRegistry.open({ dbPath: resolved.registryPath });
  try {
    const projects = await registry.listProjects();
    const prompt = composeConversationPrompt(task, projects);
    return {
      resolved,
      registry,
      projects,
      prompt,
    };
  } catch (error) {
    await registry.close();
    throw error;
  }
}

function resolveConfig(config: WorkflowConfig): ResolvedWorkflowConfig {
  const rawRepo = config.repoRoot?.trim() ?? '';
  const repoRoot = rawRepo ? resolve(rawRepo) : null;
  const mode: WorkflowMode = repoRoot ? 'full' : 'conversation';
  const projectName = config.projectName?.trim() || (mode === 'full' ? 'Project' : 'Unassigned Project');
  const defaultBranch = config.defaultBranch?.trim() || 'main';

  return {
    mode,
    repoRoot,
    projectName,
    defaultBranch,
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

function resolveRegistryPath(customPath: string | undefined, repoRoot: string | null): string {
  if (customPath && customPath.trim()) {
    return resolve(customPath.trim());
  }
  const home = process.env.HOME;
  const base = home && home.trim() ? home : repoRoot ?? process.cwd();
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

async function createTaskRecord(
  registry: CoordinatorRegistry,
  project: ProjectRecord,
  rawTitle: string,
): Promise<TaskRecord> {
  const title = rawTitle.trim() || DEFAULT_TASK_PROMPT;
  return registry.createTask({
    projectId: project.id,
    title,
    pmAgent: PM_NAME,
  });
}

async function prepareDevelopers(
  config: ResolvedWorkflowConfig,
  project: ProjectRecord,
  task: TaskContext,
  registry: CoordinatorRegistry,
): Promise<DeveloperContext[]> {
  if (!config.repoRoot) {
    throw new Error('Developer preparation requires a repository root.');
  }

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

    const record = await registry.createWorktree({
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
  if (!config.repoRoot) {
    throw new Error('Coordinator instructions require a repository root.');
  }

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
  if (!config.repoRoot) {
    throw new Error('PM instructions require a repository root.');
  }

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
  if (!config.repoRoot) {
    throw new Error('Workflow prompt composition requires a repository root.');
  }

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

function buildConversationInstructions(
  config: ResolvedWorkflowConfig,
  projects: ProjectRecord[],
): string {
  const projectLines = formatProjectsForInstructions(projects);

  return (
    `You are ${BIGBOSS_NAME}, the coordinator and single user-facing agent.` +
    `\n- Registry database: ${config.registryPath}` +
    `\n- Mode: Discovery (no active project assigned yet)` +
    '\n\nResponsibilities:\n' +
    '1. Welcome the human and understand what they need help with.\n' +
    '2. Surface the list of registered projects along with their repository roots.\n' +
    '3. If the human wants to work on an existing project, clarify the project name and confirm the repository path.\n' +
    '4. If the human wants to onboard a new project, describe the expected repository root and ask them to use the “Set Repository” button in the app header to configure it.\n' +
    '5. Give concise, actionable instructions for any next steps the human should take in the UI.' +
    '\n\nRegistered projects:\n' +
    (projectLines || '- No projects registered yet. Offer to set one up by selecting a git repository path.') +
    '\n\nGuidance:\n' +
    '- When asking for a new repository, remind the human to use the “Set Repository” button in the header and wait for confirmation before continuing.\n' +
    '- Do not assume a repository path if the human has not provided one.'
  );
}

function composeConversationPrompt(
  task: string | undefined,
  projects: ProjectRecord[],
): string {
  const desired = task?.trim() || DEFAULT_CONVERSATION_PROMPT;
  const summary = formatProjectsForPrompt(projects);
  return `${desired}\n\nRegistry summary:\n${summary}`;
}

function formatProjectsForInstructions(projects: ProjectRecord[]): string {
  if (!projects.length) {
    return '';
  }
  return projects
    .map((project) => `- ${project.name}: ${project.repoRoot} (default branch ${project.defaultBranch})`)
    .join('\n');
}

function formatProjectsForPrompt(projects: ProjectRecord[]): string {
  if (!projects.length) {
    return 'No registered projects found.';
  }
  return projects
    .map((project) => `${project.name} → ${project.repoRoot} (default ${project.defaultBranch})`)
    .join('\n');
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
  private registry?: CoordinatorRegistry;
  private developerContexts: DeveloperContext[] = [];
  private watchers: FSWatcher[] = [];
  private runnerCleanup?: () => void;
  private running = false;
  private stopRequested = false;
  private chatHistory: AgentInputItem[] = [];
  private chatConversationId: string | null = null;
  private chatQueue: Promise<void> = Promise.resolve();
  private lastResponseId?: string;
  private bigBossAgent?: Agent;
  private pmAgent?: Agent;
  private developerAgents: Agent[] = [];
  private activeTurnCount = 0;
  private sessionDeferred?: Deferred<unknown>;

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
    this.chatQueue = Promise.resolve();
    this.chatHistory = [];
    this.chatConversationId = createConversationId();
    this.lastResponseId = undefined;
    this.activeTurnCount = 0;
    this.sessionDeferred = createDeferred<unknown>();

    const resolved = resolveConfig(this.config);
    this.resolved = resolved;

    try {
      const preparingMessage =
        resolved.mode === 'full'
          ? 'Preparing workflow configuration'
          : 'Loading registered projects';
      this.emitStatus('preparing', preparingMessage);

      if (resolved.mode === 'full') {
        return await this.startFullWorkflow(resolved, task);
      }

      return await this.startConversationWorkflow(resolved, task);
    } catch (error) {
      const normalized = normalizeError(error, { scope: 'session' });
      this.emit('error', normalized);
      if (this.sessionDeferred) {
        this.sessionDeferred.reject(error);
        this.sessionDeferred = undefined;
      }
      if (!this.stopRequested) {
        this.emitStatus('failed', normalized.message);
      }
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async startFullWorkflow(
    resolved: ResolvedWorkflowConfig,
    task?: string,
  ): Promise<unknown> {
    const bootstrap = await bootstrapFullWorkflow(resolved, task);

    this.registry = bootstrap.registry;
    this.project = bootstrap.project;
    this.taskContext = bootstrap.taskContext;
    this.prompt = bootstrap.prompt;
    this.developerContexts = bootstrap.developerContexts;

    this.emitDevelopers(this.developerContexts);
    await this.setupFileWatchers(resolved, this.developerContexts);

    this.emitStatus('starting', 'Launching Codex MCP server');

    const repoRoot = resolved.repoRoot ?? process.cwd();
    this.server = new MCPServerStdio({
      command: resolved.codexCommand,
      args: resolved.codexArgs,
      cwd: repoRoot,
      clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
    });

    await this.server.connect();

    const { bigBoss, pmAgent, developerAgents } = buildAgents(
      this.server,
      resolved,
      bootstrap.project,
      bootstrap.taskContext,
      this.developerContexts,
    );

    for (const developer of developerAgents) {
      developer.handoffs = [pmAgent];
    }
    pmAgent.handoffs = [bigBoss, ...developerAgents];
    bigBoss.handoffs = [pmAgent];

    this.bigBossAgent = bigBoss;
    this.pmAgent = pmAgent;
    this.developerAgents = developerAgents;

    this.runner = new Runner();
    this.attachRunnerListeners(this.runner);

    this.emitStatus('running', 'Workflow running');

    void this.enqueueChatTurn(bootstrap.prompt, { announceUser: true, initial: true });

    const deferred = this.sessionDeferred;
    return await (deferred ? deferred.promise : Promise.resolve(undefined));
  }

  private async startConversationWorkflow(
    resolved: ResolvedWorkflowConfig,
    task?: string,
  ): Promise<unknown> {
    const bootstrap = await bootstrapConversationWorkflow(resolved, task);

    this.registry = bootstrap.registry;
    this.project = undefined;
    this.taskContext = undefined;
    this.prompt = bootstrap.prompt;
    this.developerContexts = [];

    this.emitDevelopers([]);

    this.emitStatus('starting', 'Launching Codex MCP server');

    const cwd = resolved.repoRoot ?? process.cwd();
    this.server = new MCPServerStdio({
      command: resolved.codexCommand,
      args: resolved.codexArgs,
      cwd,
      clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
    });

    await this.server.connect();

    const bigBoss = new Agent({
      name: BIGBOSS_NAME,
      instructions: buildConversationInstructions(resolved, bootstrap.projects),
      model: resolved.model,
      mcpServers: [this.server],
      handoffs: [],
      handoffDescription: 'Coordinator and single user-facing agent in discovery mode.',
    });

    this.bigBossAgent = bigBoss;
    this.pmAgent = undefined;
    this.developerAgents = [];

    this.runner = new Runner();
    this.attachRunnerListeners(this.runner);

    this.emitStatus('interactive', 'Awaiting input');

    void this.enqueueChatTurn(bootstrap.prompt, { announceUser: false, initial: true });

    const deferred = this.sessionDeferred;
    return await (deferred ? deferred.promise : Promise.resolve(undefined));
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

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

    if (this.sessionDeferred) {
      this.sessionDeferred.resolve(undefined);
      this.sessionDeferred = undefined;
    }

    this.emitStatus('cancelled', 'Workflow stopped by user');
  }

  async sendChatMessage(message: string): Promise<void> {
    if (!this.running || !this.sessionDeferred) {
      throw new Error('Workflow session is not active.');
    }

    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    await this.enqueueChatTurn(trimmed, { announceUser: true });
  }

  private enqueueChatTurn(message: string, options?: ChatTurnOptions): Promise<void> {
    if (this.stopRequested) {
      return Promise.resolve();
    }

    const trimmed = message.trim();
    if (!trimmed) {
      return Promise.resolve();
    }

    const runTurn = async () => {
      if (this.stopRequested) {
        return;
      }
      await this.executeChatTurn(trimmed, options);
    };

    const next = this.chatQueue.then(runTurn);
    this.chatQueue = next.then(
      () => undefined,
      (error) => {
        this.handleChatError(error);
        return undefined;
      },
    );

    return next;
  }

  private async executeChatTurn(message: string, options?: ChatTurnOptions): Promise<void> {
    const runner = this.runner;
    const agent = this.bigBossAgent;
    if (!runner || !agent) {
      throw new Error('Workflow session is not ready for chat turns.');
    }

    const timestamp = new Date().toISOString();

    if (options?.announceUser !== false) {
      this.emitChatMessage({
        id: randomUUID(),
        role: 'user',
        sender: 'You',
        content: message,
        timestamp,
      });
    }

    const userMessage = user(message);
    const conversationInput: AgentInputItem[] = [...this.chatHistory, userMessage];

    this.activeTurnCount += 1;
    this.emitStatus('running', options?.initial ? 'Workflow running' : 'Processing input');

    try {
      const result = await runner.run(agent, conversationInput, {
        maxTurns: this.resolved?.maxTurns,
        conversationId: this.chatConversationId ?? undefined,
        previousResponseId: this.lastResponseId,
      });

      this.chatHistory = result.history;
      this.lastResponseId = result.lastResponseId;

      this.emitAgentMessagesFromRunItems(result.newItems);

      if (typeof result.finalOutput !== 'undefined') {
        this.emit('result', result.finalOutput);
      }
    } catch (error) {
      if (this.stopRequested) {
        return;
      }
      throw error;
    } finally {
      this.activeTurnCount = Math.max(0, this.activeTurnCount - 1);
      if (!this.stopRequested && this.activeTurnCount === 0) {
        this.emitStatus('interactive', 'Awaiting further input');
      }
    }
  }

  private emitChatMessage(message: WorkflowSessionChatMessage): void {
    this.emit('chat-message', message);
  }

  private emitAgentMessagesFromRunItems(items: RunItem[]): void {
    for (const item of items) {
      if (!this.isMessageOutputItem(item)) {
        continue;
      }

      const content = this.extractMessageText(item);
      if (!content) {
        continue;
      }

      this.emitChatMessage({
        id: randomUUID(),
        role: 'agent',
        sender: item.agent.name,
        agentName: item.agent.name,
        content,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private isMessageOutputItem(item: RunItem): item is RunMessageOutputItem {
    return (item as RunMessageOutputItem)?.type === 'message_output_item';
  }

  private extractMessageText(item: RunMessageOutputItem): string | null {
    const segments = item.rawItem?.content ?? [];
    const parts = segments
      .map((segment) => {
        switch (segment.type) {
          case 'output_text':
            return segment.text;
          case 'refusal':
            return segment.refusal;
          case 'audio':
            return segment.transcript ?? '[Audio output]';
          default:
            if ('text' in segment && typeof (segment as { text?: unknown }).text === 'string') {
              return (segment as { text: string }).text;
            }
            return '';
        }
      })
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      return null;
    }

    return parts.join('\n\n');
  }

  private handleChatError(error: unknown): void {
    if (this.stopRequested) {
      return;
    }

    this.stopRequested = true;

    const normalized = normalizeError(error, { scope: 'runner' });
    this.emit('error', normalized);
    this.emitStatus('failed', normalized.message);

    if (this.sessionDeferred) {
      this.sessionDeferred.reject(error);
      this.sessionDeferred = undefined;
    }
  }

  private async cleanup(): Promise<void> {
    this.detachRunnerListeners();
    this.runner = undefined;

    if (this.server) {
      try {
        await this.server.close();
      } catch (error) {
        this.emit('error', normalizeError(error, { scope: 'session' }));
      } finally {
        this.server = undefined;
      }
    }

    if (this.registry) {
      try {
        await this.registry.close();
      } catch (error) {
        this.emit('error', normalizeError(error, { scope: 'registry' }));
      } finally {
        this.registry = undefined;
      }
    }

    await this.teardownWatchers();

    this.bigBossAgent = undefined;
    this.pmAgent = undefined;
    this.developerAgents = [];
    this.developerContexts = [];
    this.project = undefined;
    this.taskContext = undefined;
    this.prompt = undefined;
    this.resolved = undefined;

    this.chatHistory = [];
    this.chatConversationId = null;
    this.chatQueue = Promise.resolve();
    this.lastResponseId = undefined;
    this.activeTurnCount = 0;
    this.sessionDeferred = undefined;
    this.stopRequested = false;
    this.running = false;
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
    if (!config.repoRoot) {
      return;
    }

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
