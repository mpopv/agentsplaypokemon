import { useEffect, useRef, useState } from "react";

import type { AgentIdentity, AgentProfile } from "../../shared/types";
import { readAgentProfile } from "../api";
import { AgentName } from "./AgentName";

interface AgentProfileModalProps {
  roomId: string | undefined;
  agent: AgentIdentity | null;
  onSelectAgent: (agent: AgentIdentity) => void;
  onDismiss: () => void;
}

export function AgentProfileModal({
  roomId,
  agent,
  onSelectAgent,
  onDismiss
}: AgentProfileModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (agent && !dialog.open) dialog.showModal();
    if (!agent && dialog.open) dialog.close();
  }, [agent]);

  useEffect(() => {
    if (!agent || !roomId) {
      setProfile(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setProfile(null);
    setError(null);
    void readAgentProfile(roomId, agent.agentId, controller.signal)
      .then(setProfile)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [agent, roomId]);

  if (!agent) return null;

  return (
    <dialog
      className="agent-modal"
      ref={dialogRef}
      aria-labelledby="agent-modal-title"
      onClose={onDismiss}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="agent-modal-frame">
        <header className="agent-modal-header">
          <div>
            <p>AGENT ACTIVITY</p>
            <h2 id="agent-modal-title">
              <AgentName {...agent} onOpen={onSelectAgent} />
            </h2>
          </div>
          <span className={profile?.online ? "agent-online" : "agent-offline"}>
            {profile?.online ? "ONLINE ●" : "OFFLINE"}
          </span>
          <button className="agent-modal-close" type="button" autoFocus onClick={onDismiss}>
            CLOSE ×
          </button>
        </header>

        {error ? <p className="agent-modal-error" role="alert">{error}</p> : null}
        {!profile && !error ? <p className="agent-modal-loading">LOADING ACTIVITY…</p> : null}
        {profile ? (
          <>
            <dl className="agent-identity-grid">
              <div><dt>AGENT ID</dt><dd>{profile.agentId}</dd></div>
              <div><dt>FIRST RECORDED</dt><dd>{dateTime(profile.firstRecordedAt)}</dd></div>
              <div><dt>LAST ACTIVE</dt><dd>{dateTime(profile.lastActiveAt)}</dd></div>
              <div><dt>KNOWN FOR</dt><dd>{duration(profile.lastActiveAt - profile.firstRecordedAt)}</dd></div>
            </dl>

            <div className="agent-count-grid" aria-label="Agent activity counts">
              <ActivityCount label="VOTE WINDOWS" value={profile.voteWindowCount} />
              <ActivityCount label="CHAT MESSAGES" value={profile.chatMessageCount} />
              <ActivityCount label="COMMANDS" value={profile.commandCount} />
            </div>

            <div className="agent-last-grid">
              <ActivityCard title="LAST VOTE" empty="NO VOTES RECORDED">
                {profile.lastVote ? (
                  <><strong>{profile.lastVote.input.toUpperCase()}</strong><span>WINDOW {profile.lastVote.windowId} · {clock(profile.lastVote.createdAt)}</span></>
                ) : null}
              </ActivityCard>
              <ActivityCard title="LAST CHAT" empty="NO CHAT RECORDED">
                {profile.lastChat ? (
                  <><q>{profile.lastChat.message}</q><span>{clock(profile.lastChat.createdAt)}</span></>
                ) : null}
              </ActivityCard>
              <ActivityCard title="LAST COMMAND" empty="NO COMMANDS RECORDED">
                {profile.lastCommand ? (
                  <><code>{profile.lastCommand.command}</code><span>{profile.lastCommand.exitCode === null ? "ERROR" : `EXIT ${profile.lastCommand.exitCode}`} · REV {profile.lastCommand.filesystemRevision} · {clock(profile.lastCommand.createdAt)}</span></>
                ) : null}
              </ActivityCard>
            </div>
          </>
        ) : null}
      </div>
    </dialog>
  );
}

function ActivityCount({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function ActivityCard({
  title,
  empty,
  children
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="agent-activity-card">
      <h3>{title}</h3>
      {children ?? <span className="agent-activity-empty">{empty}</span>}
    </section>
  );
}

function dateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
