/**
 * MOVEMENT-COMPOSER-A — committing a draft, and surviving a partial failure.
 *
 * The backend requires header-then-lines: phoenix_create_*_request returns an
 * id, then each line is a separate phoenix_add_*_line call. That is NOT one
 * atomic database transaction, and this module never pretends otherwise. It is
 * presented to the operator as one deliberate action, but the result reports
 * exactly which lines landed and which did not.
 *
 * THE DANGEROUS CASE this exists to handle: the header is created, some lines
 * succeed, then the network dies. Blindly re-running the whole sequence would
 * create a SECOND header and duplicate the surviving lines. So:
 *
 *   - the header is created once and its id is preserved;
 *   - retry never re-creates the header;
 *   - retry never blindly re-sends add-line calls, because they are not
 *     idempotent — it first reloads the canonical server lines and re-sends
 *     only what is genuinely absent.
 *
 * Every dependency is injected, so the whole protocol is testable without a
 * database and without mocking the Supabase client.
 */
import type { DraftLine, MovementDirection } from './composer-model';

export interface RpcOutcome {
  ok: boolean;
  error?: string | null;
  data?: Record<string, unknown> | null;
}

export type LineCommitState = 'pending' | 'succeeded' | 'failed';

export interface LineCommitResult {
  idempotencyKey: string;
  state: LineCommitState;
  /** Server id of the created request line, when known. */
  serverLineId: string | null;
  error: string | null;
}

export interface CommitProgress {
  total: number;
  completed: number;
  currentIdempotencyKey: string | null;
}

export interface CommitResult {
  /** The canonical trace key of the created request. Null only if the header failed. */
  requestId: string | null;
  headerError: string | null;
  lines: LineCommitResult[];
  /** True when the header exists and every line landed. */
  complete: boolean;
  /** True when the header exists but at least one line did not land. */
  partial: boolean;
}

export interface CommitDeps {
  /** Creates the request header. Called at most ONCE per commit attempt. */
  createHeader: () => Promise<RpcOutcome>;
  /** Adds one line to an existing header. NOT idempotent. */
  addLine: (requestId: string, line: DraftLine) => Promise<RpcOutcome>;
  onProgress?: (progress: CommitProgress) => void;
}

function readId(outcome: RpcOutcome): string | null {
  const data = outcome.data ?? {};
  // Every header/line RPC returns its new id under one of these keys. Broadened
  // additively for the 070 outlet-dispatch corridor (dispatch_id / dispatch_line_id)
  // — existing payloads never carry these, so the order below is unaffected.
  for (const key of [
    'id', 'request_id', 'transfer_request_id', 'return_request_id',
    'dispatch_id', 'dispatch_line_id',
  ]) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Create the header, then add every line, reporting per-line progress.
 *
 * A partial header is NEVER silently abandoned: the returned requestId is
 * always surfaced so the caller can offer reload-and-retry or the existing
 * cancellation RPC.
 */
export async function commitDraft(lines: readonly DraftLine[], deps: CommitDeps): Promise<CommitResult> {
  const header = await deps.createHeader();
  if (!header.ok) {
    return {
      requestId: null,
      headerError: header.error ?? 'header_failed',
      lines: lines.map(l => ({ idempotencyKey: l.idempotencyKey, state: 'pending' as const, serverLineId: null, error: null })),
      complete: false,
      partial: false,
    };
  }

  const requestId = readId(header);
  if (!requestId) {
    // The header may exist server-side but we cannot address it. Say so rather
    // than guessing an id or retrying blindly into a duplicate.
    return {
      requestId: null,
      headerError: 'header_created_but_id_missing',
      lines: lines.map(l => ({ idempotencyKey: l.idempotencyKey, state: 'pending' as const, serverLineId: null, error: null })),
      complete: false,
      partial: false,
    };
  }

  const results = await addLines(requestId, lines, deps);
  const failed = results.filter(r => r.state !== 'succeeded');
  return {
    requestId,
    headerError: null,
    lines: results,
    complete: failed.length === 0,
    partial: failed.length > 0,
  };
}

async function addLines(requestId: string, lines: readonly DraftLine[], deps: CommitDeps): Promise<LineCommitResult[]> {
  const results: LineCommitResult[] = [];
  let completed = 0;

  for (const line of lines) {
    deps.onProgress?.({ total: lines.length, completed, currentIdempotencyKey: line.idempotencyKey });
    let outcome: RpcOutcome;
    try {
      outcome = await deps.addLine(requestId, line);
    } catch (cause) {
      outcome = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    results.push({
      idempotencyKey: line.idempotencyKey,
      state: outcome.ok ? 'succeeded' : 'failed',
      serverLineId: outcome.ok ? readId(outcome) : null,
      error: outcome.ok ? null : (outcome.error ?? 'line_failed'),
    });
    completed += 1;
    deps.onProgress?.({ total: lines.length, completed, currentIdempotencyKey: null });
  }

  return results;
}

/** A canonical server line, as reloaded before any retry. */
export interface ServerRequestLine {
  id: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  originalTransferLineId: string | null;
  requestedQuantity: number;
}

/**
 * Decide what a retry may safely re-send.
 *
 * `phoenix_add_*_line` has no idempotency token, so re-sending a line that
 * actually landed would duplicate it. The ONLY safe basis for retry is the
 * canonical server state, so this takes the reloaded lines and returns just the
 * draft lines with no server counterpart.
 */
export function planRetry(
  draft: readonly DraftLine[],
  serverLines: readonly ServerRequestLine[],
  direction: MovementDirection,
): { toSend: DraftLine[]; alreadyPresent: string[] } {
  const key = (l: { scientificName: string; batchNumber: string | null; expiryDate: string | null; originalTransferLineId: string | null }) =>
    direction === 'return' && l.originalTransferLineId
      ? `prov:${l.originalTransferLineId}`
      : `name:${l.scientificName.trim().toLowerCase()}|${(l.batchNumber ?? '').trim().toLowerCase()}|${l.expiryDate ?? ''}`;

  const present = new Set(serverLines.map(key));
  const toSend: DraftLine[] = [];
  const alreadyPresent: string[] = [];

  for (const line of draft) {
    if (present.has(key(line))) alreadyPresent.push(line.idempotencyKey);
    else toSend.push(line);
  }
  return { toSend, alreadyPresent };
}

// ── batch dispatch ───────────────────────────────────────────────────────────

export interface DispatchLineInput {
  /** Stable per-line idempotency token. Generated ONCE, reused on every retry. */
  idempotencyKey: string;
  /** The approved request line being fulfilled. */
  requestLineId: string;
  /** SUPPLY: source stock row. RETURN: unused (provenance drives it). */
  warehouseStockId: string | null;
  quantity: number;
}

export interface DispatchLineResult {
  idempotencyKey: string;
  requestLineId: string;
  state: LineCommitState;
  error: string | null;
}

export interface DispatchResult {
  /** The one operator reference applied to every line in this batch. */
  externalReference: string;
  lines: DispatchLineResult[];
  complete: boolean;
  partial: boolean;
}

export interface DispatchDeps {
  /**
   * Sends ONE line. The implementation must pass `idempotencyKey` as the RPC's
   * p_request_id, which is what makes a retry safe server-side.
   */
  sendLine: (input: DispatchLineInput, externalReference: string) => Promise<RpcOutcome>;
  onProgress?: (progress: CommitProgress) => void;
}

/**
 * Dispatch a batch of approved lines as ONE event.
 *
 * The previous UI asked for a transfer/shipment number inside each per-line
 * send form, so a single physical consignment could end up split across
 * several unrelated numbers. Here one reference is chosen once and applied to
 * every line in the batch.
 *
 * Unlike add-line, the send RPCs DO take an idempotency token, so retrying a
 * failed line with its original key cannot double-post the movement.
 */
export async function dispatchBatch(
  inputs: readonly DispatchLineInput[],
  externalReference: string,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const lines: DispatchLineResult[] = [];
  let completed = 0;

  for (const input of inputs) {
    deps.onProgress?.({ total: inputs.length, completed, currentIdempotencyKey: input.idempotencyKey });
    let outcome: RpcOutcome;
    try {
      outcome = await deps.sendLine(input, externalReference);
    } catch (cause) {
      outcome = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    lines.push({
      idempotencyKey: input.idempotencyKey,
      requestLineId: input.requestLineId,
      state: outcome.ok ? 'succeeded' : 'failed',
      error: outcome.ok ? null : (outcome.error ?? 'send_failed'),
    });
    completed += 1;
    deps.onProgress?.({ total: inputs.length, completed, currentIdempotencyKey: null });
  }

  const failed = lines.filter(l => l.state !== 'succeeded');
  return {
    externalReference,
    lines,
    complete: failed.length === 0,
    partial: failed.length > 0,
  };
}

/** Only unsent lines may be retried, each keeping its ORIGINAL idempotency key. */
export function retryableDispatchLines(
  inputs: readonly DispatchLineInput[],
  previous: DispatchResult,
): DispatchLineInput[] {
  const failed = new Set(previous.lines.filter(l => l.state !== 'succeeded').map(l => l.idempotencyKey));
  return inputs.filter(i => failed.has(i.idempotencyKey));
}

/**
 * Whether a dispatch may be printed as an OFFICIAL receipt.
 *
 * A partially dispatched batch must never produce a document that reads as
 * complete. The caller still reloads the canonical server transfer/shipment;
 * this only decides which watermark the document carries.
 */
export function receiptStatusFor(result: DispatchResult): 'official' | 'partial' | 'none' {
  if (result.lines.length === 0) return 'none';
  if (result.complete) return 'official';
  if (result.lines.some(l => l.state === 'succeeded')) return 'partial';
  return 'none';
}
