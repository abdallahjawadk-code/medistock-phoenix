/**
 * OUTLET-CORRIDOR — live connectivity contract.
 *
 * CurrentMovementStatus used to READ navigator.onLine during render without
 * subscribing, so its "you are offline" banner was latched at whatever
 * connectivity happened to be true when the tab mounted: an operator who lost
 * the network while looking at the screen was told nothing, and one who
 * regained it kept staring at a stale warning.
 *
 * These are behavioural tests, not source-text assertions: the subscription is
 * exercised against a fake event target, which is what lets it run in this
 * repo's `node` test environment with no DOM and no React renderer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  subscribeOnlineStatus,
  readOnlineStatus,
  type OnlineEventTarget,
} from '../useOnlineStatus';

/** A minimal event target that records its listeners, like `window` would. */
function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const target: OnlineEventTarget = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    emit: (type: string) => { for (const l of listeners.get(type) ?? []) l(); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
    total: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe('subscribeOnlineStatus', () => {
  it('emits the current value immediately, so a mount after the drop is correct', () => {
    const seen: boolean[] = [];
    const t = fakeTarget();
    subscribeOnlineStatus(t.target, v => seen.push(v), () => false);
    expect(seen).toEqual([false]);
  });

  it('updates live when connectivity drops while mounted', () => {
    const seen: boolean[] = [];
    const t = fakeTarget();
    subscribeOnlineStatus(t.target, v => seen.push(v), () => true);
    expect(seen).toEqual([true]);

    t.emit('offline');
    expect(seen).toEqual([true, false]);
  });

  it('updates live when connectivity is regained, clearing a stale warning', () => {
    const seen: boolean[] = [];
    const t = fakeTarget();
    subscribeOnlineStatus(t.target, v => seen.push(v), () => false);

    t.emit('online');
    expect(seen).toEqual([false, true]);
  });

  it('tracks a full offline → online → offline transition in order', () => {
    const seen: boolean[] = [];
    const t = fakeTarget();
    subscribeOnlineStatus(t.target, v => seen.push(v), () => true);

    t.emit('offline');
    t.emit('online');
    t.emit('offline');
    expect(seen).toEqual([true, false, true, false]);
  });

  it('registers exactly one listener per event', () => {
    const t = fakeTarget();
    subscribeOnlineStatus(t.target, () => {}, () => true);
    expect(t.count('online')).toBe(1);
    expect(t.count('offline')).toBe(1);
  });

  it('removes BOTH listeners on unsubscribe — no leak across remounts', () => {
    const t = fakeTarget();
    const stop = subscribeOnlineStatus(t.target, () => {}, () => true);
    expect(t.total()).toBe(2);

    stop();
    expect(t.total()).toBe(0);
  });

  it('stops emitting after unsubscribe', () => {
    const onChange = vi.fn();
    const t = fakeTarget();
    const stop = subscribeOnlineStatus(t.target, onChange, () => true);
    onChange.mockClear();

    stop();
    t.emit('offline');
    t.emit('online');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is SSR-safe: no target means no subscription and no throw', () => {
    const onChange = vi.fn();
    const stop = subscribeOnlineStatus(undefined, onChange, () => false);
    expect(onChange).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe('readOnlineStatus', () => {
  it('always returns a real boolean, never undefined', () => {
    expect(typeof readOnlineStatus()).toBe('boolean');
  });

  it('assumes online outside a browser, where navigator.onLine does not exist', () => {
    // Modern Node defines a global `navigator` WITHOUT `onLine`. Guarding only
    // `typeof navigator` therefore yields undefined, which every downstream
    // boolean check reads as offline — this asserts the property guard.
    const noOnLine = typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean';
    if (noOnLine) expect(readOnlineStatus()).toBe(true);
    else expect(readOnlineStatus()).toBe(navigator.onLine);
  });
});

describe('CurrentMovementStatus wiring', () => {
  it('subscribes through the hook instead of sampling navigator.onLine in render', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'features', 'outlet', 'CurrentMovementStatus.tsx'),
      'utf8',
    );
    expect(src).toContain('useOnlineStatus');
    // The old one-shot render-time sample must be gone: it IS the defect.
    // Matched as code rather than as the bare identifier, which still appears
    // in the comment explaining why sampling was wrong.
    expect(src).not.toContain("typeof navigator === 'undefined' ? true : navigator.onLine");
    expect(src.replace(/\/\/.*$/gm, '')).not.toContain('navigator.onLine');
  });
});
