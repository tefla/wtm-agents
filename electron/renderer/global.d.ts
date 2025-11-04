import type {
  WorkflowChatSendResponse,
  WorkflowChooseRepoResponse,
  WorkflowClearRepoResponse,
  WorkflowConfigSummary,
  WorkflowIpcEvent,
} from '../shared/types';

declare global {
  interface Window {
    workflowApi?: {
      sendChatMessage(message: string): Promise<WorkflowChatSendResponse>;
      chooseRepository(): Promise<WorkflowChooseRepoResponse>;
      clearRepository(): Promise<WorkflowClearRepoResponse>;
      getConfigSummary(): Promise<WorkflowConfigSummary>;
      onEvent(callback: (event: WorkflowIpcEvent) => void): () => void;
      onceEvent(callback: (event: WorkflowIpcEvent) => void): void;
    };
  }
}

export {};
