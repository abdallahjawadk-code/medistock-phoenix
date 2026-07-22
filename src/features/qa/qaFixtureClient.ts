/**
 * VISUAL-QA-HARNESS-A — network-free fixture Supabase client (DEV/TEST ONLY).
 *
 * Renders real screens against deterministic local data so we can capture
 * layout/theme/RTL/state screenshots WITHOUT a live session or any network.
 *
 * HARD CONSTRAINTS (enforced by shape, not convention):
 *   - SELECT-only. Every `.from(t)` read resolves from local fixtures.
 *   - Any insert / update / delete / upsert resolves to a clear QA error and
 *     mutates nothing.
 *   - An RPC resolves to a fixture ONLY if it is explicitly registered. Every
 *     unregistered RPC — mutating or not — still resolves to the QA read-only
 *     error, so the surface fails closed by default.
 *   - No network, no elevated/admin key, no admin auth API, no RLS — this
 *     client cannot reach Supabase at all. It therefore proves NOTHING about
 *     authorization, RLS or functional correctness; it exists solely for visual QA.
 *
 * SIMULATED MUTATION OUTCOMES — read this before adding one.
 *
 * Some evidence cells only exist AFTER a write: the canonical return receipt
 * (print / XLSX / QR) renders only once a shipment line has been received, and
 * no amount of SELECT fixtures can reach that state. `QA_MUTATION_OUTCOMES`
 * therefore registers a SMALL, EXPLICIT allowlist of migration-071 write RPCs
 * that resolve to a deterministic local outcome.
 *
 * What this does NOT relax: nothing is written anywhere, no database is
 * contacted, no RLS or permission check is bypassed or consulted, and the real
 * RPC is untouched. The harness still cannot reach Supabase. An RPC outside the
 * allowlist fails closed exactly as before, and the whole module is tree-shaken
 * from production builds. This buys a screenshot of a post-write screen — it
 * proves NOTHING about whether the real write would be permitted.
 *
 * This module lives under src/features/qa and is imported ONLY by the dev-only
 * harness, so production builds tree-shake it out entirely (proven by
 * tests/qa-harness-production-safety.test.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { QA_HARNESS_MARKER } from './qaConfig';
import { QA_FIXTURES, QA_MUTATION_OUTCOMES, type QaRow } from './qaData';

export interface QaResult {
  data: unknown;
  error: { message: string; code: string } | null;
  count: number | null;
}

const READONLY_ERROR = {
  message: `${QA_HARNESS_MARKER}: fixture client is read-only (SELECT fixtures only). No writes reach any database.`,
  code: 'QA_READONLY',
};

function ok(data: unknown, count: number | null = null): QaResult {
  return { data, error: null, count };
}

/** A thenable query builder. Filters are best-effort (eq/in) so persona scoping
 *  visibly narrows fixtures; everything else is an inert chainable no-op. */
class QaQueryBuilder implements PromiseLike<QaResult> {
  private rows: QaRow[];
  private readonly mutating: boolean;
  private wantsCountHead = false;
  private singleMode: 'one' | 'maybe' | null = null;

  constructor(rows: QaRow[], mutating = false) {
    this.rows = [...rows];
    this.mutating = mutating;
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.wantsCountHead = true;
    return this;
  }
  eq(col: string, val: unknown): this { this.rows = this.rows.filter(r => r[col] === val); return this; }
  in(col: string, vals: unknown[]): this { this.rows = this.rows.filter(r => vals.includes(r[col])); return this; }
  // Inert chainable no-ops — present so real service query chains don't throw.
  neq(): this { return this; }
  is(): this { return this; }
  not(): this { return this; }
  gte(): this { return this; }
  lte(): this { return this; }
  gt(): this { return this; }
  lt(): this { return this; }
  like(): this { return this; }
  ilike(): this { return this; }
  or(): this { return this; }
  filter(): this { return this; }
  match(): this { return this; }
  contains(): this { return this; }
  overlaps(): this { return this; }
  order(): this { return this; }
  limit(n: number): this { this.rows = this.rows.slice(0, n); return this; }
  range(from: number, to: number): this { this.rows = this.rows.slice(from, to + 1); return this; }
  returns(): this { return this; }
  single(): this { this.singleMode = 'one'; return this; }
  maybeSingle(): this { this.singleMode = 'maybe'; return this; }
  // Mutations: resolve to a QA error, never mutate.
  insert(): this { return new QaQueryBuilder([], true) as this; }
  update(): this { return new QaQueryBuilder([], true) as this; }
  upsert(): this { return new QaQueryBuilder([], true) as this; }
  delete(): this { return new QaQueryBuilder([], true) as this; }

  private resolve(): QaResult {
    if (this.mutating) return { data: null, error: READONLY_ERROR, count: null };
    if (this.wantsCountHead) return { data: null, error: null, count: this.rows.length };
    if (this.singleMode) return ok(this.rows[0] ?? null);
    return ok(this.rows, this.rows.length);
  }

  then<TResult1 = QaResult, TResult2 = never>(
    onfulfilled?: ((value: QaResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

/**
 * Build the fixture client. Cast to SupabaseClient for the consumer surface the
 * services actually use (`.from`, `.rpc`); the unused Supabase API is not
 * implemented because the harness never exercises it.
 */
export function createQaFixtureClient(): SupabaseClient {
  const client = {
    from(table: string) {
      const rows = QA_FIXTURES[table];
      return new QaQueryBuilder(Array.isArray(rows) ? (rows as QaRow[]) : []);
    },
    rpc(name: string) {
      // Read RPCs registered in fixtures return their data (an array OR an
      // object, matching the real RPC's schema).
      const fixture = QA_FIXTURES[`rpc:${name}`];
      if (fixture !== undefined) return Promise.resolve(ok(fixture));

      // Explicitly allowlisted migration-071 write RPCs resolve to a
      // deterministic LOCAL outcome so post-write surfaces (the canonical
      // receipt) are reachable. Nothing is written and no database is touched.
      if (Object.prototype.hasOwnProperty.call(QA_MUTATION_OUTCOMES, name)) {
        return Promise.resolve(ok(QA_MUTATION_OUTCOMES[name]));
      }

      // Everything else — mutating or unknown — still fails closed.
      return Promise.resolve({ data: null, error: READONLY_ERROR, count: null });
    },
    // Auth surface the app touches at render time — inert, no network.
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() { /* noop */ } } } }),
    },
    channel() {
      return { on() { return this; }, subscribe() { return this; }, unsubscribe() { /* noop */ } };
    },
    removeChannel() { /* noop */ },
  };
  return client as unknown as SupabaseClient;
}
