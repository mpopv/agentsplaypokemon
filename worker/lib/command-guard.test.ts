import { describe, expect, it } from "vitest";

import {
  BackendCircuitBreaker,
  CommandAdmission,
  extractProcessMetrics,
  isBackendFailure
} from "./command-guard";

describe("shared computer admission", () => {
  it("allows four total commands and rejects more work immediately", () => {
    const admission = new CommandAdmission(4);
    const accepted = ["a", "b", "c", "d"].map((agent) => admission.admit(agent));

    expect(admission.queueDepth).toBe(4);
    expect(() => admission.admit("e")).toThrow("shared computer is busy");
    accepted[0]?.release();
    expect(admission.admit("e").depthAtArrival).toBe(4);
  });

  it("allows only one outstanding command for each agent", () => {
    const admission = new CommandAdmission();
    const accepted = admission.admit("agent-a");
    expect(() => admission.admit("agent-a")).toThrow("already have a queued");
    accepted.release();
    expect(admission.admit("agent-a").depthAtArrival).toBe(1);
  });
});

describe("computer backend circuit breaker", () => {
  it("opens after two failures and closes after the cooldown", () => {
    let now = 1_000;
    const circuit = new BackendCircuitBreaker(2, 30_000, () => now);
    circuit.recordFailure();
    expect(() => circuit.assertAvailable()).not.toThrow();
    circuit.recordFailure();
    expect(() => circuit.assertAvailable()).toThrow("runtime is recovering");
    now += 30_000;
    expect(() => circuit.assertAvailable()).not.toThrow();
  });

  it("recognizes workspace transport failures", () => {
    expect(isBackendFailure(new Error("[stage=ws]: /ws upgrade did not arrive"))).toBe(true);
    expect(isBackendFailure(new Error("command exited with 2"))).toBe(false);
  });
});

describe("process metrics", () => {
  it("removes the supervisor marker from stderr", () => {
    const value = {
      stdoutProducedBytes: 12,
      stderrProducedBytes: 4,
      stdoutReturnedBytes: 12,
      stderrReturnedBytes: 4,
      filesystemEntries: 2,
      filesystemBytes: 30,
      timedOut: false,
      outputLimitExceeded: false,
      workspaceLimitExceeded: false
    };
    const result = extractProcessMetrics(`warning\n__AGENTS_PLAY_EXEC_METRICS__=${JSON.stringify(value)}\n`);
    expect(result).toEqual({ stderr: "warning", metrics: value });
  });
});
