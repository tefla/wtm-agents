import type {
  WorkflowIpcEvent,
  WorkflowSelectDirectoryResponse,
  WorkflowStartRequest,
  WorkflowStartResponse,
  WorkflowStopResponse,
} from '../shared/types';

declare global {
  interface Window {
    workflowApi?: {
      startWorkflow(request: WorkflowStartRequest): Promise<WorkflowStartResponse>;
      stopWorkflow(): Promise<WorkflowStopResponse>;
      selectDirectory(): Promise<WorkflowSelectDirectoryResponse>;
      onEvent(callback: (event: WorkflowIpcEvent) => void): () => void;
      onceEvent(callback: (event: WorkflowIpcEvent) => void): void;
    };
  }
}

export {};
