interface StatusBarProps {
  gameSocket: "connecting" | "open" | "closed";
  computerSocket: "connecting" | "open" | "closed";
  agents: number;
  mode: "demo" | "rom" | undefined;
}

export function StatusBar({ gameSocket, computerSocket, agents, mode }: StatusBarProps) {
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
      <span className="status-muted">SPECTATOR READ ONLY</span>
    </footer>
  );
}

function socketGlyph(state: "connecting" | "open" | "closed"): string {
  if (state === "open") return "✓";
  if (state === "connecting") return "…";
  return "×";
}
