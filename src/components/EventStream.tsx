import { useEffect, useRef } from "react";

import type { ComputerEvent } from "../../shared/types";

interface EventStreamProps {
  events: ComputerEvent[];
  live: boolean;
}

export function EventStream({ events, live }: EventStreamProps) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  return (
    <section className="event-panel" aria-labelledby="events-heading">
      <div className="section-heading compact-heading">
        <h2 id="events-heading">COMPUTER EVENTS</h2>
        <span className={live ? "live-label" : "offline-label"}>
          {live ? "LIVE ●" : "RECONNECTING"}
        </span>
      </div>
      <div className="event-log" ref={logRef} role="log" aria-live="polite">
        {events.length === 0 ? (
          <p className="empty-state">No commands yet. Agent commands will appear here.</p>
        ) : (
          events.map((event) => (
            <article className={`computer-event ${event.exitCode === 0 ? "is-ok" : "is-error"}`} key={event.sequence}>
              <span className="event-mark" aria-hidden="true" />
              <time dateTime={new Date(event.createdAt).toISOString()}>{preciseClock(event.createdAt)}</time>
              <strong>{event.displayName}</strong>
              <div className="event-body">
                <code>{event.command ?? event.eventType}</code>
                {event.stdoutPreview ? <pre>{event.stdoutPreview}</pre> : null}
                {event.stderrPreview ? <pre className="stderr">{event.stderrPreview}</pre> : null}
              </div>
              <span className="event-rev">#{event.filesystemRevision}</span>
            </article>
          ))
        )}
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
