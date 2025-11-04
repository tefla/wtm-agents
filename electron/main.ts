import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { basename, join } from 'node:path';

import {
  WorkflowSession,
  type WorkflowSessionChatMessage,
  type WorkflowSessionDeveloper,
  type WorkflowSessionErrorEvent,
  type WorkflowSessionFileEvent,
  type WorkflowSessionRunnerEvent,
  type WorkflowSessionStatusEvent,
} from '../src/workflow';
import {
  DEFAULT_DEVELOPER_DESCRIPTION,
  DEFAULT_MODEL,
  type DeveloperDefinition,
  type WorkflowConfig,
} from '../src/types';
import type {
  WorkflowChatSendRequest,
  WorkflowChatSendResponse,
  WorkflowChooseRepoResponse,
  WorkflowClearRepoResponse,
  WorkflowConfigSummary,
  WorkflowConfigSummaryResponse,
  WorkflowIpcEvent,
} from './shared/types';

const DEFAULT_WINDOW_BOUNDS = {
  width: 1280,
  height: 900,
  minWidth: 1024,
  minHeight: 720,
};

const DEFAULT_DEVELOPERS: DeveloperDefinition[] = [
  {
    name: 'Chris',
    description: DEFAULT_DEVELOPER_DESCRIPTION,
    taskFileName: 'AGENT_TASKS.md',
    statusFileName: 'STATUS.md',
  },
  {
    name: 'Rimon',
    description: DEFAULT_DEVELOPER_DESCRIPTION,
    taskFileName: 'AGENT_TASKS.md',
    statusFileName: 'STATUS.md',
  },
];

const CONVERSATION_PROJECT_NAME = 'Unassigned Project';

let mainWindow: BrowserWindow | null = null;
let activeSession: WorkflowSession | null = null;
let activeSessionPromise: Promise<unknown> | null = null;
let detachSessionListeners: (() => void) | null = null;

const RUNTIME_DIR = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

let currentConfig: WorkflowConfig = createWorkflowConfig();
let currentSummary: WorkflowConfigSummary = summarizeConfig(currentConfig);

function sendToRenderer(event: WorkflowIpcEvent): void {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send('workflow:event', event);
}

function broadcastConfigSummary(): void {
  sendToRenderer({ type: 'config-summary', payload: currentSummary });
}

function bindSessionEvents(session: WorkflowSession): () => void {
  const statusHandler = (status: WorkflowSessionStatusEvent) => {
    sendToRenderer({ type: 'session-status', payload: status });
  };
  const developerHandler = (developers: WorkflowSessionDeveloper[]) => {
    sendToRenderer({ type: 'developers', payload: developers });
  };
  const fileHandler = (fileEvent: WorkflowSessionFileEvent) => {
    sendToRenderer({ type: 'file-update', payload: fileEvent });
  };
  const runnerHandler = (runnerEvent: WorkflowSessionRunnerEvent) => {
    sendToRenderer({ type: 'runner-event', payload: runnerEvent });
  };
  const resultHandler = (result: unknown) => {
    sendToRenderer({ type: 'result', payload: result });
  };
  const errorHandler = (error: WorkflowSessionErrorEvent) => {
    sendToRenderer({ type: 'error', payload: error });
  };
  const chatHandler = (message: WorkflowSessionChatMessage) => {
    sendToRenderer({ type: 'chat-message', payload: message });
  };

  session.on('session-status', statusHandler);
  session.on('developers', developerHandler);
  session.on('file-update', fileHandler);
  session.on('runner-event', runnerHandler);
  session.on('result', resultHandler);
  session.on('error', errorHandler);
  session.on('chat-message', chatHandler);

  return () => {
    session.off('session-status', statusHandler);
    session.off('developers', developerHandler);
    session.off('file-update', fileHandler);
    session.off('runner-event', runnerHandler);
    session.off('result', resultHandler);
    session.off('error', errorHandler);
    session.off('chat-message', chatHandler);
  };
}

function clearActiveSession(): void {
  if (detachSessionListeners) {
    try {
      detachSessionListeners();
    } catch (error) {
      console.warn('Failed to detach workflow listeners', error);
    }
  }
  detachSessionListeners = null;
  activeSession = null;
  activeSessionPromise = null;
}

async function createWindow(): Promise<void> {
  if (mainWindow) {
    return;
  }

  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    webPreferences: {
      preload: join(RUNTIME_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'BigBoss Console',
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    const indexHtml = join(RUNTIME_DIR, '../renderer/index.html');
    await mainWindow.loadFile(indexHtml);
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createWorkflowConfig(options: { repoRoot?: string | null; projectName?: string | null } = {}): WorkflowConfig {
  const repoRoot = options.repoRoot?.trim() ?? '';
  const projectName = options.projectName?.trim() || deriveProjectName(repoRoot) || CONVERSATION_PROJECT_NAME;

  return {
    repoRoot,
    projectName,
    defaultBranch: 'main',
    developers: DEFAULT_DEVELOPERS,
    model: DEFAULT_MODEL,
  };
}

function summarizeConfig(config: WorkflowConfig): WorkflowConfigSummary {
  const repoRoot = config.repoRoot?.trim();
  return {
    mode: repoRoot ? 'full' : 'conversation',
    projectName: config.projectName,
    repoRoot: repoRoot || null,
  };
}

function deriveProjectName(repoRoot: string | null | undefined): string | null {
  if (!repoRoot) {
    return null;
  }
  const trimmed = repoRoot.trim();
  if (!trimmed) {
    return null;
  }
  return basename(trimmed);
}

async function stopActiveSession(): Promise<void> {
  if (!activeSession) {
    return;
  }

  try {
    await activeSession.stop();
  } catch (error) {
    console.warn('Error stopping workflow session', error);
  }

  if (activeSessionPromise) {
    try {
      await activeSessionPromise;
    } catch (error) {
      console.warn('Workflow session finished with error', error);
    }
  }
}

async function startWorkflowSession(config: WorkflowConfig): Promise<void> {
  await stopActiveSession();

  activeSession = new WorkflowSession(config);
  detachSessionListeners = bindSessionEvents(activeSession);

  activeSessionPromise = activeSession
    .run()
    .catch((error) => {
      console.error('Workflow session failed', error);
    })
    .finally(() => {
      clearActiveSession();
    });
}

async function applyConfig(config: WorkflowConfig): Promise<void> {
  currentConfig = config;
  currentSummary = summarizeConfig(config);
  broadcastConfigSummary();
  await startWorkflowSession(config);
}

async function handleChooseRepository(): Promise<WorkflowChooseRepoResponse> {
  if (!mainWindow) {
    return { updated: false, summary: currentSummary };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { updated: false, summary: currentSummary };
  }

  const repoRoot = result.filePaths[0];
  const projectName = deriveProjectName(repoRoot) ?? CONVERSATION_PROJECT_NAME;
  const config = createWorkflowConfig({ repoRoot, projectName });

  try {
    await applyConfig(config);
    return { updated: true, summary: currentSummary };
  } catch (error) {
    console.error('Failed to apply repository config', error);
    try {
      await applyConfig(createWorkflowConfig());
    } catch (recoveryError) {
      console.error('Failed to recover conversation session', recoveryError);
    }
    return { updated: false, summary: currentSummary };
  }
}

async function handleClearRepository(): Promise<WorkflowClearRepoResponse> {
  await applyConfig(createWorkflowConfig());
  return { summary: currentSummary };
}

ipcMain.handle(
  'workflow:chat-send',
  async (_event, request: WorkflowChatSendRequest): Promise<WorkflowChatSendResponse> => {
    if (!activeSession) {
      return { delivered: false, error: 'Workflow session is not ready.' };
    }

    try {
      await activeSession.sendChatMessage(request?.message ?? '');
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { delivered: false, error: message };
    }
  },
);

ipcMain.handle('workflow:get-config-summary', async (): Promise<WorkflowConfigSummaryResponse> => {
  return { summary: currentSummary };
});

ipcMain.handle('workflow:choose-repo', async (): Promise<WorkflowChooseRepoResponse> => {
  return handleChooseRepository();
});

ipcMain.handle('workflow:clear-repo', async (): Promise<WorkflowClearRepoResponse> => {
  return handleClearRepository();
});

app.whenReady().then(async () => {
  await createWindow();
  await applyConfig(currentConfig);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
      broadcastConfigSummary();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void app.quit();
  }
});

app.on('before-quit', async () => {
  await stopActiveSession();
});
