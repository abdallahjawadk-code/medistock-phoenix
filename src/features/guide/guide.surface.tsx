import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
   * DIAGNOSTIC AND INVALIDATION ONLY — it gates no grant. Grants are decided
   * per source: `capabilities` is built from SETTLED publishers alone, so a
   * check in flight or one that failed already contributes nothing. Letting
   * this aggregate veto as well would make one publisher's failure cancel
   * another publisher's independently established answer, which is how a
   * failed quarantine ACTION check ended up hiding the reading steps an
   * operator was plainly entitled to.
   */
  capabilityState: GuideCapabilityState;
  /**
   * WHAT IS ACTUALLY ON SCREEN — deliberately a SEPARATE map from
   * `capabilities`, and never merged with it.
   *
   * Three different questions decide whether a step may run, and conflating any
   * two of them produces a wrong answer:
   *
   *   1. PERMISSION — may this operator be told about this action at all?
   *      Answered by `capabilities`, and by nothing else.
   *   2. DATA STATE — has the panel finished loading, or did it fail?
   *      Answered by `capabilityState` for the permission read, and by a
   *      publisher declining to declare presence while it has no data.
   *   3. ELEMENT PRESENCE — is the thing the step points at rendered now?
   *      Answered HERE.
   *
   * A quarantine tab with an empty list is not a permission refusal, and an
   * authorized operator looking at an empty list must not be walked through a
   * step about "this row" that has no row. Presence is what lets the tour drop
   * exactly those steps instead of letting them fall back to a centred card and
   * calling that success.
   */
  presence: Readonly<Record<string, boolean>>;
  /**
   * Whether a tour is being walked RIGHT NOW.
   *
   * The one thing a panel legitimately needs to know about the guide, and it
   * is used for exactly one thing: {@link useGuideExampleRow} must not swap the
   * record it is pointing at while a step is describing it. Outside a tour
   * there is no explanation in progress, so the example is free to follow the
   * list again.
   *
   * It grants nothing, hides nothing and changes no data.
   */
  tourActive: boolean;
  publish: (source: string, entry: GuideCapabilityEntry | null) => void;
  publishPresence: (source: string, presence: Record<string, boolean> | null) => void;
  setSurface: (surface: GuideSurface) => void;
  setTourActive: (active: boolean) => void;
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
  presence: {},
  tourActive: false,
  publish: () => undefined,
  publishPresence: () => undefined,
  setSurface: () => undefined,
  setTourActive: () => undefined,
};

const GuideSurfaceContext = createContext<GuideSurfaceContextValue>(EMPTY);

/**
 * Mounted once, above both the screen and the guide host, so a screen can
 * describe itself and the guide can read that description.
 */
export function GuideSurfaceProvider({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<GuideSurface>({ screen: null, tab: null });
  const [entries, setEntries] = useState<Record<string, GuideCapabilityEntry>>({});
  const [presenceEntries, setPresenceEntries] = useState<Record<string, Record<string, boolean>>>({});
  const [tourActive, setTourActive] = useState(false);

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

  const publishPresence = useMemo(() => (source: string, presence: Record<string, boolean> | null) => {
    setPresenceEntries(previous => {
      if (presence === null) {
        if (!(source in previous)) return previous;
        const next = { ...previous };
        delete next[source];
        return next;
      }
      if (previous[source] && sameCapabilities(previous[source], presence)) return previous;
      return { ...previous, [source]: presence };
    });
  }, []);

  const value = useMemo<GuideSurfaceContextValue>(() => {
    const sources = Object.keys(entries).sort();
    const capabilities: Record<string, boolean> = {};
    let state: GuideCapabilityState = 'ready';

    for (const source of sources) {
      const entry = entries[source];
      // A publisher that is still deciding, or that failed, contributes
      // NOTHING — not a false, not a stale true. An absent capability reads as
      // false at the filter, which is the safe direction, and it leaves every
      // OTHER publisher's settled answer untouched.
      if (entry.state !== 'ready') {
        if (entry.state === 'error' || state !== 'error') state = entry.state;
        continue;
      }
      for (const [key, allowed] of Object.entries(entry.capabilities)) {
        capabilities[key] = (capabilities[key] ?? false) || allowed;
      }
    }

    const presence: Record<string, boolean> = {};
    for (const source of Object.keys(presenceEntries).sort()) {
      for (const [key, present] of Object.entries(presenceEntries[source])) {
        presence[key] = (presence[key] ?? false) || present;
      }
    }

    return {
      surface, capabilities, capabilityState: state, presence, tourActive,
      publish, publishPresence, setSurface, setTourActive,
    };
  }, [surface, entries, presenceEntries, tourActive, publish, publishPresence]);

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

/**
 * The same, for an answer produced ASYNCHRONOUSLY for one scope.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLAIN HOOK IS NOT ENOUGH, AND WHAT THIS ADDS
 *
 * `useAsync` — the loader behind every scoped permission hook in this codebase
 * — deliberately keeps the PREVIOUS result while the next one loads, and it
 * flips `loading` back to true from an EFFECT. So on the render that first
 * carries a new warehouse there is a window in which:
 *
 *     scopeKey  = the NEW warehouse       (a prop, already updated)
 *     loading   = false                   (the effect has not run yet)
 *     data      = the PREVIOUS warehouse's answer
 *
 * Published as-is, that is warehouse A's "yes" filed under warehouse B — the
 * guide would offer management steps for a warehouse whose check has not even
 * started.
 *
 * WHAT THIS DOES NOT DO: infer the answer's subject from timing. An earlier
 * version of this hook waited to observe a render reporting `loading` before
 * trusting the next answer, and that is not sound — when the loader resolves in
 * a microtask (a `super_admin` short-circuit, a cached transport), React
 * batches the effect's `loading = true` together with the resolution and NO
 * render ever reports it. The publisher then never becomes attributable and the
 * guide silently offers nothing at all.
 *
 * So attribution is a COMPARISON, not an observation: the caller passes the
 * scope its answer was computed for, and this publishes `ready` only when that
 * equals the scope being asked about. `useInventoryScopes` has always worked
 * this way — it rejects a catalog whose `organizationId` is not the one asked
 * for. An `error` is passed through unchanged, because an error is never a
 * grant in either direction.
 * ---------------------------------------------------------------------------
 */
export function useScopedGuideCapabilities(
  source: string,
  capabilities: Record<string, boolean>,
  state: GuideCapabilityState,
  scopeKey: string,
  /** The scope the published answers were actually computed for. */
  answerScopeKey: string | null,
): void {
  const effective: GuideCapabilityState =
    state === 'error' ? 'error'
      : answerScopeKey === scopeKey ? state
        : 'loading';
  useGuideCapabilities(source, capabilities, effective, scopeKey);
}

/**
 * A component declares which of its guide-anchored ELEMENTS are on screen.
 *
 * Presence is not authorization and is never treated as such — see the
 * `presence` field's own note. Cleared when the publisher unmounts.
 */
export function useGuidePresence(source: string, presence: Record<string, boolean>): void {
  const { publishPresence } = useGuideSurfaceContext();
  const serialised = JSON.stringify(presence);

  useEffect(() => {
    publishPresence(source, JSON.parse(serialised) as Record<string, boolean>);
    return () => publishPresence(source, null);
  }, [publishPresence, source, serialised]);
}

/**
 * Freeze ONE declared example out of a repeated list, by identity.
 *
 * Row-level anchors have to sit on exactly one card — several equal candidates
 * would let the guide highlight an arbitrary record. Choosing "whichever is
 * first right now" is not enough: the quarantine list is ordered by expiry and
 * reloads after every disposition, so "first" can become a DIFFERENT record
 * while a step is explaining it, and the operator would be told they are
 * looking at one lot while the ring had moved to another.
 *
 * This picks the first id it ever sees and keeps it for as long as that record
 * is still in the list. When the record leaves, the example is released and the
 * row anchors simply stop being placed — the affected steps fall back to their
 * declared region anchor, which is a true statement about the list, rather than
 * silently substituting a different record.
 */
export function useGuideExampleRow(ids: readonly string[]): string | null {
  const { tourActive } = useGuideSurfaceContext();
  const chosen = useRef<string | null>(null);
  const releasedMidTour = useRef(false);

  if (chosen.current !== null && !ids.includes(chosen.current)) {
    chosen.current = null;
    // Disposed of, lifted, or simply gone from a refreshed list. If a step is
    // describing it at this moment, the honest outcome is that the row anchors
    // stop being placed and the row steps disappear — NOT that the same
    // anchors reappear on a different record while the card still says "this
    // lot". Once the explanation is over the list is free to be re-exemplified.
    if (tourActive) releasedMidTour.current = true;
  }
  if (!tourActive) releasedMidTour.current = false;
  if (chosen.current === null && !releasedMidTour.current && ids.length > 0) {
    chosen.current = ids[0];
  }
  return chosen.current;
}
