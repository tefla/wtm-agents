import { contextBridge, ipcRenderer } from 'electron';

import type {
  WorkflowChatSendResponse,
  WorkflowChooseRepoResponse,
  WorkflowClearRepoResponse,
  WorkflowConfigSummary,
  WorkflowConfigSummaryResponse,
  WorkflowIpcEvent,
} from './shared/types';

type WorkflowEventCallback = (event: WorkflowIpcEvent) => void;

const api = {
  sendChatMessage: (message: string): Promise<WorkflowChatSendResponse> =>
    ipcRenderer.invoke('workflow:chat-send', { message }),
  chooseRepository: (): Promise<WorkflowChooseRepoResponse> =>
    ipcRenderer.invoke('workflow:choose-repo'),
  clearRepository: (): Promise<WorkflowClearRepoResponse> =>
    ipcRenderer.invoke('workflow:clear-repo'),
  getConfigSummary: async (): Promise<WorkflowConfigSummary> => {
    const response: WorkflowConfigSummaryResponse = await ipcRenderer.invoke(
      'workflow:get-config-summary',
    );
    return response.summary;
  },
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
