/**
 * CN-2B trusted server — browser/Node full parse-result parity.
 *
 * WHAT THIS COMPARES. Everything the frozen CN-2A contract defines, with
 * exactly two exceptions, both named by the contract itself:
 *   * `ParserIdentity.runtime`            — 'browser_worker' vs 'node'
 *   * `SourceProvenance.extractedAt`      — when the parse ran
 * For an archive the comparison covers the ENTIRE `ArchiveParseResult` —
 * container fingerprint, entry order, per-entry diagnostics, excluded entries,
 * reconciliation totals and every workbook cell — not merely `sourceRecords`.
 * Nothing else is masked, softened or tolerated.
 *
 * WHAT THIS IS NOT. This is not the canonical digest. The digest is computed
 * by PostgreSQL (`_phoenix_central_needs_payload_digest_v1`) because only
 * PostgreSQL can define PostgreSQL's `jsonb::text`. The serializer here exists
 * only to compare two in-memory JavaScript values produced by the same code on
 * two runtimes, so it is free to be stricter than JSON — and it is:
 * `undefined` is distinguished from an absent key, `-0` from `0`, and
 * non-finite numbers from `null`. Any of those differences is a genuine
 * anomaly worth failing on, and none of them can be expressed once a value has
 * been through `JSON.stringify`.
 */

const RUNTIME_MASK = '<runtime>';
const EXTRACTED_AT_MASK = '<extractedAt>';

export interface ParityDifference {
  /** JSON path of the first disagreement, e.g. `entries[2].workbook.sheets[0].cells[17].rawValue`. */
  path: string;
  /** Kind of disagreement. Deliberately carries no workbook cell content. */
  kind: 'type' | 'value' | 'length' | 'missing_key' | 'extra_key';
}

export interface ParityResult {
  equal: boolean;
  difference?: ParityDifference;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Masks the two permitted runtime differences on a deep copy. The input is
 * never mutated: the Node result is persisted verbatim afterwards, so a
 * masking pass must not be able to alter what gets written.
 */
function maskFileResult(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = { ...input };

  if (isPlainObject(out.identity)) {
    out.identity = { ...out.identity, runtime: RUNTIME_MASK };
  }

  if (Array.isArray(out.sourceRecords)) {
    out.sourceRecords = out.sourceRecords.map((record) => {
      if (!isPlainObject(record)) return record;
      const copy: Record<string, unknown> = { ...record };
      if (isPlainObject(copy.sourceProvenance)) {
        copy.sourceProvenance = { ...copy.sourceProvenance, extractedAt: EXTRACTED_AT_MASK };
      }
      return copy;
    });
  }

  return out;
}

/** Masks an archive result: the archive-level identity plus every nested entry. */
export function maskArchiveResult(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = { ...input };

  if (isPlainObject(out.identity)) {
    out.identity = { ...out.identity, runtime: RUNTIME_MASK };
  }
  if (Array.isArray(out.entries)) {
    out.entries = out.entries.map(maskFileResult);
  }
  return out;
}

export function maskResult(input: unknown, kind: 'file' | 'archive'): unknown {
  return kind === 'archive' ? maskArchiveResult(input) : maskFileResult(input);
}

/**
 * Structural deep comparison. Returns the first difference found, walking in a
 * deterministic order so the reported path is reproducible for a given pair.
 */
function diff(a: unknown, b: unknown, path: string): ParityDifference | null {
  if (a === undefined || b === undefined) {
    if (a === undefined && b === undefined) return null;
    return { path, kind: 'value' };
  }

  if (a === null || b === null) {
    return a === b ? null : { path, kind: a === null || b === null ? 'type' : 'value' };
  }

  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) return { path, kind: 'type' };

  if (ta === 'array') {
    const xa = a as unknown[];
    const xb = b as unknown[];
    if (xa.length !== xb.length) return { path, kind: 'length' };
    for (let i = 0; i < xa.length; i += 1) {
      const d = diff(xa[i], xb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  if (ta === 'object') {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(oa), ...Object.keys(ob)])).sort();
    for (const key of keys) {
      const hasA = Object.prototype.hasOwnProperty.call(oa, key);
      const hasB = Object.prototype.hasOwnProperty.call(ob, key);
      const child = path === '' ? key : `${path}.${key}`;
      if (hasA && !hasB) return { path: child, kind: 'missing_key' };
      if (!hasA && hasB) return { path: child, kind: 'extra_key' };
      const d = diff(oa[key], ob[key], child);
      if (d) return d;
    }
    return null;
  }

  if (ta === 'number') {
    const na = a as number;
    const nb = b as number;
    // Object.is separates -0 from 0 and treats NaN as equal to NaN, which is
    // the behaviour we want: a sign-of-zero drift between runtimes is real.
    return Object.is(na, nb) ? null : { path, kind: 'value' };
  }

  return a === b ? null : { path, kind: 'value' };
}

/**
 * Compares a provisional browser result with the authoritative Node result.
 *
 * `browser` is untrusted input that arrived through private staging, so it is
 * treated purely as data: no key from it is ever executed, resolved or used to
 * address anything.
 */
export function compareParsedResults(
  browser: unknown,
  node: unknown,
  kind: 'file' | 'archive',
): ParityResult {
  const difference = diff(maskResult(browser, kind), maskResult(node, kind), '');
  return difference ? { equal: false, difference } : { equal: true };
}
