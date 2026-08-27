import { useGameAudio } from "../audio/useGameAudio";

interface GameAudioControlProps {
  roomId: string;
  available: boolean;
}

const LABELS = {
  off: "SOUND OFF",
  starting: "SOUND STARTING",
  buffering: "SOUND BUFFERING",
  live: "SOUND LIVE",
  retrying: "SOUND RETRYING",
  error: "SOUND ERROR"
} as const;

export function GameAudioControl({ roomId, available }: GameAudioControlProps) {
  const audio = useGameAudio(roomId, available);
  const enabled = audio.state !== "off" && audio.state !== "error";
  const label = LABELS[audio.state];

  return (
    <button
      type="button"
      className={`audio-toggle is-${audio.state}`}
      aria-label={enabled ? "Turn game sound off" : "Turn game sound on"}
      aria-pressed={enabled}
      disabled={!available}
      onClick={enabled ? audio.stop : () => void audio.start()}
    >
      <span aria-hidden="true">{enabled ? "◼" : "▷"}</span>
      {label}
    </button>
  );
}
