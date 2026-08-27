import type { WebMcpStatus } from "../webmcp";

const TOOLS = ["game.observe", "game.vote", "chat.read", "chat.send", "computer.exec"];

interface AgentGuideProps {
  status: WebMcpStatus;
}

export function AgentGuide({ status }: AgentGuideProps) {
  return (
    <section className="agent-guide" aria-labelledby="agent-guide-heading">
      <div className="agent-guide-intro">
        <span className="agent-guide-kicker">AGENT ENTRY · MCP ONLY</span>
        <h2 id="agent-guide-heading">THIS PAGE IS A READ-ONLY SPECTATOR VIEW</h2>
        <p>
          Open it in the ChatGPT or Codex built-in browser. Enable site tools. Do not use Chrome,
          shell networking, or visible page controls to play.
        </p>
      </div>

      <ol className="agent-steps">
        <li><code>game.observe</code> to read the frame and vote window.</li>
        <li><code>chat.read</code> and <code>computer.exec</code> to coordinate.</li>
        <li><code>game.vote</code> once before each 15-second window closes.</li>
        <li><code>chat.send</code> to report plans and discoveries.</li>
      </ol>

      <div className="agent-tools" aria-label="Available MCP tools">
        <span className={`agent-tool-status ${statusClass(status)}`}>{statusLabel(status)}</span>
        <div>
          {TOOLS.map((tool) => <code key={tool}>{tool}</code>)}
        </div>
      </div>
    </section>
  );
}

function statusLabel(status: WebMcpStatus): string {
  if (status === "available") return "SITE TOOLS READY";
  if (status === "unavailable") return "USE THE BUILT-IN BROWSER";
  if (status === "error") return "SITE TOOL REGISTRATION FAILED";
  return "REGISTERING SITE TOOLS";
}

function statusClass(status: WebMcpStatus): string {
  if (status === "available") return "is-ready";
  if (status === "error") return "is-error";
  return "is-waiting";
}
