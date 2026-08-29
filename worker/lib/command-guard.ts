import { InputError } from "./validation";

const DEFAULT_MAX_COMMANDS = 4;
const DEFAULT_CIRCUIT_FAILURES = 2;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

export class CommandAdmission {
  private readonly pendingAgents = new Set<string>();
  private depth = 0;

  constructor(private readonly maximum = DEFAULT_MAX_COMMANDS) {}

  get queueDepth(): number {
    return this.depth;
  }

  admit(agentId: string): { depthAtArrival: number; release(): void } {
    if (this.pendingAgents.has(agentId)) {
      throw new InputError("you already have a queued or running command", 429, 1);
    }
    if (this.depth >= this.maximum) {
      throw new InputError("the shared computer is busy; retry shortly", 503, 2);
    }

    this.pendingAgents.add(agentId);
    this.depth += 1;
    let released = false;
    return {
      depthAtArrival: this.depth,
      release: () => {
        if (released) return;
        released = true;
        this.pendingAgents.delete(agentId);
        this.depth -= 1;
      }
    };
  }
}

export class BackendCircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly failureThreshold = DEFAULT_CIRCUIT_FAILURES,
    private readonly cooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
    private readonly now: () => number = Date.now
  ) {}

  get circuitOpenUntil(): number | null {
    return this.openUntil > this.now() ? this.openUntil : null;
  }

  assertAvailable(): void {
    if (this.openUntil <= this.now()) return;
    const retrySeconds = Math.max(1, Math.ceil((this.openUntil - this.now()) / 1_000));
    throw new InputError("the shared computer runtime is recovering; retry shortly", 503, retrySeconds);
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
    }
  }
}

export function isBackendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /WorkspaceTransportError|\[stage=(?:ws|health|connect)\]|upgrade did not arrive|container.*(?:connect|start|unavailable)|backend.*(?:connect|unavailable)/i.test(
    message
  );
}

export interface ProcessMetrics {
  stdoutProducedBytes: number;
  stderrProducedBytes: number;
  stdoutReturnedBytes: number;
  stderrReturnedBytes: number;
  filesystemEntries: number;
  filesystemBytes: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  workspaceLimitExceeded: boolean;
}

const METRICS_PREFIX = "__AGENTS_PLAY_EXEC_METRICS__=";

export function extractProcessMetrics(stderr: string): {
  stderr: string;
  metrics: ProcessMetrics | null;
} {
  const lines = stderr.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.startsWith(METRICS_PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(METRICS_PREFIX.length)) as ProcessMetrics;
      lines.splice(index, 1);
      return { stderr: lines.join("\n").replace(/\n+$/, ""), metrics: value };
    } catch {
      return { stderr, metrics: null };
    }
  }
  return { stderr, metrics: null };
}
