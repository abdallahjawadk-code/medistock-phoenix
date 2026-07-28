/**
 * TRANSFER-SUGGESTION-DRAFT-BRIDGE-148 — report isolation (Phase 4).
 *
 * Static source guards proving the reviewer's report-correction requirements
 * hold, without needing a live database for every check:
 *   - custody chain excludes draft-status dispatches/return requests —
 *     custody begins at the real send/dispatch event, never at draft
 *     creation (a 148-created draft included).
 *   - the movement ledger report (138) and the monthly status report (092)
 *     never reference inventory_transfer_suggestions or any of the 148
 *     draft-linkage columns — a suggestion/draft can never double-count
 *     into the canonical movement ledger or the monthly balance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const custodyService = read('src/features/reports/custody-chain.service.ts');
const movementLedgerMigration = read('supabase/migrations/138_phoenix_movement_ledger_report.sql');
const movementLedgerServiceFiles = [
  'src/features/reports/movement-ledger-report.service.ts',
];
const monthlyStatusMigration = read('supabase/migrations/092_phoenix_monthly_status_redesign.sql');

const FORBIDDEN_REFS = /inventory_transfer_suggestions|draft_warehouse_transfer_request_id|draft_warehouse_dispatch_id|draft_outlet_return_request_id/;

describe('custody chain excludes drafts (Phase 4 reviewer fix)', () => {
  it('listCustodyDispatches filters out status=draft', () => {
    expect(custodyService).toMatch(/listCustodyDispatches[\s\S]{0,300}filter\(d => d\.status !== 'draft'\)/);
  });

  it('listCustodyReturnRequests filters out status=draft', () => {
    expect(custodyService).toMatch(/listCustodyReturnRequests[\s\S]{0,300}filter\(r => r\.status !== 'draft'\)/);
  });

  it('documents why: custody starts at send/dispatch, not draft creation', () => {
    expect(custodyService).toMatch(/custody (begins|starts) at the real/);
    expect(custodyService).toMatch(/never at draft creation/);
  });
});

describe('movement ledger report (138) never sources from suggestion/draft tables', () => {
  it('migration 138 does not reference inventory_transfer_suggestions or any 148 draft column', () => {
    expect(movementLedgerMigration).not.toMatch(FORBIDDEN_REFS);
  });

  it('the frontend movement-ledger-report service does not reference them either', () => {
    for (const rel of movementLedgerServiceFiles) {
      const src = read(rel);
      expect(src).not.toMatch(FORBIDDEN_REFS);
    }
  });
});

describe('monthly status report (092) never sources from suggestion/draft tables', () => {
  it('phoenix_status_prepare_report does not reference inventory_transfer_suggestions or any 148 draft column', () => {
    const fnStart = monthlyStatusMigration.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = monthlyStatusMigration.indexOf('\n$$;', fnStart);
    const fnBody = monthlyStatusMigration.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 20000);
    expect(fnBody).not.toMatch(FORBIDDEN_REFS);
    // Confirms the balance source really is live committed stock, not a draft.
    expect(fnBody).toMatch(/warehouse_stock/);
    expect(fnBody).toMatch(/outlet_stock/);
  });
});
