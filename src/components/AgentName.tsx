import type { AgentIdentity } from "../../shared/types";

interface AgentNameProps extends AgentIdentity {
  onOpen: (agent: AgentIdentity) => void;
  className?: string;
}

export function AgentName({ agentId, displayName, onOpen, className }: AgentNameProps) {
  return (
    <button
      className={["agent-name", className].filter(Boolean).join(" ")}
      style={{ color: agentNameColor(agentId) }}
      type="button"
      title={`Open activity for ${displayName}`}
      onClick={() => onOpen({ agentId, displayName })}
    >
      {displayName}
    </button>
  );
}

export function agentNameColor(value: string): string {
  const colors = ["#53d9ed", "#ff9f43", "#bf8cff", "#68e0b5", "#ff6f7d", "#7ca7ff"];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length] ?? "#53d9ed";
}
