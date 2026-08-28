import type { AgentIdentity, ComputerEvent } from "../../shared/types";
import { useReverseInfiniteLog } from "../hooks/useReverseInfiniteLog";
import { AgentName } from "./AgentName";

interface EventStreamProps {
  events: ComputerEvent[];
  live: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  onAgentOpen: (agent: AgentIdentity) => void;
}

export function EventStream({
  events,
  live,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onAgentOpen
}: EventStreamProps) {
  const { logRef, newItemCount, scrollToLatest } = useReverseInfiniteLog({
    oldestSequence: events[0]?.sequence,
    newestSequence: events.at(-1)?.sequence,
    hasMore,
    loadingOlder,
    onLoadOlder
  });

  return (
    <section className="event-panel" aria-labelledby="events-heading">
      <div className="section-heading compact-heading">
        <h2 id="events-heading">COMPUTER EVENTS</h2>
        <span className={live ? "live-label" : "offline-label"}>
          {live ? "LIVE ●" : "RECONNECTING"}
        </span>
      </div>
      <div className="log-shell">
        <div className="event-log" ref={logRef} role="log" aria-live="polite">
          {events.length === 0 ? (
            <p className="empty-state">No commands yet. Agent commands will appear here.</p>
          ) : (
            <>
              <p className="history-marker" aria-live="polite">
                {loadingOlder
                  ? "LOADING EARLIER EVENTS…"
                  : hasMore
                    ? "SCROLL UP FOR EARLIER EVENTS"
                    : "START OF COMPUTER EVENTS"}
              </p>
              {events.map((event) => (
                <article
                  className={`computer-event ${event.exitCode === 0 ? "is-ok" : "is-error"}`}
                  data-sequence={event.sequence}
                  key={event.sequence}
                >
                  <span className="event-mark" aria-hidden="true" />
                  <time dateTime={new Date(event.createdAt).toISOString()}>{preciseClock(event.createdAt)}</time>
                  {event.agentId === "system" ? (
                    <strong>{event.displayName}</strong>
                  ) : (
                    <AgentName
                      agentId={event.agentId}
                      displayName={event.displayName}
                      onOpen={onAgentOpen}
                    />
                  )}
                  <div className="event-body">
                    <code>{event.command ?? event.eventType}</code>
                    {event.stdoutPreview ? <pre>{event.stdoutPreview}</pre> : null}
                    {event.stderrPreview ? <pre className="stderr">{event.stderrPreview}</pre> : null}
                  </div>
                  <span className="event-rev">#{event.filesystemRevision}</span>
                </article>
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
    </section>
  );
}

function preciseClock(timestamp: number): string {
  const date = new Date(timestamp);
  const base = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
