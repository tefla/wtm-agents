export const DEFAULT_MODEL = 'gpt-4.1-mini';

export const DEFAULT_DEVELOPER_DESCRIPTION =
  'Product-minded engineer who ships production-ready changes with minimal guidance.';

export const BIGBOSS_NAME = 'BigBoss';
export const PM_NAME = 'Anup';

export type DeveloperDefinition = {
  name: string;
  description?: string;
  taskFileName?: string;
  statusFileName?: string;
};

export type DeveloperContext = {
  definition: Required<DeveloperDefinition>;
  branch: string;
  worktreePath: string;
  worktreeRecordId: number;
  taskFile: string;
  statusFile: string;
  handoffToken: string;
};

export type TaskContext = {
  id: number;
  title: string;
};

export type WorkflowConfig = {
  repoRoot: string;
  projectName: string;
  defaultBranch: string;
  model?: string;
  taskPrompt?: string;
  registryPath?: string;
  codexCommand?: string;
  codexArgs?: string[];
  clientSessionTimeoutSeconds?: number;
  maxTurns?: number;
};

export type WorkflowResult = unknown;
