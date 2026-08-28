import { useEffect, useState } from "react";

import type { SessionInfo } from "../../shared/types";
import { getSession } from "../api";

export function useSession(): {
  session: SessionInfo | null;
  sessionError: string | null;
  sessionLoading: boolean;
  dismissSessionError(): void;
} {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    const connect = async () => {
      try {
        const value = await getSession();
        if (stopped) return;
        setSession(value);
        setSessionError(null);
      } catch (cause) {
        if (stopped) return;
        setSessionError(messageOf(cause));
        const delay = Math.min(5_000, 500 * 2 ** attempt);
        attempt += 1;
        retryTimer = window.setTimeout(() => void connect(), delay);
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);

  return {
    session,
    sessionError,
    sessionLoading: session === null,
    dismissSessionError: () => setSessionError(null)
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
