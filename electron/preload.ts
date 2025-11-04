import { contextBridge, ipcRenderer } from 'electron';

import type {
  WorkflowIpcEvent,
  WorkflowSelectDirectoryResponse,
  WorkflowStartRequest,
  WorkflowStartResponse,
  WorkflowStopResponse,
} from './shared/types';

type WorkflowEventCallback = (event: WorkflowIpcEvent) => void;

const api = {
  startWorkflow: (request: WorkflowStartRequest): Promise<WorkflowStartResponse> =>
    ipcRenderer.invoke('workflow:start', request),
  stopWorkflow: (): Promise<WorkflowStopResponse> => ipcRenderer.invoke('workflow:stop'),
  selectDirectory: (): Promise<WorkflowSelectDirectoryResponse> =>
    ipcRenderer.invoke('workflow:select-directory'),
  onEvent: (callback: WorkflowEventCallback): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WorkflowIpcEvent) => {
      callback(payload);
    };
    ipcRenderer.on('workflow:event', handler);
    return () => {
      ipcRenderer.off('workflow:event', handler);
    };
  },
  onceEvent: (callback: WorkflowEventCallback): void => {
    ipcRenderer.once('workflow:event', (_event, payload: WorkflowIpcEvent) => {
      callback(payload);
    });
  },
};

contextBridge.exposeInMainWorld('workflowApi', api);

declare global {
  interface Window {
    workflowApi: typeof api;
  }
}
