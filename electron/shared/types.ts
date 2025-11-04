import type {
  WorkflowSessionChatMessage,
  WorkflowSessionDeveloper,
  WorkflowSessionErrorEvent,
  WorkflowSessionFileEvent,
  WorkflowSessionRunnerEvent,
  WorkflowSessionStatusEvent,
} from '../../src/workflow';

export type WorkflowUpdateDevelopers = WorkflowSessionDeveloper[];

export type WorkflowConfigSummary = {
  mode: 'conversation' | 'full';
  projectName: string;
  repoRoot?: string | null;
};

export type WorkflowIpcEvent =
  | { type: 'session-status'; payload: WorkflowSessionStatusEvent }
  | { type: 'developers'; payload: WorkflowUpdateDevelopers }
  | { type: 'file-update'; payload: WorkflowSessionFileEvent }
  | { type: 'runner-event'; payload: WorkflowSessionRunnerEvent }
  | { type: 'result'; payload: unknown }
  | { type: 'chat-message'; payload: WorkflowSessionChatMessage }
  | { type: 'config-summary'; payload: WorkflowConfigSummary }
  | { type: 'error'; payload: WorkflowSessionErrorEvent };

export type WorkflowChatSendRequest = {
  message: string;
};

export type WorkflowChatSendResponse = {
  delivered: boolean;
  error?: string;
};

export type WorkflowChatMessage = WorkflowSessionChatMessage;

export type WorkflowChooseRepoResponse = {
  updated: boolean;
  summary: WorkflowConfigSummary;
};

export type WorkflowClearRepoResponse = {
  summary: WorkflowConfigSummary;
};

export type WorkflowConfigSummaryResponse = {
  summary: WorkflowConfigSummary;
};
