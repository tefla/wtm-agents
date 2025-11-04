import type {
  WorkflowConfig,
  DeveloperDefinition,
} from '../../src/types';
import type {
  WorkflowSessionDeveloper,
  WorkflowSessionErrorEvent,
  WorkflowSessionFileEvent,
  WorkflowSessionRunnerEvent,
  WorkflowSessionStatusEvent,
} from '../../src/workflow';

export type WorkflowStartRequest = {
  config: WorkflowConfig;
  task?: string;
};

export type WorkflowUpdateDevelopers = WorkflowSessionDeveloper[];

export type WorkflowIpcEvent =
  | { type: 'session-status'; payload: WorkflowSessionStatusEvent }
  | { type: 'developers'; payload: WorkflowUpdateDevelopers }
  | { type: 'file-update'; payload: WorkflowSessionFileEvent }
  | { type: 'runner-event'; payload: WorkflowSessionRunnerEvent }
  | { type: 'result'; payload: unknown }
  | { type: 'error'; payload: WorkflowSessionErrorEvent };

export type WorkflowStopResponse = {
  stopped: boolean;
};

export type WorkflowStartResponse = {
  started: boolean;
};

export type WorkflowSelectDirectoryResponse = {
  canceled: boolean;
  path?: string;
};

export type DeveloperFormDefinition = Pick<
  DeveloperDefinition,
  'name' | 'description' | 'taskFileName' | 'statusFileName'
>;
