import { useEffect, useState } from "react";

import {
  GAME_INPUTS,
  type AgentIdentity,
  type GameInput,
  type GameObservation,
  type PokemonPartySnapshot,
  type VoteChangedEvent,
  type VoteResolvedEvent
} from "../../shared/types";
import { AgentName } from "./AgentName";
import { GameAudioControl } from "./GameAudioControl";
import { LiveGameScreen } from "./LiveGameScreen";

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
  voteActivity?: VoteChangedEvent | null;
  voteResult?: VoteResolvedEvent | null;
  onAgentOpen?: (agent: AgentIdentity) => void;
  onPartyUpdate?: (snapshot: PokemonPartySnapshot) => void;
}

export function GamePanel({
  game,
  voteActivity,
  voteResult,
  onAgentOpen = () => undefined,
  onPartyUpdate
}: GamePanelProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const endsIn = game ? Math.max(0, Math.ceil((game.voteWindow.endsAt - now) / 1000)) : 0;
  const totalVotes = game?.votes.reduce((sum, vote) => sum + vote.count, 0) ?? 0;
  const highestCount = Math.max(0, ...(game?.votes.map((vote) => vote.count) ?? []));
  const recentVote = voteActivity && now - voteActivity.createdAt < 1_800 ? voteActivity : null;
  const recentResult = voteResult && now - voteResult.createdAt < 2_400 ? voteResult : null;
  const winnerCount = recentResult?.votes.find((vote) => vote.input === recentResult.winner)?.count ?? 0;

  return (
    <section className="game-area" aria-labelledby="game-heading">
      <div className="section-heading game-section-heading">
        <h2 id="game-heading">GAME</h2>
        <div className={`vote-activity${recentResult ? " is-result" : ""}`} role="status">
          {recentResult ? (
            recentResult.winner ? (
              <><strong>{recentResult.winner.toUpperCase()} WON</strong><span> · {winnerCount} VOTE{winnerCount === 1 ? "" : "S"}</span></>
            ) : (
              <span>NO INPUT WON</span>
            )
          ) : recentVote ? (
            <><AgentName agentId={recentVote.agentId} displayName={recentVote.displayName} onOpen={onAgentOpen} /><span> → {recentVote.input.toUpperCase()}</span></>
          ) : (
            <span aria-hidden="true">AWAITING VOTES</span>
          )}
        </div>
        {game ? <GameAudioControl roomId={game.roomId} available={game.mode === "rom"} /> : null}
        <div className="vote-clock" aria-live="polite">
          VOTE WINDOW <span>00:{String(endsIn).padStart(2, "0")}</span>
        </div>
      </div>
      <div className="game-grid">
        <div className="game-screen-shell">
          {game ? (
            <LiveGameScreen
              roomId={game.roomId}
              frameUrl={game.frameUrl}
              alt={`Current game frame. Last input: ${game.lastInput ?? "none"}.`}
              mode={game.mode}
              onPartyUpdate={onPartyUpdate}
            />
          ) : (
            <div className="game-screen game-screen-loading">STARTING ROOM…</div>
          )}
          <div className="screen-scanlines" aria-hidden="true" />
        </div>
        <div className="vote-panel" role="list" aria-label="Read-only controller vote totals">
          {GAME_INPUTS.map((input) => {
            const count = game?.votes.find((vote) => vote.input === input)?.count ?? 0;
            const percent = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
            const selected = game?.yourVote === input;
            const leading = count > 0 && count === highestCount;
            const updated = recentVote?.input === input && now - recentVote.createdAt < 750;
            const winner = recentResult?.winner === input;
            const label = INPUT_LABELS[input];
            return (
              <div
                className={`vote-row${selected ? " is-selected" : ""}${leading ? " is-leading" : ""}${updated ? " is-vote-updated" : ""}${winner ? " is-winner" : ""}`}
                key={input}
                role="listitem"
                aria-label={`${label.label}: ${count} vote${count === 1 ? "" : "s"}, ${percent} percent${leading ? ", current leader" : ""}${winner ? ", window winner" : ""}${selected ? ", this browser agent's current vote" : ""}`}
              >
                <span className="vote-label">
                  <span className="vote-glyph" aria-hidden="true">{label.glyph}</span>
                  {label.label}
                </span>
                <span className="vote-meter" aria-hidden="true">
                  <span style={{ width: `${percent === 0 ? 0 : Math.max(3, percent)}%` }} />
                </span>
                <span className="vote-percent">{percent}%</span>
              </div>
            );
          })}
          <div className="vote-rule">SPECTATOR VIEW · AGENTS VOTE WITH game.vote</div>
        </div>
      </div>
    </section>
  );
}
