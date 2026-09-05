import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * INTERACTIVE-GUIDE-IG2 — what the operator is actually looking at, and what
 * they are actually allowed to do THERE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * IG-1 gated steps on `myPermissions` — the global effective set — which is the
 * right question for a screen-level decision like `dashboard.view`. It is the
 * WRONG question for IG-2. Quarantine disposal is decided per WAREHOUSE
 * (`warehouse_transfer.return_request` on the quarantine row's own warehouse,
 * migrations 099/105), and dispensing suspension is decided per ORGANIZATION or
 * per OUTLET across three independent keys (203). Both are answered
 * asynchronously by `supabaseRbacTransport.hasScopedPermission`, and neither
 * answer is derivable from a global key set.
 *
 * So the guide does not re-derive anything. The components that ALREADY
 * computed those answers publish them here, and the guide reads them. There is
 * no second RBAC path, no role-name test, and no permission key invented for
 * the guide's benefit.
 *
 * IMPORTANT: a candidate list is not an authorization. `manageableOutlets`
 * being non-empty does not prove a suspension may be created at any of them —
 * `SuspendForm` re-asks the scoped hook once a scope is chosen, and the RPC
 * re-checks server-side. Publishers here must publish the DECISION they
 * computed, never the candidate set that led to it.
 *
 * NOTHING HERE IS PERSISTED. This is in-memory view state describing the
 * current context; guide progress continues to hold only a schema version, a
 * tour id, a step id and completed ids (AD-06).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type GuideCapabilityState = 'loading' | 'ready' | 'error';

export interface GuideSurface {
  /** The screen currently rendered by the shell. */
  screen: number | null;
  /** The active tab within that screen, when the screen has tabs. */
  tab: string | null;
}

export interface GuideSurfaceContextValue {
  surface: GuideSurface;
  /**
   * The merged, already-decided capability answers, keyed by a guide-side name.
   * Absent means "not published", which is treated exactly like false.
   */
  capabilities: Readonly<Record<string, boolean>>;
  /**
   * Whether every publisher currently mounted has finished deciding.
   *
   * A tour must not be offered from a half-resolved answer: while this is
   * `loading` the guide shows nothing rather than a guess, and on `error` it
   * shows nothing rather than a stale grant.
   */
  capabilityState: GuideCapabilityState;
  /**
   * Changes whenever the surface or the publishers change identity — a
   * different organization, warehouse, outlet, tab or screen.
   *
   * Deliberately opaque and never persisted: the guide only needs to know THAT
   * the context changed so it can recompute, never what it changed to.
   */
  contextKey: string;
  publish: (source: string, entry: GuideCapabilityEntry | null) => void;
  setSurface: (surface: GuideSurface) => void;
}

export interface GuideCapabilityEntry {
  capabilities: Record<string, boolean>;
  state: GuideCapabilityState;
  /** Opaque identity of the scope these answers were computed for. */
  scopeKey: string;
}

const EMPTY: GuideSurfaceContextValue = {
  surface: { screen: null, tab: null },
  capabilities: {},
  capabilityState: 'ready',
  contextKey: 'none',
  publish: () => undefined,
  setSurface: () => undefined,
};

const GuideSurfaceContext = createContext<GuideSurfaceContextValue>(EMPTY);

/**
 * Mounted once, above both the screen and the guide host, so a screen can
 * describe itself and the guide can read that description.
 */
export function GuideSurfaceProvider({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<GuideSurface>({ screen: null, tab: null });
  const [entries, setEntries] = useState<Record<string, GuideCapabilityEntry>>({});

  const publish = useMemo(() => (source: string, entry: GuideCapabilityEntry | null) => {
    setEntries(previous => {
      if (entry === null) {
        if (!(source in previous)) return previous;
        const next = { ...previous };
        delete next[source];
        return next;
      }
      const existing = previous[source];
      if (existing
        && existing.state === entry.state
        && existing.scopeKey === entry.scopeKey
        && sameCapabilities(existing.capabilities, entry.capabilities)) {
        return previous;
      }
      return { ...previous, [source]: entry };
    });
  }, []);

  const value = useMemo<GuideSurfaceContextValue>(() => {
    const sources = Object.keys(entries).sort();
    const capabilities: Record<string, boolean> = {};
    let state: GuideCapabilityState = 'ready';

    for (const source of sources) {
      const entry = entries[source];
      // A publisher that is still deciding, or that failed, must not
      // contribute a value — an absent capability reads as false, which is the
      // safe direction.
      if (entry.state !== 'ready') {
        if (entry.state === 'error' || state !== 'error') state = entry.state;
        continue;
      }
      for (const [key, allowed] of Object.entries(entry.capabilities)) {
        capabilities[key] = (capabilities[key] ?? false) || allowed;
      }
    }

    const contextKey = [
      `s:${surface.screen ?? '-'}`,
      `t:${surface.tab ?? '-'}`,
      ...sources.map(source => `${source}@${entries[source].scopeKey}:${entries[source].state}`),
    ].join('|');

    return { surface, capabilities, capabilityState: state, contextKey, publish, setSurface };
  }, [surface, entries, publish]);

  return <GuideSurfaceContext.Provider value={value}>{children}</GuideSurfaceContext.Provider>;
}

function sameCapabilities(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export function useGuideSurfaceContext(): GuideSurfaceContextValue {
  return useContext(GuideSurfaceContext);
}

/**
 * A screen describes where the operator is. Cleared when the screen unmounts,
 * so a stale surface can never outlive the thing it described.
 */
export function useGuideSurface(screen: number, tab: string | null): void {
  const { setSurface } = useGuideSurfaceContext();
  useEffect(() => {
    setSurface({ screen, tab });
    return () => setSurface({ screen: null, tab: null });
  }, [screen, tab, setSurface]);
}

/**
 * A component publishes the scoped answers it ALREADY computed.
 *
 * `scopeKey` is what the answers were computed for — an organization, a
 * warehouse, an outlet. It is compared, never displayed and never stored, and
 * changing it forces the guide to recompute rather than reuse a stale grant.
 */
export function useGuideCapabilities(
  source: string,
  capabilities: Record<string, boolean>,
  state: GuideCapabilityState,
  scopeKey: string,
): void {
  const { publish } = useGuideSurfaceContext();
  const serialised = JSON.stringify(capabilities);

  useEffect(() => {
    publish(source, { capabilities: JSON.parse(serialised) as Record<string, boolean>, state, scopeKey });
    return () => publish(source, null);
  }, [publish, source, serialised, state, scopeKey]);
}
