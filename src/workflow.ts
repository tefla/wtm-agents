import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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

export async function runWorkflow(
  config: WorkflowConfig,
  task?: string,
): Promise<unknown> {
  const resolved = resolveConfig(config);
  if (!resolved.developers.length) {
    throw new Error('At least one developer must be configured.');
  }

  const developerContexts = prepareDevelopers(resolved);
  const prompt = composePrompt(task ?? resolved.taskPrompt, resolved, developerContexts);

  const server = new MCPServerStdio({
    command: resolved.codexCommand,
    args: resolved.codexArgs,
    cwd: resolved.repoRoot,
    clientSessionTimeoutSeconds: resolved.clientSessionTimeoutSeconds,
  });

  await server.connect();
  try {
    const { projectManager, developerAgents } = buildAgents(server, resolved, developerContexts);
    const runner = new Runner();
    const result = await runner.run(projectManager, prompt, {
      maxTurns: resolved.maxTurns,
    });
    // Reconnect developers with manager after run in case runner mutated state.
    for (const developer of developerAgents) {
      developer.handoffs = [projectManager];
    }
    return result;
  } finally {
    await server.close();
  }
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
