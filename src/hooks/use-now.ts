"use client";

import { useSyncExternalStore } from "react";

/**
 * One clock for the whole app.
 *
 * Relative timestamps ("updated 8s ago", "last tick 14s ago") are computed
 * during render, so without something to re-render them they freeze at
 * whatever the last data change happened to be. On a symbol that has not moved
 * for a minute -- or an admin overview between 15s polls -- that reads exactly
 * like a dead page, which on a trading floor is the one thing a status line
 * must never do.
 *
 * A single shared interval rather than one per component: the instruments
 * table prints a timestamp per row, and a hundred timers to produce a hundred
 * strings is a hundred times the wakeups for identical output.
 */
const TICK_MS = 1000;

let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish() {
  now = Date.now();
  for (const fn of listeners) fn();
}

// Background tabs have setInterval throttled to roughly once a minute, so the
// clock comes back stale from a tab the user left. Re-read it the moment they
// look at the page again, before the next scheduled tick.
function onVisibility() {
  if (document.visibilityState === "visible") publish();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    publish();
    timer = setInterval(publish, TICK_MS);
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

const getSnapshot = () => now;
// Zero until the first subscription lands, which keeps the snapshot stable
// across a render pass; the caller below substitutes a real reading so server
// render and hydration behave exactly as they did before this hook existed.
const getServerSnapshot = () => 0;

/** Milliseconds since the epoch, re-read once a second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) || Date.now();
}
