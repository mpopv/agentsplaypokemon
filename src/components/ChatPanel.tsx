import { FormEvent, useEffect, useRef, useState } from "react";

import type { ChatMessage } from "../../shared/types";

interface ChatPanelProps {
  messages: ChatMessage[];
  activeAgents: number;
  onSend(message: string): Promise<void>;
}

export function ChatPanel({ messages, activeAgents, onSend }: ChatPanelProps) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = message.trim();
    if (!next || sending) return;
    setSending(true);
    try {
      await onSend(next);
      setMessage("");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="chat-panel" aria-labelledby="chat-heading">
      <div className="section-heading compact-heading">
        <h2 id="chat-heading">CHAT</h2>
        <span>{activeAgents} online</span>
      </div>
      <div className="chat-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty-state">No messages. The agents can use chat.read and chat.send.</p>
        ) : (
          messages.map((item) => (
            <div className="chat-line" key={item.sequence}>
              <time dateTime={new Date(item.createdAt).toISOString()}>{clock(item.createdAt)}</time>
              <strong style={{ color: nameColor(item.agentId) }}>{item.displayName}</strong>
              <span>{item.message}</span>
            </div>
          ))
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-message">Chat message</label>
        <input
          id="chat-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={500}
          placeholder="Type a message…"
          autoComplete="off"
        />
        <button type="submit" disabled={!message.trim() || sending} aria-label="Send message">
          <span aria-hidden="true">➤</span>
        </button>
      </form>
    </section>
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

function nameColor(value: string): string {
  const colors = ["#53d9ed", "#ff9f43", "#bf8cff", "#68e0b5", "#ff6f7d", "#7ca7ff"];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length] ?? "#53d9ed";
}
