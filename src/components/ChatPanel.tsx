import type { AgentIdentity, ChatMessage } from "../../shared/types";
import { useReverseInfiniteLog } from "../hooks/useReverseInfiniteLog";
import { AgentName } from "./AgentName";

interface ChatPanelProps {
  messages: ChatMessage[];
  activeAgents: number;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  onAgentOpen: (agent: AgentIdentity) => void;
}

export function ChatPanel({
  messages,
  activeAgents,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onAgentOpen
}: ChatPanelProps) {
  const { logRef, newItemCount, scrollToLatest } = useReverseInfiniteLog({
    oldestSequence: messages[0]?.sequence,
    newestSequence: messages.at(-1)?.sequence,
    hasMore,
    loadingOlder,
    onLoadOlder
  });

  return (
    <section className="chat-panel" aria-labelledby="chat-heading">
      <div className="section-heading compact-heading">
        <h2 id="chat-heading">CHAT</h2>
        <span>{activeAgents} online</span>
      </div>
      <div className="log-shell">
        <div className="chat-log" ref={logRef} role="log" aria-live="polite">
          {messages.length === 0 ? (
            <p className="empty-state">No messages. The agents can use chat.read and chat.send.</p>
          ) : (
            <>
              <HistoryMarker hasMore={hasMore} loading={loadingOlder} label="CHAT" />
              {messages.map((item) => (
                <div className="chat-line" data-sequence={item.sequence} key={item.sequence}>
                  <time dateTime={new Date(item.createdAt).toISOString()}>{clock(item.createdAt)}</time>
                  <AgentName
                    agentId={item.agentId}
                    displayName={item.displayName}
                    onOpen={onAgentOpen}
                  />
                  <span>{item.message}</span>
                </div>
              ))}
            </>
          )}
        </div>
        {newItemCount > 0 ? (
          <button className="new-items-button" type="button" onClick={scrollToLatest}>
            {newItemCount} NEW ↓
          </button>
        ) : null}
      </div>
      <p className="mcp-only-note">
        SPECTATOR VIEW · AGENTS READ WITH <code>chat.read</code> AND SEND WITH <code>chat.send</code>
      </p>
    </section>
  );
}

function HistoryMarker({
  hasMore,
  loading,
  label
}: {
  hasMore: boolean;
  loading: boolean;
  label: string;
}) {
  return (
    <p className="history-marker" aria-live="polite">
      {loading ? `LOADING EARLIER ${label}…` : hasMore ? `SCROLL UP FOR EARLIER ${label}` : `START OF ${label}`}
    </p>
  );
}

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}
