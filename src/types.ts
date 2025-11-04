export const DEFAULT_MODEL = 'gpt-4.1-mini';

export const DEFAULT_DEVELOPER_DESCRIPTION =
  'Generalist product engineer capable of shipping features end-to-end.';

export type DeveloperDefinition = {
  name: string;
  branch: string;
  description?: string;
  taskFileName?: string;
  statusFileName?: string;
};

export type DeveloperContext = {
  definition: DeveloperDefinition;
  branch: string;
  worktreePath: string;
  taskFile: string;
  statusFile: string;
  handoffToken: string;
};

export type WorkflowConfig = {
  repoRoot: string;
  developers: DeveloperDefinition[];
  model?: string;
  taskPrompt?: string;
  wtmBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  clientSessionTimeoutSeconds?: number;
  maxTurns?: number;
};

export type WorkflowResult = unknown;
