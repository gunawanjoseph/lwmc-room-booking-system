// Shared exit motion for overlays. React unmounts an overlay the moment its
// state flips, so exits run first via WAAPI (compositor-driven, no library)
// and hand control back to the caller's close() when they finish.

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
// Exits are faster than entrances (~420ms): the system is responding, the
// user is no longer deciding.
const EXIT_MS = 200;

type ExitKind = "modal" | "drawer";

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isPhoneSheet() {
  return window.matchMedia("(max-width: 640px)").matches;
}

/**
 * Animate an overlay out along the path it came in on, then call `done`.
 * - Phones: every overlay is a bottom sheet, so it drops back down.
 * - Desktop modals: scale to 0.96 and fade (never to 0).
 * - Desktop drawers: slide back out to the right edge.
 * - Reduced motion: a short cross-fade in place, no travel.
 * Safe to call twice; the second call is ignored while the first runs.
 */
export function exitOverlay(
  panel: HTMLElement | null,
  done: () => void,
  kind: ExitKind = "modal",
) {
  if (!panel || typeof panel.animate !== "function") {
    done();
    return;
  }
  if (panel.dataset.leaving === "true") return;
  panel.dataset.leaving = "true";
  panel.style.pointerEvents = "none";

  const reduce = prefersReducedMotion();
  const to = reduce
    ? "none"
    : isPhoneSheet()
      ? "translateY(100%)"
      : kind === "drawer"
        ? "translateX(100%)"
        : "scale(0.96)";
  const fade = reduce || (!isPhoneSheet() && kind === "modal");
  const timing = { duration: reduce ? 150 : EXIT_MS, easing: EASE_OUT, fill: "forwards" as const };

  const animations: Animation[] = [
    panel.animate(
      [
        { transform: getComputedStyle(panel).transform === "none" ? "none" : getComputedStyle(panel).transform, opacity: 1 },
        { transform: to, opacity: fade ? 0 : 1 },
      ],
      timing,
    ),
  ];

  const backdrop = panel.closest<HTMLElement>(".modal-backdrop, .drawer-backdrop");
  if (backdrop && backdrop !== panel) {
    animations.push(backdrop.animate([{ opacity: 1 }, { opacity: 0 }], timing));
  } else if (panel instanceof HTMLDialogElement) {
    try {
      animations.push(
        panel.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, pseudoElement: "::backdrop" }),
      );
    } catch {
      // ::backdrop animation unsupported; the dialog itself still animates.
    }
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
  // Never strand the UI if a finish event is swallowed (hidden tab, etc.).
  window.setTimeout(finish, EXIT_MS + 150);
}

/** True when the activating event came from the keyboard (Enter/Space/Escape). */
export function fromKeyboard(event: { detail?: number } | undefined) {
  return !!event && event.detail === 0;
}
