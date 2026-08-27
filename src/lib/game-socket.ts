import {
  GAME_INPUTS,
  type ChatMessage,
  type GameInput,
  type SocketEnvelope,
  type VoteChangedEvent,
  type VoteOpenedEvent,
  type VoteResolvedEvent,
  type VoteTally,
  type VoteWindow
} from "../../shared/types";

export type GameSocketEvent =
  | { type: "vote.changed"; payload: VoteChangedEvent }
  | { type: "vote.resolved"; payload: VoteResolvedEvent }
  | { type: "vote.opened"; payload: VoteOpenedEvent }
  | { type: "chat.sent"; payload: ChatMessage }
  | { type: "game.resync" };

export function parseGameSocketEvent(envelope: SocketEnvelope): GameSocketEvent | null {
  if (envelope.source !== "game") return null;
  if (envelope.type === "vote.changed" && isVoteChanged(envelope.payload)) {
    return { type: "vote.changed", payload: envelope.payload };
  }
  if (envelope.type === "vote.resolved" && isVoteResolved(envelope.payload)) {
    return { type: "vote.resolved", payload: envelope.payload };
  }
  if (envelope.type === "vote.opened" && isVoteOpened(envelope.payload)) {
    return { type: "vote.opened", payload: envelope.payload };
  }
  if (envelope.type === "chat.sent" && isChatMessage(envelope.payload)) {
    return { type: "chat.sent", payload: envelope.payload };
  }
  if (envelope.type === "emulator.rom_loaded") return { type: "game.resync" };
  return null;
}

function isVoteChanged(value: unknown): value is VoteChangedEvent {
  return (
    isRecord(value) &&
    isPositiveInteger(value.sequence) &&
    isPositiveInteger(value.windowId) &&
    typeof value.agentId === "string" &&
    typeof value.displayName === "string" &&
    isGameInput(value.input) &&
    isVoteTallies(value.votes) &&
    isTimestamp(value.createdAt)
  );
}

function isVoteResolved(value: unknown): value is VoteResolvedEvent {
  return (
    isRecord(value) &&
    isPositiveInteger(value.sequence) &&
    isPositiveInteger(value.windowId) &&
    (value.winner === null || isGameInput(value.winner)) &&
    isVoteTallies(value.votes) &&
    isTimestamp(value.createdAt)
  );
}

function isVoteOpened(value: unknown): value is VoteOpenedEvent {
  return (
    isRecord(value) &&
    isPositiveInteger(value.sequence) &&
    isVoteWindow(value.voteWindow) &&
    isVoteTallies(value.votes) &&
    isTimestamp(value.createdAt)
  );
}

function isVoteWindow(value: unknown): value is VoteWindow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    isTimestamp(value.startsAt) &&
    isTimestamp(value.endsAt) &&
    value.endsAt > value.startsAt &&
    (value.status === "open" || value.status === "resolved") &&
    (value.winner === null || isGameInput(value.winner))
  );
}

function isVoteTallies(value: unknown): value is VoteTally[] {
  return (
    Array.isArray(value) &&
    value.length === GAME_INPUTS.length &&
    value.every(
      (item) =>
        isRecord(item) &&
        isGameInput(item.input) &&
        Number.isSafeInteger(item.count) &&
        Number(item.count) >= 0
    )
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    isPositiveInteger(value.sequence) &&
    typeof value.agentId === "string" &&
    typeof value.displayName === "string" &&
    typeof value.message === "string" &&
    isTimestamp(value.createdAt)
  );
}

function isGameInput(value: unknown): value is GameInput {
  return typeof value === "string" && GAME_INPUTS.includes(value as GameInput);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
