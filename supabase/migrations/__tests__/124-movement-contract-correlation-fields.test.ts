/**
 * MOVEMENT-CONTRACT-CORRELATION-FIELDS-124 — static contract.
 *
 * 124 adds occurred_at/correlation_id/causation_id to the three live
 * quantity ledgers and quantity_before/quantity_after/correlation_id/
 * causation_id to phoenix_movement_events, then threads them through the
 * 123 capture trigger. No new tables, no GRANT, no renamed/dropped column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '124_phoenix_movement_contract_correlation_fields.sql'),
  'utf8',
);

const LEDGERS = ['warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements'];

describe('124 adds occurred_at/correlation_id/causation_id to the three live ledgers', () => {
  for (const table of LEDGERS) {
    it(`adds occurred_at, correlation_id, causation_id to ${table}`, () => {
      const pattern = new RegExp(
        `ALTER TABLE public\\.${table}\\s*\\n\\s*ADD COLUMN IF NOT EXISTS occurred_at\\s+timestamptz,\\s*\\n\\s*ADD COLUMN IF NOT EXISTS correlation_id\\s+uuid,\\s*\\n\\s*ADD COLUMN IF NOT EXISTS causation_id\\s+uuid`,
      );
      expect(migration).toMatch(pattern);
    });

    it(`backfills occurred_at from created_at on ${table} before enforcing NOT NULL`, () => {
      expect(migration).toContain(`UPDATE public.${table} SET occurred_at = created_at WHERE occurred_at IS NULL;`);
    });

    it(`sets occurred_at NOT NULL with a now() default on ${table} (after backfill, so no existing row is orphaned)`, () => {
      const pattern = new RegExp(
        `ALTER TABLE public\\.${table}\\s*\\n\\s*ALTER COLUMN occurred_at SET DEFAULT now\\(\\),\\s*\\n\\s*ALTER COLUMN occurred_at SET NOT NULL`,
      );
      expect(migration).toMatch(pattern);
    });
  }

  it('does NOT touch item_availability_movements (dead writer, out of scope)', () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.item_availability_movements/);
  });
});

describe('124 extends the canonical envelope with before/after + correlation fields', () => {
  it('adds quantity_before, quantity_after, correlation_id, causation_id to phoenix_movement_events', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.phoenix_movement_events\s*\n\s*ADD COLUMN IF NOT EXISTS quantity_before integer,\s*\n\s*ADD COLUMN IF NOT EXISTS quantity_after\s+integer,\s*\n\s*ADD COLUMN IF NOT EXISTS correlation_id\s+uuid,\s*\n\s*ADD COLUMN IF NOT EXISTS causation_id\s+uuid/,
    );
  });
});

describe('124 threads the new fields through phoenix_capture_movement_posted without changing its trigger attachments', () => {
  it('redefines phoenix_capture_movement_posted() as SECURITY DEFINER with pinned search_path', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_capture_movement_posted\(\)[\s\S]{0,200}SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/,
    );
  });

  it('re-revokes EXECUTE from PUBLIC on the redefined function', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.phoenix_capture_movement_posted() FROM PUBLIC');
  });

  it('does NOT re-declare or re-attach any trigger (123 triggers already point at the function by name; CREATE OR REPLACE is enough)', () => {
    expect(migration).not.toMatch(/CREATE TRIGGER/);
    expect(migration).not.toMatch(/DROP TRIGGER/);
  });

  it('does NOT redefine phoenix_capture_stocktake_recorded (stocktakes is out of scope for this ledger-contract slice)', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_stocktake_recorded/);
  });

  it('derives before/after from either on_hand_* or quantity_* column names (handles the warehouse/outlet vs quarantine naming split)', () => {
    expect(migration).toMatch(/NULLIF\(v_new ->> 'on_hand_before', ''\)::integer,\s*\n\s*NULLIF\(v_new ->> 'quantity_before', ''\)::integer/);
    expect(migration).toMatch(/NULLIF\(v_new ->> 'on_hand_after', ''\)::integer,\s*\n\s*NULLIF\(v_new ->> 'quantity_after', ''\)::integer/);
  });

  it('sources the event occurred_at from the ledger row\'s own occurred_at, falling back to now()', () => {
    expect(migration).toContain('v_occurred timestamptz := COALESCE(NEW.occurred_at, now());');
  });

  it('inserts quantity_before, quantity_after, correlation_id, causation_id into phoenix_movement_events', () => {
    expect(migration).toMatch(/quantity_delta, quantity_before, quantity_after, status_after,/);
    expect(migration).toMatch(/correlation_id, causation_id,\s*\n\s*dedupe_key/);
  });

  it('preserves the exact dedupe_key contract from 123 (movement row\'s own id, :posted suffix)', () => {
    expect(migration).toContain("NEW.id::text || ':posted'");
  });
});

describe('124 has a precondition guard and a post-apply verify block', () => {
  it('fails closed if 123 triggers are not already present', () => {
    expect(migration).toMatch(/124 PRECONDITION FAILED: 123 capture triggers missing/);
  });

  it('verifies exactly 9 new ledger columns (3 tables x 3 columns) and 4 new envelope columns', () => {
    expect(migration).toMatch(/124 VERIFY FAILED: expected 9 new ledger columns/);
    expect(migration).toMatch(/124 VERIFY FAILED: expected 4 new phoenix_movement_events columns/);
  });

  it('verifies zero NULL occurred_at rows remain after backfill', () => {
    expect(migration).toMatch(/124 VERIFY FAILED: % existing ledger rows have NULL occurred_at/);
  });
});

describe('124 contains no GRANT and no DROP TABLE/DELETE (additive-only slice)', () => {
  it('never grants to anon or PUBLIC', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
  });

  it('never drops a table or deletes data', () => {
    expect(migration).not.toMatch(/\b(DROP TABLE|DELETE FROM)\b/i);
  });
});
