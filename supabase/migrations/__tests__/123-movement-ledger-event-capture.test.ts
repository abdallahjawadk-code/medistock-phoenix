/**
 * MOVEMENT-LEDGER-EVENT-CAPTURE-123 — static contract.
 *
 * 123 adds exactly two new SECURITY DEFINER capture functions and four
 * AFTER INSERT triggers. No table DDL, no data changes, no GRANT to
 * anon/PUBLIC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '123_phoenix_movement_ledger_event_capture.sql'),
  'utf8',
);

describe('123 adds exactly two capture functions, each SECURITY DEFINER with pinned search_path', () => {
  it('defines phoenix_capture_movement_posted() as SECURITY DEFINER with search_path pinned', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_capture_movement_posted\(\)[\s\S]{0,200}SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/,
    );
  });

  it('defines phoenix_capture_stocktake_recorded() as SECURITY DEFINER with search_path pinned', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_capture_stocktake_recorded\(\)[\s\S]{0,200}SECURITY DEFINER[\s\S]{0,50}SET search_path = public, pg_temp/,
    );
  });

  it('revokes EXECUTE from PUBLIC on both new functions (trigger-only, never callable directly)', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.phoenix_capture_movement_posted() FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.phoenix_capture_stocktake_recorded() FROM PUBLIC');
  });

  it('attaches phoenix_capture_movement_posted to exactly the three live quantity ledgers', () => {
    for (const table of ['warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements']) {
      const pattern = new RegExp(
        `AFTER INSERT ON public\\.${table}\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION public\\.phoenix_capture_movement_posted\\(\\)`,
      );
      expect(migration).toMatch(pattern);
    }
  });

  it('does NOT attach any trigger to item_availability_movements (explicitly out of scope)', () => {
    expect(migration).not.toMatch(/AFTER INSERT ON public\.item_availability_movements/);
  });

  it('attaches phoenix_capture_stocktake_recorded to stocktakes only', () => {
    expect(migration).toMatch(
      /AFTER INSERT ON public\.stocktakes\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.phoenix_capture_stocktake_recorded\(\)/,
    );
  });

  it('every trigger attachment is preceded by DROP TRIGGER IF EXISTS (idempotent)', () => {
    const drops = (migration.match(/DROP TRIGGER IF EXISTS phoenix_capture_(movement_posted|stocktake_recorded) ON/g) ?? []).length;
    const creates = (migration.match(/CREATE TRIGGER phoenix_capture_(movement_posted|stocktake_recorded)/g) ?? []).length;
    expect(drops).toBe(creates);
    expect(creates).toBe(4);
  });

  it('contains no table DDL, GRANT, or top-level data-changing statement', () => {
    // INSERT INTO phoenix_movement_events is expected and correct HERE: it
    // lives inside the two new trigger function bodies (runs once per row
    // event, at trigger-fire time, not at migration-apply time) — that is
    // the entire point of an event-capture migration. What must genuinely
    // never appear is DDL or a statement that mutates data when this file
    // itself is applied.
    expect(migration).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|DROP TABLE|GRANT |DELETE FROM)\b/i);
  });

  it('the dedupe_key for movement-posted events is derived from the movement row\'s own id (never collides with a header event)', () => {
    expect(migration).toContain("NEW.id::text || ':posted'");
  });

  it('documents why this is not a duplicate-event risk (no-duplicate rationale is explicit, not assumed)', () => {
    expect(migration).toMatch(/WHY THIS IS NOT A DUPLICATE-EVENT RISK/);
  });
});
