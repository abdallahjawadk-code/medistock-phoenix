import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCommandCenterReadContract,
  type CommandCenterReadContract,
  type CommandCenterScopeRequest,
} from '@/shared/supabase/services/command-center.service';

/**
 * RAC-3 — the Command Center's single data hook.
 *
 * The shared `useAsync` helper collapses every failure into one string, which
 * is not enough here: a 42501 refusal and a dropped connection must not look
 * alike. "No data" is a THIRD, different answer, and presenting an
 * authorization refusal as an empty dashboard would quietly misreport the
 * actor's own authority back to them.
 *
 * Exactly one request is issued per scope change or explicit refresh. There is
 * no interval, no visibility listener and no per-card fetch.
 */
export type CommandCenterErrorKind =
  | 'unauthorized'
  | 'unauthenticated'
  | 'invalid_scope'
  | 'unavailable'
  | 'network';

export interface CommandCenterFailure {
  kind: CommandCenterErrorKind;
  /** Developer-facing detail. Never rendered raw to the operator. */
  detail: string;
}

export interface CommandCenterState {
  data: CommandCenterReadContract | null;
  loading: boolean;
  /** True only for a refresh over already-rendered data, never the first load. */
  refreshing: boolean;
  failure: CommandCenterFailure | null;
  /** When the currently displayed payload was received. */
  lastLoadedAt: Date | null;
  refresh: () => void;
}

/** Postgres/PostgREST error shape, narrowed without trusting its presence. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Unexpected error';
}

/**
 * Classify a failure by the contract Migration 199 documents.
 *
 * The SQLSTATE is authoritative when present; the raised message is the
 * fallback, because a PostgREST transport can surface the condition without
 * preserving the code. Anything unrecognised is treated as a transport
 * failure — the recoverable reading — rather than being reported to the
 * operator as a refusal we cannot actually prove.
 */
export function classifyCommandCenterError(error: unknown): CommandCenterFailure {
  const code = errorCode(error);
  const message = errorMessage(error);
  const text = message.toLowerCase();

  if (code === '42501' || text.includes('command_center_forbidden')) {
    return { kind: 'unauthorized', detail: message };
  }
  if (code === '28000' || text.includes('command_center_unauthenticated')) {
    return { kind: 'unauthenticated', detail: message };
  }
  if (code === '22023' || text.includes('command_center_invalid_scope')) {
    return { kind: 'invalid_scope', detail: message };
  }
  // 42883 = the routine is absent, i.e. this deployment predates M199.
  if (code === '42883' || text.includes('could not find the function')) {
    return { kind: 'unavailable', detail: message };
  }
  return { kind: 'network', detail: message };
}

export function useCommandCenter(scope: CommandCenterScopeRequest): CommandCenterState {
  const { organizationId = null, warehouseId = null, distributionPointId = null } = scope;

  const [data, setData] = useState<CommandCenterReadContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<CommandCenterFailure | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);

  // Whether anything is currently on screen decides first-load vs refresh, and
  // it must be read at effect time rather than captured, so it is a ref.
  const hasData = useRef(false);

  useEffect(() => {
    let active = true;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);
    setFailure(null);

    getCommandCenterReadContract({ organizationId, warehouseId, distributionPointId })
      .then(result => {
        if (!active) return;
        hasData.current = result !== null;
        setData(result);
        setLastLoadedAt(result ? new Date() : null);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error('[phoenix][rac3] command center read failed:', error);
        const classified = classifyCommandCenterError(error);
        /**
         * Fail closed on an authorization answer.
         *
         * If authority was withdrawn while this screen was open, the payload
         * already rendered is no longer something this actor may see, so it is
         * DROPPED rather than left on screen behind an error banner. A
         * transport failure keeps the last good payload, because nothing about
         * the actor's authority changed.
         */
        if (classified.kind === 'unauthorized' || classified.kind === 'unauthenticated') {
          hasData.current = false;
          setData(null);
          setLastLoadedAt(null);
        }
        setFailure(classified);
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      active = false;
    };
  }, [organizationId, warehouseId, distributionPointId, nonce]);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  return { data, loading, refreshing, failure, lastLoadedAt, refresh };
}
