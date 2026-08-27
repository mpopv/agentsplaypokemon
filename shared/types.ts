export const GAME_INPUTS = [
  "up",
  "down",
  "left",
  "right",
  "a",
  "b",
  "start",
  "select"
] as const;

export type GameInput = (typeof GAME_INPUTS)[number];

export const AGENT_SESSION_PROTOCOL_PREFIX = "agents-play-session.";

export interface AgentIdentity {
  agentId: string;
  displayName: string;
}

export interface SessionInfo extends AgentIdentity {
  roomId: string;
}

export interface SessionBootstrap extends SessionInfo {
  token: string;
}

export interface VoteTally {
  input: GameInput;
  count: number;
}

export interface VoteWindow {
  id: number;
  startsAt: number;
  endsAt: number;
  status: "open" | "resolved";
  winner: GameInput | null;
}

export interface VoteChangedEvent {
  sequence: number;
  windowId: number;
  agentId: string;
  displayName: string;
  input: GameInput;
  votes: VoteTally[];
  createdAt: number;
}

export interface VoteResolvedEvent {
  sequence: number;
  windowId: number;
  winner: GameInput | null;
  votes: VoteTally[];
  createdAt: number;
}

export interface VoteOpenedEvent {
  sequence: number;
  voteWindow: VoteWindow;
  votes: VoteTally[];
  createdAt: number;
}

export interface GameEvent {
  sequence: number;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ChatMessage {
  sequence: number;
  agentId: string;
  displayName: string;
  message: string;
  createdAt: number;
}

export interface ChatHistoryPage {
  messages: ChatMessage[];
  nextBefore: number | null;
  hasMore: boolean;
}

export interface AgentLastVote {
  windowId: number;
  input: GameInput;
  createdAt: number;
}

export interface AgentLastChat {
  message: string;
  createdAt: number;
}

export interface AgentLastCommand {
  command: string;
  eventType: string;
  exitCode: number | null;
  filesystemRevision: number;
  createdAt: number;
}

export interface GameAgentActivity {
  displayName: string | null;
  firstRecordedAt: number | null;
  lastRecordedAt: number | null;
  lastSeenAt: number | null;
  online: boolean;
  voteWindowCount: number;
  chatMessageCount: number;
  lastVote: AgentLastVote | null;
  lastChat: AgentLastChat | null;
}

export interface ComputerAgentActivity {
  displayName: string | null;
  firstRecordedAt: number | null;
  lastRecordedAt: number | null;
  commandCount: number;
  lastCommand: AgentLastCommand | null;
}

export interface AgentProfile extends AgentIdentity {
  firstRecordedAt: number;
  lastActiveAt: number;
  online: boolean;
  voteWindowCount: number;
  chatMessageCount: number;
  commandCount: number;
  lastVote: AgentLastVote | null;
  lastChat: AgentLastChat | null;
  lastCommand: AgentLastCommand | null;
}

export interface GameObservation {
  roomId: string;
  mode: "demo" | "rom";
  frameRevision: number;
  frameUrl: string;
  activeAgents: number;
  voteWindow: VoteWindow;
  votes: VoteTally[];
  yourVote: GameInput | null;
  lastInput: GameInput | null;
  events: GameEvent[];
}

export type PokemonStatus = "OK" | "SLP" | "PSN" | "BRN" | "FRZ" | "PAR" | "FNT";

export interface PokemonPartyMember {
  slot: number;
  nickname: string;
  species: string;
  pokedexNumber: number;
  level: number;
  hp: number;
  maxHp: number;
  status: PokemonStatus;
  active: boolean;
  fainted: boolean;
}

export interface PokemonPartySnapshot {
  available: boolean;
  party: PokemonPartyMember[];
}

export interface ComputerExecRequest {
  command: string;
  cwd?: string;
}

export interface ComputerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  filesystemRevision: number;
}

export interface ComputerEvent {
  sequence: number;
  agentId: string;
  displayName: string;
  eventType: string;
  command: string | null;
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  filesystemRevision: number;
  createdAt: number;
}

export interface ComputerTreeEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  type: "file" | "directory" | "symlink";
}

export interface ComputerFileView {
  path: string;
  size: number;
  mtime: number;
  mode: number;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
}

export interface ComputerFileHistoryEntry {
  sequence: number;
  path: string;
  operation: "created" | "updated" | "deleted";
  size: number;
  mtime: number;
  filesystemRevision: number;
  preview: string | null;
  createdAt: number;
}

export interface ComputerOverview {
  roomId: string;
  filesystemRevision: number;
  events: ComputerEvent[];
}

export interface ComputerEventHistoryPage {
  roomId: string;
  filesystemRevision: number;
  events: ComputerEvent[];
  nextBefore: number | null;
  hasMore: boolean;
}

export interface ComputerSnapshot {
  snapshotId: string;
  filesystemRevision: number;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
}

export interface SocketEnvelope<T = unknown> {
  source: "game" | "computer";
  type: string;
  payload: T;
  createdAt: number;
}
