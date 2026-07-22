/**
 * MOVEMENT-TIMELINE-081-A — static SQL contract tests.
 *
 * The dynamic proof (23 assertions: personas, pagination, equal timestamps,
 * indistinguishability, EXPLAIN) is in
 * docs/phoenix/migration-081-timeline-validation.md. These pin the properties
 * that must not regress in review — above all that the migration never claims a
 * completeness the schema cannot support.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '081_phoenix_movement_timeline.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
// Slice the transaction body FIRST, then strip comments. Stripping first would
// shift every offset and silently leave `code` pointing at the wrong region.
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

describe('registration and discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
  it('aborts if re-applied', () => {
    expect(code).toMatch(/phoenix_movement_events.*already exists|already exists.*081/s);
  });
});

describe('it tells the truth about what history exists', () => {
  it('states plainly that a complete retrospective timeline is impossible', () => {
    expect(sql).toMatch(/CANNOT be reconstructed/);
    expect(sql).toMatch(/does not pretend otherwise/);
  });

  it('always reports complete=false', () => {
    expect(code).toContain("'complete', false");
    // There must be no branch that ever reports true.
    expect(code).not.toMatch(/'complete',\s*true/);
  });

  it('explains WHY it is incomplete, in the payload itself', () => {
    expect(code).toContain('completeness_note');
    expect(code).toMatch(/cannot be\s*'?\s*\n?\s*'?reconstructed/);
  });

  it('labels every event with its provenance', () => {
    for (const p of ['movement_row', 'derived_from_column', 'event_ledger']) {
      expect(code).toContain(`'${p}'`);
    }
    expect(code).toContain("'provenance'");
  });

  it('emits a derived event ONLY when its timestamp column is non-NULL', () => {
    // This is what stops an inferred transition being presented as fact.
    const derived = code.slice(code.indexOf('derived_events'), code.indexOf('ledger_events'));
    const guards = (derived.match(/IS NOT NULL/g) ?? []).length;
    const branches = (derived.match(/SELECT/g) ?? []).length;
    expect(guards).toBeGreaterThanOrEqual(branches - 1);
  });
});

describe('the ledger is append-only', () => {
  it('revokes INSERT/UPDATE/DELETE from authenticated and grants only SELECT', () => {
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.phoenix_movement_events FROM authenticated/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.phoenix_movement_events TO authenticated/);
  });

  it('enables RLS and defines only a SELECT policy', () => {
    expect(code).toContain('ENABLE ROW LEVEL SECURITY');
    expect(code).toMatch(/CREATE POLICY[\s\S]{0,200}FOR SELECT TO authenticated/);
    expect(code).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO authenticated/);
  });

  it('is never backfilled with inferred events', () => {
    expect(code).not.toMatch(/INSERT INTO public\.phoenix_movement_events/i);
    expect(sql).toMatch(/[Nn]ever backfilled/);
  });
});

describe('ordering, pagination and limits', () => {
  it('orders by occurred_at then an immutable id tie-breaker', () => {
    expect(code).toMatch(/ORDER BY s\.occurred_at ASC, s\.event_id ASC/);
    expect(code).toMatch(/ORDER BY p\.occurred_at ASC, p\.event_id ASC/);
  });

  it('paginates on the full (occurred_at, event_id) cursor, not on time alone', () => {
    // Time alone would skip or repeat events that share a timestamp.
    expect(code).toContain('(s.occurred_at, s.event_id) > (p_after_at, p_after_id)');
  });

  it('clamps the page size at both ends', () => {
    expect(code).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 200\)/);
  });
});

describe('security posture', () => {
  it('is SECURITY DEFINER, STABLE, with a pinned search_path', () => {
    expect(code).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
  });

  it('grants EXECUTE to authenticated only', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_movement_timeline\([^)]*\) FROM PUBLIC/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_movement_timeline\([^)]*\) TO authenticated/);
    expect(code).not.toMatch(/TO anon\b/);
    expect(code).not.toMatch(/GRANT[^;]*TO service_role/);
  });

  it('applies an exact per-event scope check', () => {
    expect(code).toMatch(/v_role = 'super_admin'\s*\n?\s*OR \(v_org IS NOT NULL AND a\.organization_id = v_org\)/);
  });

  it('returns the SAME empty shape for unauthorized and for nonexistent', () => {
    // An inactive/unknown profile returns v_empty, exactly as a missing trace
    // does, so the RPC cannot be used to probe whether a trace exists.
    expect(code).toContain('RETURN v_empty;');
    expect((code.match(/RETURN v_empty;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('writes nothing — it is a read path', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_movement_timeline'));
    expect(fn).not.toMatch(/\bINSERT INTO\b|\bUPDATE public\.|\bDELETE FROM\b/);
  });
});

describe('indexes and operational docs', () => {
  it('adds a reference_id index to every movement source it scans', () => {
    for (const idx of [
      'warehouse_stock_movements_reference_idx',
      'outlet_stock_movements_reference_idx',
      'warehouse_quarantine_movements_reference_idx',
      'item_availability_movements_dispatch_idx',
    ]) expect(code).toContain(idx);
  });

  it('ships post-conditions, an EXPLAIN check and a rollback', () => {
    expect(sql).toContain('POST-CONDITIONS');
    expect(sql).toContain('EXPLAIN');
    expect(sql).toContain('ROLLBACK / CONTAINMENT');
    expect(sql).toContain('DROP TABLE IF EXISTS public.phoenix_movement_events');
  });
});
