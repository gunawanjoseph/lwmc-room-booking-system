"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Horizontal swipe paging for touch. The surface leans toward the finger
 * (damped, with a fade that hints at what's coming), then either commits
 * to the previous/next page on a long or fast enough swipe, or springs
 * back. Vertical scrolling is left to the browser via `touch-action: pan-y`.
 */
export function useSwipePaging(
  surface: RefObject<HTMLElement | null>,
  onPage: (offset: -1 | 1) => void,
) {
  const onPageRef = useRef(onPage);
  useEffect(() => {
    onPageRef.current = onPage;
  }, [onPage]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let suppressClick = false;
    let samples: Array<{ x: number; t: number }> = [];

    const settle = () => {
      element.style.transition = "";
      element.style.transform = "";
      element.style.opacity = "";
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
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) {
          if (Math.abs(dy) > 10) pointerId = null;
          return;
        }
        dragging = true;
        element.setPointerCapture(event.pointerId);
        element.style.transition = "none";
      }
      samples.push({ x: event.clientX, t: event.timeStamp });
      if (samples.length > 5) samples.shift();
      const width = element.clientWidth || 360;
      element.style.transform = `translate3d(${dx * 0.4}px,0,0)`;
      element.style.opacity = String(1 - Math.min(0.45, Math.abs(dx) / width));
    };

    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging) return;
      dragging = false;
      suppressClick = true;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const velocity = ((last.x - first.x) / Math.max(1, last.t - first.t)) * 1000;
      const dx = event.clientX - startX;
      const commit =
        event.type === "pointerup" &&
        (Math.abs(dx) > 64 || (Math.abs(velocity) > 450 && Math.abs(dx) > 24));
      settle();
      if (commit) onPageRef.current(dx < 0 ? 1 : -1);
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
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
      settle();
    };
  }, [surface]);
}
