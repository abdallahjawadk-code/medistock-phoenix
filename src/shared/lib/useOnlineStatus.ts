/**
 * Live browser connectivity, as React state.
 *
 * Reading `navigator.onLine` during render is NOT enough: it is a one-shot
 * sample, so a component that reads it never re-renders when connectivity
 * actually changes. A surface that tells the operator "you are offline" has to
 * react while it is mounted, not only if it happened to mount after the drop.
 *
 * SSR-safe: `navigator`/`window` are absent on the server, where we assume
 * online (the pessimistic default would render an offline warning into every
 * server pass) and subscribe to nothing.
 *
 * The subscription lives in {@link subscribeOnlineStatus}, a plain function
 * taking its event target and connectivity reader as arguments. This repo's
 * test suite runs in the `node` environment and renders no React components, so
 * that seam is what makes the listen/emit/cleanup behaviour genuinely testable
 * rather than merely asserted against the source text.
 */
import { useEffect, useState } from 'react';

/** Minimal shape we need from `window` — keeps the unit under test DOM-free. */
export interface OnlineEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * The current value, safe to call in any environment.
 *
 * Guards the PROPERTY, not just the global: modern Node defines a global
 * `navigator` that has no `onLine`, so a `typeof navigator` check alone returns
 * `undefined` and every downstream boolean check silently reads as offline.
 * Anything that is not a real boolean is treated as online.
 */
export function readOnlineStatus(): boolean {
  if (typeof navigator === 'undefined') return true;
  return typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
}

/**
 * Subscribe to connectivity changes.
 *
 * Emits the CURRENT value immediately, closing the gap between the initial
 * render and the effect — connectivity can change in between, and without this
 * the caller would latch a stale value. Returns an unsubscribe that removes
 * both listeners.
 */
export function subscribeOnlineStatus(
  target: OnlineEventTarget | undefined,
  onChange: (online: boolean) => void,
  read: () => boolean = readOnlineStatus,
): () => void {
  if (!target) return () => { /* server: nothing to subscribe to */ };

  onChange(read());
  const goOnline = () => onChange(true);
  const goOffline = () => onChange(false);
  target.addEventListener('online', goOnline);
  target.addEventListener('offline', goOffline);

  return () => {
    target.removeEventListener('online', goOnline);
    target.removeEventListener('offline', goOffline);
  };
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(readOnlineStatus);

  useEffect(
    () => subscribeOnlineStatus(typeof window === 'undefined' ? undefined : window, setOnline),
    [],
  );

  return online;
}
