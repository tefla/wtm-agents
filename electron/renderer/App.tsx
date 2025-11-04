import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WorkflowConfig } from '../../src/types';
import { DEFAULT_DEVELOPER_DESCRIPTION, DEFAULT_MODEL } from '../../src/types';
import type {
  WorkflowSessionDeveloper,
  WorkflowSessionFileEvent,
  WorkflowSessionStatusEvent,
} from '../../src/workflow';
import type {
  DeveloperFormDefinition,
  WorkflowIpcEvent,
  WorkflowStartRequest,
} from '../shared/types';

type FileContentMap = Record<string, string | null>;

const DEFAULT_TASK_PROMPT = 'Coordinate the team and deliver the requested outcome.';
const MAX_EVENT_LOG = 200;

const COMPLETION_STAGES = new Set(['completed', 'failed', 'cancelled']);

const createDeveloperForm = (index: number): DeveloperFormDefinition => ({
  name: `Developer ${index + 1}`,
  branch: `agents/dev-${index + 1}`,
  description: DEFAULT_DEVELOPER_DESCRIPTION,
  taskFileName: 'AGENT_TASKS.md',
  statusFileName: 'STATUS.md',
});

const fileKey = (event: WorkflowSessionFileEvent): string => `${event.kind}:${event.path}`;

const formatStage = (status: WorkflowSessionStatusEvent | null): string => {
  if (!status) {
    return 'idle';
  }
  return status.stage;
};

const formatTimestamp = (iso?: string): string => {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString();
};

const renderMarkdownLike = (content: string | null | undefined): string =>
  content ?? 'No content yet.';

const safeNumber = (value: string): number | undefined => {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safeArgs = (value: string): string[] | undefined => {
  if (!value.trim()) {
    return undefined;
  }
  return value.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g)?.map((token) => token.replaceAll(/["']/g, '')) ?? undefined;
};

const formatPayload = (payload: unknown): string => {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return String(payload);
  }
};

export default function App(): JSX.Element {
  const [task, setTask] = useState<string>(DEFAULT_TASK_PROMPT);
  const [repoRoot, setRepoRoot] = useState<string>('');
  const [wtmBinary, setWtmBinary] = useState<string>('');
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [codexCommand, setCodexCommand] = useState<string>('npx');
  const [codexArgs, setCodexArgs] = useState<string>('');
  const [clientTimeout, setClientTimeout] = useState<string>('360000');
  const [maxTurns, setMaxTurns] = useState<string>('');
  const [developersForm, setDevelopersForm] = useState<DeveloperFormDefinition[]>(() => [
    createDeveloperForm(0),
    createDeveloperForm(1),
  ]);

  const [workflowBridge, setWorkflowBridge] = useState<typeof window.workflowApi | null>(
    window.workflowApi ?? null,
  );
  const [sessionStatus, setSessionStatus] = useState<WorkflowSessionStatusEvent | null>(null);
  const [developers, setDevelopers] = useState<WorkflowSessionDeveloper[]>([]);
  const [fileContents, setFileContents] = useState<FileContentMap>({});
  const [eventLog, setEventLog] = useState<WorkflowIpcEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(
    workflowBridge ? null : 'Workflow bridge unavailable. Waiting for preload…',
  );

  useEffect(() => {
    if (workflowBridge) {
      return;
    }
    const interval = window.setInterval(() => {
      if (window.workflowApi) {
        setWorkflowBridge(window.workflowApi);
        setBridgeError(null);
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [workflowBridge]);

  useEffect(() => {
    if (!workflowBridge) {
      return;
    }
    setBridgeError(null);

    const unsubscribe = workflowBridge.onEvent((event) => {
      setEventLog((prev) => [...prev.slice(-MAX_EVENT_LOG + 1), event]);
      switch (event.type) {
        case 'session-status':
          setSessionStatus(event.payload);
          if (COMPLETION_STAGES.has(event.payload.stage)) {
            setIsRunning(false);
          } else {
            setIsRunning(true);
          }
          break;
        case 'developers':
          setDevelopers(event.payload);
          break;
        case 'file-update':
          setFileContents((prev) => ({
            ...prev,
            [fileKey(event.payload)]: event.payload.content,
          }));
          break;
        case 'result':
          setResult(event.payload);
          break;
        case 'error':
          setLastError(event.payload.message);
          break;
        default:
          break;
      }
    });
    return () => {
      unsubscribe();
    };
  }, [workflowBridge]);

  const handleStart = useCallback(async () => {
    if (!repoRoot.trim()) {
      setFormError('Repository path is required.');
      return;
    }

    const developerDefinitions = developersForm.map((developer, index) => ({
      name: developer.name?.trim() || `Developer ${index + 1}`,
      branch: developer.branch?.trim() || `agents/dev-${index + 1}`,
      description: developer.description?.trim() || DEFAULT_DEVELOPER_DESCRIPTION,
      taskFileName: developer.taskFileName?.trim() || undefined,
      statusFileName: developer.statusFileName?.trim() || undefined,
    }));

    const config: WorkflowConfig = {
      repoRoot: repoRoot.trim(),
      developers: developerDefinitions,
      model: model.trim() || undefined,
      wtmBinary: wtmBinary.trim() || undefined,
      codexCommand: codexCommand.trim() || undefined,
      codexArgs: safeArgs(codexArgs),
      clientSessionTimeoutSeconds: safeNumber(clientTimeout),
      maxTurns: safeNumber(maxTurns),
    };

    const request: WorkflowStartRequest = {
      config,
      task: task.trim() || undefined,
    };

    setFormError(null);
    setLastError(null);
    setResult(null);
    setEventLog([]);
    setFileContents({});
    setDevelopers([]);
    setSessionStatus(null);

    const api = window.workflowApi;
    if (!workflowBridge) {
      setBridgeError('Workflow bridge unavailable. Waiting for preload…');
      return;
    }

    try {
      await workflowBridge.startWorkflow(request);
      setIsRunning(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFormError(message);
      setIsRunning(false);
    }
  }, [
    codexArgs,
    codexCommand,
    clientTimeout,
    developersForm,
    maxTurns,
    model,
    repoRoot,
    task,
    wtmBinary,
  ]);

  const handleStop = useCallback(async () => {
    if (!workflowBridge) {
      setBridgeError('Workflow bridge unavailable. Waiting for preload…');
      return;
    }
    await workflowBridge.stopWorkflow();
  }, [workflowBridge]);

  const handleSelectRepo = useCallback(async () => {
    if (!workflowBridge) {
      setBridgeError('Workflow bridge unavailable. Waiting for preload…');
      return;
    }
    const resultSelection = await workflowBridge.selectDirectory();
    if (!resultSelection.canceled && resultSelection.path) {
      setRepoRoot(resultSelection.path);
    }
  }, []);

  const addDeveloper = useCallback(() => {
    setDevelopersForm((prev) => [...prev, createDeveloperForm(prev.length)]);
  }, []);

  const removeDeveloper = useCallback((index: number) => {
    setDevelopersForm((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const updateDeveloperField = useCallback(
    (index: number, field: keyof DeveloperFormDefinition, value: string) => {
      setDevelopersForm((prev) =>
        prev.map((developer, currentIndex) =>
          currentIndex === index
            ? {
                ...developer,
                [field]: value,
              }
            : developer,
        ),
      );
    },
    [],
  );

  const overviewEntry = useMemo(() => {
    const entry = Object.entries(fileContents).find(([key]) => key.startsWith('overview:'));
    if (!entry) {
      return null;
    }
    return {
      path: entry[0].slice('overview:'.length),
      content: entry[1],
    };
  }, [fileContents]);

  const teamEntry = useMemo(() => {
    const entry = Object.entries(fileContents).find(([key]) => key.startsWith('team:'));
    if (!entry) {
      return null;
    }
    return {
      path: entry[0].slice('team:'.length),
      content: entry[1],
    };
  }, [fileContents]);

  const developerPanels = useMemo(
    () =>
      developers.map((developer) => {
        const tasks = fileContents[`task:${developer.taskFile}`];
        const status = fileContents[`status:${developer.statusFile}`];
        return (
          <div key={developer.handoffToken} className="developer-card">
            <header>
              <h3>{developer.name}</h3>
              <span className="developer-branch">{developer.branch}</span>
            </header>
            <p className="developer-description">{developer.description}</p>
            <div className="developer-files">
              <div>
                <h4>Tasks</h4>
                <code>{developer.taskFile}</code>
                <pre>{renderMarkdownLike(tasks)}</pre>
              </div>
              <div>
                <h4>Status</h4>
                <code>{developer.statusFile}</code>
                <pre>{renderMarkdownLike(status)}</pre>
              </div>
            </div>
          </div>
        );
      }),
    [developers, fileContents],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>WTM Workflow Console</h1>
          <p>Drive the multi-agent workflow with a visual dashboard.</p>
        </div>
        <div className={`status-indicator status-${formatStage(sessionStatus)}`}>
          <span>{formatStage(sessionStatus)}</span>
          {sessionStatus?.message ? <small>{sessionStatus.message}</small> : null}
          {sessionStatus?.timestamp ? (
            <small>Updated {formatTimestamp(sessionStatus.timestamp)}</small>
          ) : null}
        </div>
      </header>

      <main className="layout">
        <section className="control-panel">
          <h2>Workflow Configuration</h2>
          <div className="form-group">
            <label htmlFor="task">Task Prompt</label>
            <textarea
              id="task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              disabled={isRunning}
            />
          </div>

          <div className="form-group">
            <label htmlFor="repo">Repository Root</label>
            <div className="input-with-button">
              <input
                id="repo"
                type="text"
                value={repoRoot}
                onChange={(event) => setRepoRoot(event.target.value)}
                placeholder="/path/to/repo"
                disabled={isRunning}
              />
              <button type="button" onClick={handleSelectRepo} disabled={isRunning}>
                Browse…
              </button>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="wtm">WTM Binary (optional)</label>
            <input
              id="wtm"
              type="text"
              value={wtmBinary}
              onChange={(event) => setWtmBinary(event.target.value)}
              placeholder="wtm"
              disabled={isRunning}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="model">Model</label>
              <input
                id="model"
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="form-group">
              <label htmlFor="max-turns">Max Turns (optional)</label>
              <input
                id="max-turns"
                type="number"
                inputMode="numeric"
                value={maxTurns}
                onChange={(event) => setMaxTurns(event.target.value)}
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="codex-command">Codex Command</label>
              <input
                id="codex-command"
                type="text"
                value={codexCommand}
                onChange={(event) => setCodexCommand(event.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="form-group">
              <label htmlFor="codex-args">Codex Arguments</label>
              <input
                id="codex-args"
                type="text"
                value={codexArgs}
                placeholder="-y codex mcp-server"
                onChange={(event) => setCodexArgs(event.target.value)}
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="client-timeout">Client Session Timeout (ms)</label>
            <input
              id="client-timeout"
              type="number"
              inputMode="numeric"
              value={clientTimeout}
              onChange={(event) => setClientTimeout(event.target.value)}
              disabled={isRunning}
            />
          </div>

          <h3>Developers</h3>
          <p className="hint">
            Configure the roster that mirrors the CLI defaults. Each developer writes to their own
            task and status files.
          </p>

          {developersForm.map((developer, index) => (
            <div key={index} className="developer-form">
              <div className="developer-form-header">
                <h4>Developer {index + 1}</h4>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => removeDeveloper(index)}
                  disabled={isRunning || developersForm.length <= 1}
                >
                  Remove
                </button>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor={`developer-name-${index}`}>Name</label>
                  <input
                    id={`developer-name-${index}`}
                    type="text"
                    value={developer.name ?? ''}
                    onChange={(event) => updateDeveloperField(index, 'name', event.target.value)}
                    disabled={isRunning}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor={`developer-branch-${index}`}>Branch</label>
                  <input
                    id={`developer-branch-${index}`}
                    type="text"
                    value={developer.branch ?? ''}
                    onChange={(event) => updateDeveloperField(index, 'branch', event.target.value)}
                    disabled={isRunning}
                  />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor={`developer-description-${index}`}>Description</label>
                <input
                  id={`developer-description-${index}`}
                  type="text"
                  value={developer.description ?? ''}
                  onChange={(event) =>
                    updateDeveloperField(index, 'description', event.target.value)
                  }
                  disabled={isRunning}
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor={`developer-task-${index}`}>Task File</label>
                  <input
                    id={`developer-task-${index}`}
                    type="text"
                    value={developer.taskFileName ?? ''}
                    onChange={(event) =>
                      updateDeveloperField(index, 'taskFileName', event.target.value)
                    }
                    disabled={isRunning}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor={`developer-status-${index}`}>Status File</label>
                  <input
                    id={`developer-status-${index}`}
                    type="text"
                    value={developer.statusFileName ?? ''}
                    onChange={(event) =>
                      updateDeveloperField(index, 'statusFileName', event.target.value)
                    }
                    disabled={isRunning}
                  />
                </div>
              </div>
            </div>
          ))}

          <button type="button" className="secondary" onClick={addDeveloper} disabled={isRunning}>
            Add Developer
          </button>

          {bridgeError ? <p className="error-banner">{bridgeError}</p> : null}
          {formError ? <p className="error-banner">{formError}</p> : null}
          {lastError ? <p className="error-banner">Runtime: {lastError}</p> : null}

          <div className="actions">
            <button
              type="button"
              onClick={handleStart}
              disabled={isRunning || Boolean(bridgeError)}
            >
              Start Workflow
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleStop}
              disabled={!isRunning || Boolean(bridgeError)}
            >
              Stop
            </button>
          </div>
        </section>

        <section className="status-panel">
          <h2>Agent Activity</h2>
          {developerPanels.length === 0 ? (
            <p className="placeholder">
              No developer updates yet. Start a workflow to populate this view.
            </p>
          ) : (
            <div className="developer-grid">{developerPanels}</div>
          )}

          <div className="shared-grid">
            <div className="shared-card">
              <header>
                <h3>Project Overview</h3>
                <code>{overviewEntry?.path ?? 'PROJECT_OVERVIEW.md'}</code>
              </header>
              <pre>{renderMarkdownLike(overviewEntry?.content ?? null)}</pre>
            </div>
            <div className="shared-card">
              <header>
                <h3>Team Status</h3>
                <code>{teamEntry?.path ?? 'TEAM_STATUS.md'}</code>
              </header>
              <pre>{renderMarkdownLike(teamEntry?.content ?? null)}</pre>
            </div>
          </div>

          {result ? (
            <div className="result-card">
              <header>
                <h3>Final Result</h3>
              </header>
              <pre>{formatPayload(result)}</pre>
            </div>
          ) : null}

          <div className="log-card">
            <header>
              <h3>Event Stream</h3>
              <span>{eventLog.length} events</span>
            </header>
            <ul>
              {eventLog
                .slice()
                .reverse()
                .map((event, index) => (
                  <li key={`${event.type}-${index}`}>
                    <span className="event-type">{event.type}</span>
                    <pre>{formatPayload(event.payload)}</pre>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
