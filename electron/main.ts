import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';

import {
  WorkflowSession,
  type WorkflowSessionDeveloper,
  type WorkflowSessionErrorEvent,
  type WorkflowSessionFileEvent,
  type WorkflowSessionRunnerEvent,
  type WorkflowSessionStatusEvent,
} from '../src/workflow';
import type {
  WorkflowIpcEvent,
  WorkflowSelectDirectoryResponse,
  WorkflowStartRequest,
  WorkflowStartResponse,
  WorkflowStopResponse,
} from './shared/types';

const DEFAULT_WINDOW_BOUNDS = {
  width: 1280,
  height: 900,
  minWidth: 1024,
  minHeight: 720,
};

let mainWindow: BrowserWindow | null = null;
let activeSession: WorkflowSession | null = null;
let detachSessionListeners: (() => void) | null = null;
const RUNTIME_DIR = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

function sendToRenderer(event: WorkflowIpcEvent): void {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send('workflow:event', event);
}

function bindSessionEvents(session: WorkflowSession): () => void {
  const statusHandler = (status: WorkflowSessionStatusEvent) => {
    sendToRenderer({ type: 'session-status', payload: status });
  };
  const developerHandler = (developers: WorkflowSessionDeveloper[]) => {
    sendToRenderer({ type: 'developers', payload: developers });
  };
  const fileHandler = (event: WorkflowSessionFileEvent) => {
    sendToRenderer({ type: 'file-update', payload: event });
  };
  const runnerHandler = (event: WorkflowSessionRunnerEvent) => {
    sendToRenderer({ type: 'runner-event', payload: event });
  };
  const resultHandler = (result: unknown) => {
    sendToRenderer({ type: 'result', payload: result });
  };
  const errorHandler = (error: WorkflowSessionErrorEvent) => {
    sendToRenderer({ type: 'error', payload: error });
  };

  session.on('session-status', statusHandler);
  session.on('developers', developerHandler);
  session.on('file-update', fileHandler);
  session.on('runner-event', runnerHandler);
  session.on('result', resultHandler);
  session.on('error', errorHandler);

  return () => {
    session.off('session-status', statusHandler);
    session.off('developers', developerHandler);
    session.off('file-update', fileHandler);
    session.off('runner-event', runnerHandler);
    session.off('result', resultHandler);
    session.off('error', errorHandler);
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
    title: 'WTM Workflow Console',
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

ipcMain.handle(
  'workflow:start',
  async (_event, request: WorkflowStartRequest): Promise<WorkflowStartResponse> => {
    if (activeSession) {
      throw new Error('A workflow session is already running.');
    }

    activeSession = new WorkflowSession(request.config);
    detachSessionListeners = bindSessionEvents(activeSession);

    activeSession
      .run(request.task)
      .catch((error) => {
        console.error('Workflow session failed', error);
      })
      .finally(() => {
        clearActiveSession();
      });

    return { started: true };
  },
);

ipcMain.handle('workflow:stop', async (): Promise<WorkflowStopResponse> => {
  if (!activeSession) {
    return { stopped: false };
  }
  await activeSession.stop();
  return { stopped: true };
});

ipcMain.handle('workflow:select-directory', async (): Promise<WorkflowSelectDirectoryResponse> => {
  if (!mainWindow) {
    return { canceled: true };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void app.quit();
  }
});

app.on('before-quit', async () => {
  if (activeSession) {
    try {
      await activeSession.stop();
    } catch (error) {
      console.warn('Error while stopping workflow session during quit', error);
    }
  }
});
