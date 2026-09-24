"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** True while the viewport matches `query`; false during SSR. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// Apple's scroll-deceleration projection: where a flick would come to rest.
function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// Progressive resistance past a boundary instead of a hard stop.
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

/**
 * Swipe-to-close for a left-edge drawer. The drawer tracks the finger 1:1
 * from where it was grabbed, rubber-bands if pulled open further, and on
 * release projects the flick's momentum to decide close vs. settle back.
 * CSS transitions pick up from the live transform, so the release never jumps.
 */
export function useDrawerGesture({
  drawer,
  scrim,
  enabled,
  onClose,
}: {
  drawer: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
  enabled: boolean;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const element = drawer.current;
    if (!element || !enabled) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let suppressClick = false;
    let samples: Array<{ x: number; t: number }> = [];

    const width = () => element.getBoundingClientRect().width || 280;

    const reset = () => {
      element.style.transition = "";
      element.style.transform = "";
      if (scrim.current) {
        scrim.current.style.transition = "";
        scrim.current.style.opacity = "";
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || pointerId !== null) return;
      suppressClick = false;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      samples = [{ x: event.clientX, t: event.timeStamp }];
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging) {
        // ~10px of hysteresis, and only claim clearly horizontal drags so
        // vertical scrolling of the nav list stays with the browser.
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) {
          if (Math.abs(dy) > 10) pointerId = null;
          return;
        }
        dragging = true;
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // The pointer already ended; tracking still works without capture.
        }
        element.style.transition = "none";
        if (scrim.current) scrim.current.style.transition = "none";
      }
      samples.push({ x: event.clientX, t: event.timeStamp });
      if (samples.length > 5) samples.shift();
      const offset = dx > 0 ? rubberband(dx, width()) : dx;
      element.style.transform = `translate3d(${offset}px,0,0)`;
      if (scrim.current) {
        const progress = Math.max(0, Math.min(1, 1 + Math.min(0, dx) / width()));
        scrim.current.style.opacity = String(progress);
      }
    };

    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging) return;
      dragging = false;
      suppressClick = true;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const elapsed = Math.max(1, last.t - first.t);
      const velocity = ((last.x - first.x) / elapsed) * 1000; // px/s
      const dx = event.clientX - startX;
      // 0.99 (not scroll's 0.998): a slow drag settles back, a flick closes.
      const projected = Math.min(0, dx) + project(velocity, 0.99);
      const close = projected < -width() / 2;

      element.style.transition = "";
      if (scrim.current) scrim.current.style.transition = "";
      if (close) {
        // Hold the closed position inline so nothing flickers toward open
        // before React swaps the class; the effect cleanup clears it.
        element.style.transform = "translate3d(-100%,0,0)";
        if (scrim.current) scrim.current.style.opacity = "0";
        onCloseRef.current();
      } else {
        // Clearing the inline transform lets the stylesheet's open state
        // animate back in from wherever the finger let go.
        element.style.transform = "";
        if (scrim.current) scrim.current.style.opacity = "";
      }
    };

    const onClickCapture = (event: MouseEvent) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
      }
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("click", onClickCapture, true);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      element.removeEventListener("click", onClickCapture, true);
      reset();
    };
  }, [drawer, scrim, enabled]);
}
