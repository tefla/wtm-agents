import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type {
  WorkflowChatMessage,
  WorkflowChatSendResponse,
  WorkflowConfigSummary,
  WorkflowIpcEvent,
} from '../shared/types';
import type { WorkflowSessionStatusEvent } from '../../src/workflow';

const MAX_CHAT_LOG = 500;

const formatStage = (status: WorkflowSessionStatusEvent | null): string => {
  if (!status) {
    return 'initializing';
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

type WorkflowApi = typeof window.workflowApi;

export default function App(): JSX.Element {
  const [workflowBridge, setWorkflowBridge] = useState<WorkflowApi | null>(
    window.workflowApi ?? null,
  );
  const [bridgeError, setBridgeError] = useState<string | null>(
    workflowBridge ? null : 'Workflow bridge unavailable. Waiting for preload…',
  );
  const [sessionStatus, setSessionStatus] = useState<WorkflowSessionStatusEvent | null>(null);
  const [chatMessages, setChatMessages] = useState<WorkflowChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [isSendingChat, setIsSendingChat] = useState<boolean>(false);
  const [isUpdatingRepo, setIsUpdatingRepo] = useState<boolean>(false);
  const [configSummary, setConfigSummary] = useState<WorkflowConfigSummary | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

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

    let cancelled = false;

    workflowBridge
      .getConfigSummary()
      .then((summary) => {
        if (!cancelled) {
          setConfigSummary(summary);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setBridgeError(message);
        }
      });

    const unsubscribe = workflowBridge.onEvent((event: WorkflowIpcEvent) => {
      switch (event.type) {
        case 'session-status':
          setSessionStatus(event.payload);
          break;
        case 'chat-message':
          setChatMessages((prev) => [...prev.slice(-MAX_CHAT_LOG + 1), event.payload]);
          break;
        case 'config-summary':
          setConfigSummary(event.payload);
          break;
        case 'error':
          setLastError(event.payload.message);
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workflowBridge]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const canInteractWithChat = useMemo(() => {
    if (!workflowBridge || bridgeError) {
      return false;
    }

    const stage = sessionStatus?.stage;
    return stage === 'running' || stage === 'interactive';
  }, [workflowBridge, bridgeError, sessionStatus]);

  const handleSendChat = useCallback(async () => {
    const trimmed = chatInput.trim();
    if (!workflowBridge || !trimmed || !canInteractWithChat) {
      return;
    }

    setIsSendingChat(true);
    setChatError(null);

    try {
      const response: WorkflowChatSendResponse = await workflowBridge.sendChatMessage(trimmed);
      if (response.delivered) {
        setChatInput('');
      } else {
        setChatError(response.error ?? 'Message was not delivered.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChatError(message);
    } finally {
      setIsSendingChat(false);
    }
  }, [canInteractWithChat, chatInput, workflowBridge]);

  const handleChatKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleSendChat();
      }
    },
    [handleSendChat],
  );

  const handleChooseRepository = useCallback(async () => {
    if (!workflowBridge) {
      setBridgeError('Workflow bridge unavailable. Waiting for preload…');
      return;
    }

    setIsUpdatingRepo(true);
    try {
      const result = await workflowBridge.chooseRepository();
      setConfigSummary(result.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBridgeError(message);
    } finally {
      setIsUpdatingRepo(false);
    }
  }, [workflowBridge]);

  const handleClearRepository = useCallback(async () => {
    if (!workflowBridge) {
      setBridgeError('Workflow bridge unavailable. Waiting for preload…');
      return;
    }

    setIsUpdatingRepo(true);
    try {
      const result = await workflowBridge.clearRepository();
      setConfigSummary(result.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBridgeError(message);
    } finally {
      setIsUpdatingRepo(false);
    }
  }, [workflowBridge]);

  const statusText = sessionStatus?.message ?? 'Connecting to BigBoss…';
  const projectLabel = configSummary?.projectName ?? 'Unassigned Project';
  const repoLabel = configSummary?.repoRoot ?? 'Repository not set';
  const chatTextareaDisabled = !canInteractWithChat || isSendingChat;
  const chatSendDisabled = chatTextareaDisabled || chatInput.trim().length === 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <h1>BigBoss Console</h1>
          <p className="header-project">Project: {projectLabel}</p>
          <p className="header-repo">{repoLabel}</p>
        </div>
        <div className={`status-indicator status-${formatStage(sessionStatus)}`}>
          <span>{formatStage(sessionStatus)}</span>
          <small>{statusText}</small>
          {sessionStatus?.timestamp ? (
            <small>Updated {formatTimestamp(sessionStatus.timestamp)}</small>
          ) : null}
        </div>
      </header>

      <main className="chat-main">
        <div className="chat-toolbar">
          <div className="chat-mode">
            <span className={`chat-mode-badge chat-mode-${configSummary?.mode ?? 'conversation'}`}>
              {configSummary?.mode ?? 'conversation'}
            </span>
            <span>
              {configSummary?.mode === 'full'
                ? 'Repository connected'
                : 'Discovery mode — no repository attached'}
            </span>
          </div>
          <div className="chat-actions">
            <button
              type="button"
              onClick={handleChooseRepository}
              disabled={!workflowBridge || isUpdatingRepo}
            >
              {isUpdatingRepo ? 'Updating…' : 'Set Repository'}
            </button>
            {configSummary?.mode === 'full' ? (
              <button
                type="button"
                className="ghost"
                onClick={handleClearRepository}
                disabled={!workflowBridge || isUpdatingRepo}
              >
                Clear Repository
              </button>
            ) : null}
          </div>
        </div>

        {bridgeError ? <p className="error-banner">{bridgeError}</p> : null}
        {chatError ? <p className="chat-error">Chat error: {chatError}</p> : null}
        {lastError ? <p className="error-banner">Runtime: {lastError}</p> : null}

        <section className="chat-panel">
          <div className="chat-messages">
            {chatMessages.length === 0 ? (
              <p className="chat-empty">No messages yet. Say hello to BigBoss.</p>
            ) : (
              chatMessages.map((message) => (
                <div key={message.id} className={`chat-message chat-${message.role}`}>
                  <div className="chat-meta">
                    <span className="chat-sender">{message.sender}</span>
                    {message.timestamp ? (
                      <span className="chat-time">{formatTimestamp(message.timestamp)}</span>
                    ) : null}
                  </div>
                  <div className="chat-text">{message.content}</div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-row">
            <textarea
              value={chatInput}
              onChange={(event) => {
                setChatInput(event.target.value);
                if (chatError) {
                  setChatError(null);
                }
              }}
              onKeyDown={handleChatKeyDown}
              placeholder={
                canInteractWithChat
                  ? 'Send a message to BigBoss…'
                  : 'Waiting for BigBoss to come online'
              }
              disabled={chatTextareaDisabled}
            />
            <button type="button" onClick={handleSendChat} disabled={chatSendDisabled}>
              {isSendingChat ? 'Sending…' : 'Send'}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
