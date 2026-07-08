// Coalesces bursty callbacks (scroll, resize, ResizeObserver, pointer moves)
// into at most one invocation per animation frame. This keeps repositioning and
// hit-testing from thrashing layout more than the display can actually show,
// which is the single biggest lever for staying smooth on busy pages.

export interface RafThrottle {
  /** Requests a run on the next frame (no-op if one is already pending). */
  schedule(): void;
  /** Cancels any pending run. */
  cancel(): void;
}

export function rafThrottle(callback: () => void): RafThrottle {
  let handle = 0;
  return {
    schedule(): void {
      if (handle !== 0) return;
      handle = requestAnimationFrame(() => {
        handle = 0;
        callback();
      });
    },
    cancel(): void {
      if (handle !== 0) {
        cancelAnimationFrame(handle);
        handle = 0;
      }
    },
  };
}
