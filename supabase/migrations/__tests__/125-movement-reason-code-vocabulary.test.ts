/**
 * MOVEMENT-REASON-CODE-VOCABULARY-125 — static contract.
 *
 * 125 adds a NOT NULL, CHECK-constrained reason_code column (with a
 * DEFAULT so no not-yet-migrated writer breaks) to the three live
 * ledgers. No RPC redefinition, no rename of the existing `reason`
 * column, no GRANT.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '..', '125_phoenix_movement_reason_code_vocabulary.sql'),
  'utf8',
);

const LEDGERS = ['warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements'];

const VOCAB = [
  'received', 'transferred', 'dispensed', 'counted', 'corrected', 'released',
  'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged', 'recalled',
  'quality_issue', 'temperature_excursion', 'other', 'legacy_unclassified',
];

describe('125 adds reason_code to the three live ledgers, one shared vocabulary', () => {
  for (const table of LEDGERS) {
    it(`adds reason_code NOT NULL DEFAULT 'legacy_unclassified' to ${table}`, () => {
      const pattern = new RegExp(
        `ALTER TABLE public\\.${table}\\s*\\n\\s*ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'legacy_unclassified'`,
      );
      expect(migration).toMatch(pattern);
    });

    it(`adds a CHECK constraint on ${table} containing exactly the 16-value vocabulary`, () => {
      const chkPattern = new RegExp(
        `ALTER TABLE public\\.${table}\\s*\\n\\s*ADD CONSTRAINT ${table}_reason_code_chk\\s*\\n\\s*CHECK \\(reason_code IN \\(([\\s\\S]{0,400}?)\\)\\);`,
      );
      const match = migration.match(chkPattern);
      expect(match, `expected a reason_code CHECK constraint on ${table}`).not.toBeNull();
      const values = (match?.[1] ?? '').match(/'([a-z_]+)'/g)?.map(s => s.replace(/'/g, '')) ?? [];
      expect(values.sort()).toEqual([...VOCAB].sort());
    });
  }

  it('does NOT touch item_availability_movements (dead writer, out of scope)', () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.item_availability_movements/);
  });
});

describe('125 preserves the existing reason column and touches no RPC', () => {
  it('never renames or drops the existing free-text reason column', () => {
    expect(migration).not.toMatch(/RENAME COLUMN reason/i);
    expect(migration).not.toMatch(/DROP COLUMN reason\b/i);
  });

  it('contains no CREATE OR REPLACE FUNCTION (schema-only slice, RPCs migrated in later domain slices)', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });

  it('contains no GRANT and no DELETE/DROP TABLE', () => {
    expect(migration).not.toMatch(/GRANT .* TO (anon|PUBLIC)/i);
    expect(migration).not.toMatch(/\b(DROP TABLE|DELETE FROM)\b/i);
  });
});

describe('125 has a precondition guard and a post-apply verify block', () => {
  it('fails closed if 124 correlation_id/causation_id columns are not already present', () => {
    expect(migration).toMatch(/125 PRECONDITION FAILED: 124 \(correlation_id\/causation_id\) missing/);
  });

  it('verifies reason_code exists on exactly 3 tables and zero rows are NULL/blank after backfill', () => {
    expect(migration).toMatch(/125 VERIFY FAILED: expected reason_code on 3 tables/);
    expect(migration).toMatch(/125 VERIFY FAILED: % existing ledger rows have a NULL\/blank reason_code/);
  });
});
