import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

export async function runWorkflow(
  config: WorkflowConfig,
  task?: string,
): Promise<unknown> {
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
    const prompt = composePrompt(taskRecord.title, resolved, project, taskContext, developerContexts);

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

function resolveConfig(config: WorkflowConfig): ResolvedWorkflowConfig {
  const repoRoot = resolve(config.repoRoot);
  return {
    repoRoot,
    projectName: config.projectName,
    defaultBranch: config.defaultBranch,
    developers: buildDeveloperDefinitions(),
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

function buildDeveloperDefinitions(): NormalizedDeveloperDefinition[] {
  const defaults: DeveloperDefinition[] = [
    { name: 'Chris', description: DEFAULT_DEVELOPER_DESCRIPTION },
    { name: 'Rimon', description: DEFAULT_DEVELOPER_DESCRIPTION },
  ];
  return defaults.map((definition) => ({
    name: definition.name,
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
- Assigned branch: \\`${ctx.branch}\\`
- Worktree path: \\`${ctx.worktreePath}\\`
- Task list: \\`${ctx.taskFile}\\`
- Status log: \\`${ctx.statusFile}\\`
- Registry record id: ${ctx.worktreeRecordId}

Responsibilities:
1. Operate exclusively within your worktree; do not touch other branches or the main repo root.
2. Upkeep your task list before and after coding; capture assumptions, TODOs, and scope changes.
3. Log progress and blockers in your status file so ${PM_NAME} can summarize accurately.
4. Use Codex MCP for edits and commands with sandbox workspace-write / approval-policy never, `cwd` set to your worktree.
5. When ready to hand back, summarise the changes, note any follow-ups, and hand off using \\`${ctx.handoffToken}\\`.`;

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
