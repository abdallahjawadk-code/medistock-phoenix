/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A
 *
 * "حذف مواد المنفذ" (clear port items) showed a raw/unclassified error
 * instead of a precise translated message. Root cause: clear_port_availability
 * (migration 007) hard-DELETEs item_availability rows; item_availability_movements
 * references that table ON DELETE RESTRICT (migration 033, added later) — so
 * clearing a port that has ANY quantity-movement history now fails with a
 * Postgres 23503 foreign-key violation. The single-item "إزالة من المنفذ"
 * (remove from outlet) action never hits this because it only UPDATEs
 * quantity/condition, never deletes the row — matching the reported symptom
 * that the small remove action works while bulk clear does not.
 *
 * This phase adds precise frontend classification of clear_port_availability
 * failures (classifyClearPortItemsError) so the user gets an honest,
 * actionable, translated message instead of a raw backend code or a
 * misleading generic load-failure toast. It does NOT change the RPC itself
 * (no migrations in this phase) — see the report's proposed migration plan
 * for the actual backend fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { classifyClearPortItemsError } from '@/shared/supabase/services/lifecycle.service';
import { T } from '@/shared/i18n/strings';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');
const lifecycleService = readSrc('shared/supabase/services/lifecycle.service.ts');

describe('classifyClearPortItemsError: precise error classification', () => {
  it('classifies a Postgres 23503 foreign-key violation (movement history exists) as dw_clear_has_movements', () => {
    expect(classifyClearPortItemsError({ code: '23503', message: 'update or delete on table "item_availability" violates foreign key constraint' })).toBe('dw_clear_has_movements');
  });

  it('classifies by message text even without a code (RPC error passthrough)', () => {
    expect(classifyClearPortItemsError(new Error('violates foreign key constraint "item_availability_movements_item_availability_id_fkey"'))).toBe('dw_clear_has_movements');
  });

  it('classifies INSUFFICIENT_ROLE as dw_clear_forbidden_role', () => {
    expect(classifyClearPortItemsError(new Error('INSUFFICIENT_ROLE'))).toBe('dw_clear_forbidden_role');
  });

  it('classifies FORBIDDEN_ORG as dw_clear_forbidden_org', () => {
    expect(classifyClearPortItemsError(new Error('FORBIDDEN_ORG'))).toBe('dw_clear_forbidden_org');
  });

  it('classifies CONFIRMATION_MISMATCH as dw_clear_confirmation_mismatch', () => {
    expect(classifyClearPortItemsError(new Error('CONFIRMATION_MISMATCH'))).toBe('dw_clear_confirmation_mismatch');
  });

  it('classifies POINT_NOT_FOUND as dw_clear_point_not_found', () => {
    expect(classifyClearPortItemsError(new Error('POINT_NOT_FOUND'))).toBe('dw_clear_point_not_found');
  });

  it('falls back to load_error only for a genuinely unclassified failure', () => {
    expect(classifyClearPortItemsError(new Error('network down'))).toBe('load_error');
    expect(classifyClearPortItemsError('not an error object')).toBe('load_error');
  });

  it('all classified keys exist bilingually in strings.ts', () => {
    for (const key of ['dw_clear_has_movements', 'dw_clear_forbidden_role', 'dw_clear_forbidden_org', 'dw_clear_confirmation_mismatch', 'dw_clear_point_not_found']) {
      expect(T[key], `missing key: ${key}`).toBeTruthy();
      expect(T[key].ar).toBeTruthy();
      expect(T[key].en).toBeTruthy();
    }
  });
});

describe('PortCleanupWizard: uses precise classification, not raw error text', () => {
  it('onClearItems catch block classifies via classifyClearPortItemsError, not e.message directly', () => {
    const fnStart = screen.indexOf('async function onClearItems');
    const fnBody = screen.slice(fnStart, screen.indexOf('return (', fnStart));
    expect(fnBody).toContain('classifyClearPortItemsError(e)');
    expect(fnBody).not.toMatch(/onToast\(e instanceof Error \? e\.message/);
  });

  it('onClearItems logs the real error to console (developer diagnostics preserved)', () => {
    const fnStart = screen.indexOf('async function onClearItems');
    const fnBody = screen.slice(fnStart, screen.indexOf('return (', fnStart));
    expect(fnBody).toMatch(/console\.error\(/);
  });

  it('a successful clear still shows the honest dw_cleared success toast and reloads impact', () => {
    const fnStart = screen.indexOf('async function onClearItems');
    const fnBody = screen.slice(fnStart, screen.indexOf('return (', fnStart));
    expect(fnBody).toContain("onToast(t('dw_cleared', lang))");
    expect(fnBody).toContain('impact.reload()');
  });
});

describe('clear_port_availability RPC: frontend call contract unchanged by BUGFIX-CLEAR-PORT-AVAILABILITY-RPC-A', () => {
  // Migration 042 (BUGFIX-CLEAR-PORT-AVAILABILITY-RPC-A) redefines the RPC's
  // SQL body (UPDATE instead of DELETE) but preserves its name and argument
  // list — the frontend contract established in this phase (BUGFIX-REPORTS-
  // DATES-PORT-CLEAR-A) needs no change and should not be touched.
  it('lifecycle.service.ts still calls the existing clear_port_availability RPC with the existing confirmation contract', () => {
    expect(lifecycleService).toContain("supabase.rpc('clear_port_availability'");
    expect(lifecycleService).toContain('p_confirmation: confirmation');
  });

  it('classifyClearPortItemsError is exported for the UI to consume', () => {
    expect(lifecycleService).toContain('export function classifyClearPortItemsError');
  });

  it('the FK-violation (23503) classification is still present — defensive/backward-compatible for any environment where migration 042 is not yet applied', () => {
    expect(lifecycleService).toContain("code === '23503'");
    expect(lifecycleService).toContain('dw_clear_has_movements');
  });

  it('migration 042 exists and redefines clear_port_availability to stop deleting item_availability rows', () => {
    const ROOT = join(__dirname, '../../../../');
    const migration042 = readFileSync(join(ROOT, 'supabase/migrations/042_phoenix_clear_port_availability_movement_safe.sql'), 'utf8');
    expect(migration042).toContain('CREATE OR REPLACE FUNCTION public.clear_port_availability(');
    expect(migration042).toMatch(/UPDATE item_availability[\s\S]{0,80}quantity\s*=\s*0/);
  });
});

describe('Movement history: immutable audit ledger — no unsafe delete path added', () => {
  const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
  const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
  const movementReportSection = readSrc('features/status/MovementReportSection.tsx');

  it('migration 033 explicitly revokes INSERT/UPDATE/DELETE on item_availability_movements from authenticated', () => {
    const ROOT = join(__dirname, '../../../../');
    const migration = readFileSync(join(ROOT, 'supabase/migrations/033_phoenix_availability_movements_schema.sql'), 'utf8');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.item_availability_movements FROM authenticated');
    expect(migration).toContain('immutable SELECT-only ledger');
  });

  it('no migration contains a GRANT ... DELETE statement naming item_availability_movements', () => {
    const ROOT = join(__dirname, '../../../../');
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql'));
    const grantDeleteLine = /^\s*GRANT\b[^;\n]*\bDELETE\b[^;\n]*item_availability_movements|^\s*GRANT\b[^;\n]*item_availability_movements[^;\n]*\bDELETE\b/im;
    for (const f of files) {
      const content = readFileSync(join(migrationsDir, f), 'utf8');
      expect(content, `${f} must not GRANT DELETE on item_availability_movements`).not.toMatch(grantDeleteLine);
    }
  });

  it('availability.service.ts exposes no delete/remove function for movements', () => {
    expect(availabilityService).not.toMatch(/export (async )?function delete.*[Mm]ovement/);
    expect(availabilityService).not.toMatch(/export (async )?function (clear|remove|purge).*[Mm]ovement/);
  });

  it('MovementHistoryModal is read-only: no mutating RPC/table call anywhere in the file', () => {
    expect(movementHistoryModal).not.toMatch(/\.rpc\(/);
    expect(movementHistoryModal).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('MovementReportSection is read-only: no mutating RPC/table call anywhere in the file', () => {
    expect(movementReportSection).not.toMatch(/\.rpc\(/);
    expect(movementReportSection).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('no clear/delete-movements RPC call or permission key exists anywhere in the frontend', () => {
    // Scoped to actual calls/keys, not prose — InstitutionScreen.tsx legitimately
    // discusses "DELETE ... movement" in a comment explaining why the per-item
    // remove path uses UPDATE instead (see onConfirmRemove above PortAvailabilitySection).
    expect(screen).not.toMatch(/\.rpc\(\s*['"](clear|delete|purge)_.*movement/i);
    const permissions = readSrc('shared/lib/permissions.ts');
    expect(permissions).not.toMatch(/movements?\.(clear|delete|purge)/i);
  });

  it('the clear-has-movements message points the user at the safe per-item alternative instead of implying data loss', () => {
    expect(T.dw_clear_has_movements.ar).toContain('إزالة من المنفذ');
    expect(T.dw_clear_has_movements.en.toLowerCase()).toContain('remove from outlet');
  });
});

describe('QrPreviewModal (institutions QR print): popup-blocked handling and stable dates', () => {
  const fnBody = screen.slice(screen.indexOf('function QrPreviewModal'), screen.indexOf('if (!open) return null;'));

  it('handlePrint shows print_popup_blocked instead of a silent return when window.open fails', () => {
    expect(fnBody).toMatch(/if \(!win\) \{/);
    expect(fnBody).toContain("onToast(t('print_popup_blocked', lang))");
    expect(fnBody).not.toMatch(/if \(!win\) return;/);
  });

  it('the printed date uses formatStableDate, not a raw locale call', () => {
    expect(fnBody).toContain('const generated = formatStableDate(new Date(), lang);');
  });

  it('the printed date paragraph carries dir="ltr" (previously unwrapped, causing RTL bidi reordering)', () => {
    expect(fnBody).toContain('<p class="date" dir="ltr">${esc(generated)}</p>');
  });

  it('QrPreviewModal accepts and is passed an onToast prop from PortCard', () => {
    expect(screen).toMatch(/function QrPreviewModal\(\{[^}]*onToast[^}]*\}/);
    const callSite = screen.slice(screen.indexOf('<QrPreviewModal'), screen.indexOf('<QrPreviewModal') + 500);
    expect(callSite).toContain('onToast={onToast}');
  });
});
