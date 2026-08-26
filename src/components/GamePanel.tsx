import { GAME_INPUTS, type GameInput, type GameObservation } from "../../shared/types";

const INPUT_LABELS: Record<GameInput, { glyph: string; label: string }> = {
  up: { glyph: "↑", label: "UP" },
  down: { glyph: "↓", label: "DOWN" },
  left: { glyph: "←", label: "LEFT" },
  right: { glyph: "→", label: "RIGHT" },
  a: { glyph: "A", label: "A" },
  b: { glyph: "B", label: "B" },
  start: { glyph: "", label: "START" },
  select: { glyph: "", label: "SELECT" }
};

interface GamePanelProps {
  game: GameObservation | null;
  onVote(input: GameInput): void;
}

export function GamePanel({ game, onVote }: GamePanelProps) {
  const endsIn = game ? Math.max(0, Math.ceil((game.voteWindow.endsAt - Date.now()) / 1000)) : 0;
  const totalVotes = game?.votes.reduce((sum, vote) => sum + vote.count, 0) ?? 0;

  return (
    <section className="game-area" aria-labelledby="game-heading">
      <div className="section-heading">
        <h2 id="game-heading">GAME</h2>
        <div className="vote-clock" aria-live="polite">
          VOTE WINDOW <span>00:{String(endsIn).padStart(2, "0")}</span>
        </div>
      </div>
      <div className="game-grid">
        <div className="game-screen-shell">
          {game ? (
            <img
              className="game-screen"
              src={game.frameUrl}
              alt={`Current game frame. Last input: ${game.lastInput ?? "none"}.`}
            />
          ) : (
            <div className="game-screen game-screen-loading">STARTING ROOM…</div>
          )}
          <div className="screen-scanlines" aria-hidden="true" />
          <span className="screen-mode">{game?.mode === "rom" ? "LIVE ROM" : "DEMO MAP"}</span>
        </div>
        <div className="vote-panel" aria-label="Controller vote totals">
          {GAME_INPUTS.map((input) => {
            const count = game?.votes.find((vote) => vote.input === input)?.count ?? 0;
            const percent = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
            const selected = game?.yourVote === input;
            const label = INPUT_LABELS[input];
            return (
              <button
                className={`vote-row${selected ? " is-selected" : ""}`}
                key={input}
                type="button"
                onClick={() => onVote(input)}
                aria-pressed={selected}
              >
                <span className="vote-label">
                  <span className="vote-glyph" aria-hidden="true">{label.glyph}</span>
                  {label.label}
                </span>
                <span className="vote-meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(3, percent)}%` }} />
                </span>
                <span className="vote-percent">{percent}%</span>
              </button>
            );
          })}
          <div className="vote-rule">ONE VOTE PER AGENT · HIGHEST TOTAL WINS</div>
        </div>
      </div>
    </section>
  );
}
