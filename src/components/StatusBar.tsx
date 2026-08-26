import type { WebMcpStatus } from "../webmcp";

interface StatusBarProps {
  gameSocket: "connecting" | "open" | "closed";
  computerSocket: "connecting" | "open" | "closed";
  webMcpStatus: WebMcpStatus;
  agents: number;
  mode: "demo" | "rom" | undefined;
}

export function StatusBar({ gameSocket, computerSocket, webMcpStatus, agents, mode }: StatusBarProps) {
  const bothOpen = gameSocket === "open" && computerSocket === "open";
  return (
    <footer className="status-bar">
      <span className={bothOpen ? "status-good" : "status-warn"}>⌁ {bothOpen ? "CONNECTED" : "CONNECTING"}</span>
      <i />
      <span>GAME WS {socketGlyph(gameSocket)}</span>
      <i />
      <span>COMPUTER WS {socketGlyph(computerSocket)}</span>
      <i />
      <span>AGENTS {agents}</span>
      <i />
      <span>GAME {mode === "rom" ? "ROM" : "DEMO"}</span>
      <i />
      <span className={webMcpStatus === "available" ? "status-good" : "status-muted"}>
        ◈ WEBMCP {webMcpLabel(webMcpStatus)}
      </span>
    </footer>
  );
}

function socketGlyph(state: "connecting" | "open" | "closed"): string {
  if (state === "open") return "✓";
  if (state === "connecting") return "…";
  return "×";
}

function webMcpLabel(status: WebMcpStatus): string {
  if (status === "available") return "TOOLS AVAILABLE";
  if (status === "unavailable") return "NOT IN THIS BROWSER";
  if (status === "error") return "TOOL ERROR";
  return "REGISTERING";
}
