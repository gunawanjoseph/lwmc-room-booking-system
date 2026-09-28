"use client";
import { useEffect, useRef } from "react";

// Runs `callback` now and every `intervalMs` while the page is visible, and
// again as soon as a hidden tab comes back. Background tabs do nothing, so
// work that costs database reads scales with people looking at the page.
export function useVisibleInterval(callback: () => void, intervalMs: number) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function sync() {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      latest.current();
      timer = setInterval(() => latest.current(), intervalMs);
    }
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [intervalMs]);
}
