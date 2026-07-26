/**
 * MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122 — static contract.
 *
 * 122 is additive-only: attaches the EXISTING phoenix_capture_lifecycle
 * trigger (unmodified) to the two correction-request tables that were never
 * wired. No new trigger function, no table DDL, no data changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '122_phoenix_movement_timeline_correction_coverage.sql'),
  'utf8',
);

describe('122 attaches the existing trigger to exactly two tables, nothing else', () => {
  it('contains exactly two CREATE TRIGGER statements, both phoenix_capture_lifecycle', () => {
    const matches = migration.match(/CREATE TRIGGER phoenix_capture_lifecycle/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('attaches to phoenix_stock_correction_requests with organization_id as the home-org arg', () => {
    expect(migration).toMatch(
      /AFTER INSERT OR UPDATE ON public\.phoenix_stock_correction_requests\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.phoenix_capture_lifecycle_event\('organization_id'\)/,
    );
  });

  it('attaches to phoenix_warehouse_correction_requests with organization_id as the home-org arg', () => {
    expect(migration).toMatch(
      /AFTER INSERT OR UPDATE ON public\.phoenix_warehouse_correction_requests\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.phoenix_capture_lifecycle_event\('organization_id'\)/,
    );
  });

  it('does not define a new trigger function (reuses phoenix_capture_lifecycle_event as-is)', () => {
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).not.toContain('CREATE FUNCTION');
  });

  it('contains no table DDL, GRANT, REVOKE, or data-changing statement', () => {
    expect(migration).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|DROP TABLE|GRANT |REVOKE |INSERT INTO|UPDATE\s+public\.|DELETE FROM)\b/i);
  });

  it('each trigger attachment is preceded by DROP TRIGGER IF EXISTS (idempotent)', () => {
    const dropCount = (migration.match(/DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON/g) ?? []).length;
    expect(dropCount).toBe(2);
  });

  it('explicitly documents the deferred items (stocktakes, raw ledger tables) rather than silently omitting them', () => {
    expect(migration).toContain('stocktakes');
    expect(migration).toContain('warehouse_stock_movements');
    expect(migration).toContain('outlet_stock_movements');
    expect(migration).toContain('warehouse_quarantine_stock_movements');
  });
});
