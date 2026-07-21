/**
 * BUGFIX-MOVEMENT-REPORT-NO-RESULTS-A
 * Run: npm test -- --run
 *
 * Root cause: getAvailabilityMovementsReport() built its PostgREST `.or(...)`
 * ilike filter by interpolating the raw, unescaped search term directly into
 * the filter-grammar string. PostgREST treats comma, parentheses, and
 * double-quote as RESERVED characters in that grammar — all common in real
 * pharmaceutical names (e.g. "Augmentin (Amoxicillin, Clavulanate)") — so a
 * search matching an otherwise-visible movement could silently return zero
 * rows. Separately, the date-range filters appended a literal 'Z' to a plain
 * local calendar date, which is only correct for UTC+0 users; for this
 * project's real users (Baghdad, UTC+3), that shifted `dateFrom` three hours
 * late and could exclude movements made between local midnight and 3 AM.
 *
 * This file uses REAL function execution (not just source pattern matching)
 * wherever possible, since the bug was a logic/escaping defect, not merely a
 * missing keyword.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../../tests/helpers/retired-surfaces';
import {
  escapePostgrestIlikeValue,
  startOfLocalDayIso,
  endOfLocalDayIso,
} from '@/shared/supabase/services/availability.service';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const service      = readSrc('shared/supabase/services/availability.service.ts');
const section      = readSrc('features/status/MovementReportSection.tsx');
const historyModal = readSrc('features/status/MovementHistoryModal.tsx');
const adjustModal  = readSrc('features/status/AdjustQuantityModal.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');

// ============================================================================
// 1. Report with no filters
// ============================================================================

describe('getAvailabilityMovementsReport: no-filter baseline', () => {
  const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
  const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));

  it('scopes strictly by organization_id (required, always applied)', () => {
    expect(fnBody).toContain(".eq('organization_id', filters.organizationId)");
  });

  it('orders by created_at descending so the newest movement is always first', () => {
    expect(fnBody).toMatch(/\.order\('created_at',\s*\{\s*ascending:\s*false\s*\}\)/);
  });

  it('applies a limit (defaulting to 200)', () => {
    expect(fnBody).toMatch(/\.limit\(filters\.limit \?\? 200\)/);
  });

  it('materialSearch/actorSearch are optional — omitting them applies no .or() filter at all', () => {
    // Both `.or(` calls are guarded by `if (filters.materialSearch?.trim())` /
    // `if (filters.actorSearch?.trim())` — with both filters undefined, no
    // .or() branch executes, so a caller with only organizationId gets every
    // recent movement, matching "no filters -> show latest rows".
    expect(fnBody).toMatch(/if \(filters\.materialSearch\?\.trim\(\)\) \{/);
    expect(fnBody).toMatch(/if \(filters\.actorSearch\?\.trim\(\)\) \{/);
  });
});

// ============================================================================
// 2. Date filter — real functional tests of the fixed boundary helpers
// ============================================================================

describe('Date boundary helpers: local-day-aware, not naively UTC', () => {
  it('startOfLocalDayIso does NOT just concatenate a literal Z suffix', () => {
    // The bug: `${dateFrom}T00:00:00.000Z` assumes the calendar date is
    // already UTC midnight, which is wrong for any non-zero UTC offset.
    const iso = startOfLocalDayIso('2026-07-01');
    expect(iso).not.toBe('2026-07-01T00:00:00.000Z');
    // It must still be a valid, parseable ISO instant.
    expect(new Date(iso).toString()).not.toBe('Invalid Date');
  });

  it('endOfLocalDayIso does NOT just concatenate a literal Z suffix', () => {
    const iso = endOfLocalDayIso('2026-07-01');
    expect(iso).not.toBe('2026-07-01T23:59:59.999Z');
    expect(new Date(iso).toString()).not.toBe('Invalid Date');
  });

  it('startOfLocalDayIso produces an instant earlier than endOfLocalDayIso for the same date', () => {
    const start = new Date(startOfLocalDayIso('2026-07-01')).getTime();
    const end = new Date(endOfLocalDayIso('2026-07-01')).getTime();
    expect(start).toBeLessThan(end);
  });

  it('the local day span is approximately 24 hours (never shrinks to 21h/expands to 27h from a bad boundary)', () => {
    const start = new Date(startOfLocalDayIso('2026-07-01')).getTime();
    const end = new Date(endOfLocalDayIso('2026-07-01')).getTime();
    const hours = (end - start) / (1000 * 60 * 60);
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  it('consecutive days do not overlap and do not leave a gap', () => {
    const day1End = new Date(endOfLocalDayIso('2026-07-01')).getTime();
    const day2Start = new Date(startOfLocalDayIso('2026-07-02')).getTime();
    // day2Start must be just after day1End (within 1ms), never hours apart.
    expect(day2Start - day1End).toBeGreaterThan(0);
    expect(day2Start - day1End).toBeLessThan(2);
  });

  it('service source uses the local-day helpers for both gte and lte, not raw string concatenation with Z', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).toContain('startOfLocalDayIso(filters.dateFrom)');
    expect(fnBody).toContain('endOfLocalDayIso(filters.dateTo)');
    expect(fnBody).not.toMatch(/T00:00:00\.000Z/);
    expect(fnBody).not.toMatch(/T23:59:59\.999Z/);
  });
});

// ============================================================================
// 3. Search behavior — real functional tests of escapePostgrestIlikeValue
// ============================================================================

describe('escapePostgrestIlikeValue: safe PostgREST .or() interpolation', () => {
  it('wraps a plain term in double quotes with % wildcards preserved', () => {
    expect(escapePostgrestIlikeValue('Paracetamol')).toBe('"%Paracetamol%"');
  });

  it('does not corrupt the filter when the term contains a comma (the reported failure case)', () => {
    const out = escapePostgrestIlikeValue('Augmentin, Clavulanate');
    expect(out).toBe('"%Augmentin, Clavulanate%"');
    // The comma must be INSIDE the quoted value, not free to be parsed as an
    // OR-group separator by PostgREST.
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });

  it('does not corrupt the filter when the term contains parentheses', () => {
    const out = escapePostgrestIlikeValue('Augmentin (Amoxicillin)');
    expect(out).toBe('"%Augmentin (Amoxicillin)%"');
  });

  it('escapes an embedded double quote so it cannot terminate the quoted value early', () => {
    const out = escapePostgrestIlikeValue('5" tube');
    expect(out).toBe('"%5\\" tube%"');
  });

  it('escapes an embedded backslash so it cannot break the escaping itself', () => {
    const out = escapePostgrestIlikeValue('a\\b');
    expect(out).toBe('"%a\\\\b%"');
  });

  it('supports Arabic material names unchanged (no special ilike characters to escape)', () => {
    expect(escapePostgrestIlikeValue('باراسيتامول')).toBe('"%باراسيتامول%"');
  });

  it('service applies the escaper to both material and actor search branches', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).toContain('escapePostgrestIlikeValue(filters.materialSearch.trim())');
    expect(fnBody).toContain('escapePostgrestIlikeValue(filters.actorSearch.trim())');
  });

  it('material search still covers scientific_name/trade_name/concentration/dosage_form', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).toContain('scientific_name.ilike.${q}');
    expect(fnBody).toContain('trade_name.ilike.${q}');
    expect(fnBody).toContain('concentration.ilike.${q}');
    expect(fnBody).toContain('dosage_form.ilike.${q}');
  });

  it('actor search still covers actor_name_snapshot/actor_email_snapshot', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).toContain('actor_name_snapshot.ilike.${q}');
    expect(fnBody).toContain('actor_email_snapshot.ilike.${q}');
  });

  it('empty/whitespace-only search does not apply any .or() filter (empty search shows latest rows)', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).toMatch(/if \(filters\.materialSearch\?\.trim\(\)\) \{/);
    expect(fnBody).toMatch(/if \(filters\.actorSearch\?\.trim\(\)\) \{/);
    // '   '.trim() === '' is falsy, so the guard correctly skips whitespace-only input too.
    expect(''.trim()).toBeFalsy();
    expect('   '.trim()).toBeFalsy();
  });
});

// ============================================================================
// 4. Refresh behavior
// ============================================================================

describe('MovementReportSection: reload behavior', () => {
  it('the report re-queries whenever any filter or the active org changes (useAsync dependency array)', () => {
    const depsMatch = section.match(/\[canViewReport, activeOrgId, dateFrom, dateTo, movementType, pointId, materialSearch, actorSearch\]/);
    expect(depsMatch).not.toBeNull();
  });

  it('a missing activeOrgId short-circuits to an empty result instead of querying with undefined', () => {
    expect(section).toMatch(/\(canViewReport && activeOrgId\)\s*\n?\s*\?\s*getAvailabilityMovementsReport/);
  });

  it('an error state exposes reload() so the user (or a retry) can refresh', () => {
    expect(section).toContain('onRetry={report.reload}');
  });
});

// ============================================================================
// 5. Regression
// ============================================================================

describe('Regression: existing quantity-movement features remain intact', () => {
  it('MovementHistoryModal still reads by item_availability_id, unaffected by this fix', () => {
    expect(historyModal).toContain('getAvailabilityMovementsByItem');
    expect(historyModal).not.toContain('getAvailabilityMovementsReport');
  });

  it('AdjustQuantityModal still calls applyAvailabilityMovement, unaffected by this fix', () => {
    expect(adjustModal).toContain('applyAvailabilityMovement');
    expect(adjustModal).not.toContain('getAvailabilityMovementsReport');
  });

  it('the fixed report function performs no insert/update/delete', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('the fixed report function never calls supabase.rpc', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsReport');
    const fnBody = service.slice(fnStart, service.indexOf('\nexport async function getLowStockItems'));
    expect(fnBody).not.toContain('.rpc(');
  });

  it('no service_role or auth.admin was introduced', () => {
    expect(service).not.toContain('service_role');
    expect(service).not.toMatch(/auth\.admin/);
    expect(section).not.toContain('service_role');
    expect(section).not.toMatch(/auth\.admin/);
  });

  it('no Excel/XLSX library was introduced', () => {
    expect(service).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
    expect(section).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('no QR file or identifier is referenced', () => {
    expect(service).not.toMatch(/qr[_-]?token|QrToken|public.?qr|get_public_qr_payload/i);
    expect(section).not.toMatch(/qr[_-]?token|QrToken|public.?qr|get_public_qr_payload/i);
  });

  it('EditorScreen.tsx is untouched by this bugfix', () => {
    // E6: EditorScreen is retired — absence is stronger than 'does not contain'.
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('StatusCenterScreen still renders Adjust Quantity, Movement History, and the Report section', () => {
    expect(statusCenter).toContain('AdjustQuantityModal');
    expect(statusCenter).toContain('MovementHistoryModal');
    expect(statusCenter).toContain('MovementReportSection');
  });
});
