import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface ReverseInfiniteLogOptions {
  oldestSequence?: number;
  newestSequence?: number;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
}

const TOP_LOAD_DISTANCE = 32;
const BOTTOM_DISTANCE = 24;
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useReverseInfiniteLog({
  oldestSequence,
  newestSequence,
  hasMore,
  loadingOlder,
  onLoadOlder
}: ReverseInfiniteLogOptions) {
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const requestActive = useRef(false);
  const anchor = useRef<{
    scrollHeight: number;
    scrollTop: number;
    oldestSequence?: number;
  } | null>(null);
  const previous = useRef<{
    oldestSequence?: number;
    newestSequence?: number;
  }>({});
  const [newItemCount, setNewItemCount] = useState(0);

  const requestOlder = useCallback(async () => {
    const log = logRef.current;
    if (!log || !hasMore || loadingOlder || requestActive.current) return;
    requestActive.current = true;
    anchor.current = {
      scrollHeight: log.scrollHeight,
      scrollTop: log.scrollTop,
      oldestSequence
    };
    try {
      await onLoadOlder();
    } finally {
      requestActive.current = false;
    }
  }, [hasMore, loadingOlder, oldestSequence, onLoadOlder]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const handleScroll = () => {
      const isAtBottom = distanceFromBottom(log) <= BOTTOM_DISTANCE;
      atBottom.current = isAtBottom;
      if (isAtBottom) setNewItemCount(0);
      if (!isAtBottom && log.scrollTop <= TOP_LOAD_DISTANCE) void requestOlder();
    };
    log.addEventListener("scroll", handleScroll, { passive: true });
    return () => log.removeEventListener("scroll", handleScroll);
  }, [requestOlder]);

  useClientLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const prior = previous.current;
    const appended =
      prior.newestSequence !== undefined &&
      newestSequence !== undefined &&
      newestSequence > prior.newestSequence;

    if (anchor.current && !loadingOlder) {
      if (
        oldestSequence !== undefined &&
        (anchor.current.oldestSequence === undefined ||
          oldestSequence < anchor.current.oldestSequence)
      ) {
        log.scrollTop =
          anchor.current.scrollTop + log.scrollHeight - anchor.current.scrollHeight;
      }
      anchor.current = null;
    }

    if (prior.newestSequence === undefined && newestSequence !== undefined) {
      log.scrollTop = log.scrollHeight;
      atBottom.current = true;
      setNewItemCount(0);
    } else if (appended) {
      if (atBottom.current) {
        log.scrollTop = log.scrollHeight;
        setNewItemCount(0);
      } else {
        setNewItemCount(
          (count) => count + Math.max(1, newestSequence - prior.newestSequence!)
        );
      }
    }

    previous.current = { oldestSequence, newestSequence };
  }, [hasMore, loadingOlder, newestSequence, oldestSequence]);

  const scrollToLatest = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    atBottom.current = true;
    setNewItemCount(0);
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  }, []);

  return { logRef, newItemCount, scrollToLatest };
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}
