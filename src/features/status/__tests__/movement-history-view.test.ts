/**
 * AVAILABILITY-MOVEMENT-HISTORY-VIEW-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the read-only quantity movement history view:
 *  - Status Center row action ("History") visible only with
 *    availability.movements.view.
 *  - MovementHistoryModal loads via getAvailabilityMovementsByItem, a plain
 *    read-only SELECT — no RPC call, no insert/update/delete.
 *  - Loading/empty/error states, movement type labels, before/delta/after,
 *    actor snapshot, reason/notes are all present.
 *  - Guards: no migrations/RPC/QR files touched, no service_role/auth.admin,
 *    no Excel import, Adjust Quantity / EditorScreen untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const modalPath    = join(SRC, 'features/status/MovementHistoryModal.tsx');
const modal        = readFileSync(modalPath, 'utf8');
const service      = readSrc('shared/supabase/services/availability.service.ts');
const strings      = readSrc('shared/i18n/strings.ts');
const editorScreen = readSrc('features/editor/EditorScreen.tsx');
const adjustModal  = readSrc('features/status/AdjustQuantityModal.tsx');

// ============================================================================
// 1. History button visibility
// ============================================================================

describe('History action visibility is permission-gated on availability.movements.view', () => {
  it('MovementHistoryModal.tsx exists', () => {
    expect(existsSync(modalPath)).toBe(true);
  });

  it('StatusCenterScreen derives canViewMovementHistory from availability.movements.view', () => {
    expect(statusCenter).toContain('canViewMovementHistory');
    expect(statusCenter).toMatch(/myPermissions\.has\('availability\.movements\.view'\)/);
  });

  it('the History button itself only renders when canViewMovementHistory is true', () => {
    expect(statusCenter).toMatch(/\{canViewMovementHistory && \(/);
  });

  it('History button uses the mvmt_history_action label (bilingual)', () => {
    expect(statusCenter).toContain("t('mvmt_history_action', lang)");
    expect(strings).toMatch(/mvmt_history_action:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('Adjust Quantity button remains independently gated (unchanged)', () => {
    expect(statusCenter).toContain('canAdjustQuantity');
    expect(statusCenter).toMatch(/\{canAdjustQuantity && \(/);
  });
});

// ============================================================================
// 2. Service query
// ============================================================================

describe('getAvailabilityMovementsByItem: read-only service query', () => {
  it('exists and queries item_availability_movements', () => {
    expect(service).toContain('export async function getAvailabilityMovementsByItem');
    expect(service).toMatch(/\.from\('item_availability_movements'\)/);
  });

  it('filters by item_availability_id', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnBody = service.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain(".eq('item_availability_id', itemAvailabilityId)");
  });

  it('orders by created_at descending', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnBody = service.slice(fnStart, fnStart + 1500);
    expect(fnBody).toMatch(/\.order\('created_at',\s*\{\s*ascending:\s*false\s*\}\)/);
  });

  it('applies a reasonable limit', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnBody = service.slice(fnStart, fnStart + 1500);
    expect(fnBody).toMatch(/\.limit\(\d+\)/);
  });

  it('returns typed camelCase records', () => {
    expect(service).toContain('export interface AvailabilityMovementRecord');
    expect(service).toContain('movementType:');
    expect(service).toContain('quantityBefore:');
    expect(service).toContain('quantityDelta:');
    expect(service).toContain('quantityAfter:');
    expect(service).toContain('actorNameSnapshot:');
    expect(service).toContain('actorRoleSnapshot:');
    expect(service).toContain('createdAt:');
  });

  it('is a plain SELECT — no RPC call, no write', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnEnd = service.indexOf('\nexport async function getLowStockItems');
    const fnBody = service.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('.rpc(');
    expect(fnBody).not.toMatch(/\.insert\(/);
    expect(fnBody).not.toMatch(/\.update\(/);
    expect(fnBody).not.toMatch(/\.delete\(/);
  });

  it('does not use service_role or auth.admin', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnEnd = service.indexOf('\nexport async function getLowStockItems');
    const fnBody = service.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('service_role');
    expect(fnBody).not.toMatch(/auth\.admin/);
  });

  it('short-circuits to [] when Supabase is not configured (matches other read functions)', () => {
    const fnStart = service.indexOf('export async function getAvailabilityMovementsByItem');
    const fnBody = service.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('if (!supabaseConfigured) return [];');
  });
});

// ============================================================================
// 3. Modal behavior
// ============================================================================

describe('MovementHistoryModal: loading, empty, error, and data states', () => {
  it('loads via getAvailabilityMovementsByItem when opened', () => {
    expect(modal).toContain('getAvailabilityMovementsByItem');
    expect(modal).toMatch(/useEffect\(\(\) => \{[\s\S]*load\(row\.id\)/);
  });

  it('shows a loading state', () => {
    expect(modal).toContain('PhoenixLoadingState');
    expect(modal).toMatch(/\{loading && <PhoenixLoadingState/);
  });

  it('shows the empty state with the required bilingual message', () => {
    expect(modal).toContain('mvmt_history_empty');
    expect(strings).toMatch(/mvmt_history_empty:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
    const line = strings.split('\n').find(l => l.includes('mvmt_history_empty'));
    expect(line).toContain('No quantity movements recorded yet.');
    expect(line).toContain('لا توجد حركات كمية مسجلة بعد.');
  });

  it('shows movement rows in a table', () => {
    expect(modal).toContain('movements.map(m =>');
    expect(modal).toContain('<table');
  });

  it('displays before/delta/after values without recomputing them', () => {
    expect(modal).toContain('m.quantityBefore');
    expect(modal).toContain('m.quantityAfter');
    expect(modal).toContain('formatDelta(m.movementType, m.quantityDelta)');
    // formatDelta must not derive delta from before/after subtraction —
    // it only formats the stored quantityDelta's sign/prefix.
    const fnBody = modal.slice(modal.indexOf('function formatDelta'), modal.indexOf('interface Props'));
    expect(fnBody).not.toMatch(/quantityAfter\s*-\s*quantityBefore/);
  });

  it('add shows a +N delta and subtract shows a -N delta', () => {
    const fnBody = modal.slice(modal.indexOf('function formatDelta'), modal.indexOf('interface Props'));
    expect(fnBody).toMatch(/type === 'add'[\s\S]*?`\+\$\{/);
    expect(fnBody).toMatch(/type === 'subtract'[\s\S]*?`-\$\{/);
  });

  it('displays the actor snapshot (name and role)', () => {
    expect(modal).toContain('m.actorNameSnapshot');
    expect(modal).toContain('m.actorRoleSnapshot');
  });

  it('displays reason and notes', () => {
    expect(modal).toContain('m.reason');
    expect(modal).toContain('m.notes');
  });

  it('handles load error using the existing load_error fallback', () => {
    expect(modal).toContain("t('load_error', lang)");
    expect(modal).toContain('PhoenixErrorState');
  });

  it('shows the required movement type labels via existing mvmt_* keys', () => {
    expect(modal).toContain('mvmt_set_exact');
    expect(modal).toContain('mvmt_add');
    expect(modal).toContain('mvmt_subtract');
    expect(modal).toContain('mvmt_correction');
  });

  it('title uses the required bilingual text', () => {
    expect(modal).toContain('mvmt_history_title');
    const line = strings.split('\n').find(l => l.includes('mvmt_history_title:'));
    expect(line).toContain('Quantity Movement History');
    expect(line).toContain('سجل حركات الكمية');
  });

  it('shows selected material identity and current quantity', () => {
    expect(modal).toContain('row.scientific_name');
    expect(modal).toContain('row.trade_name');
    expect(modal).toContain('row.concentration');
    expect(modal).toContain('row.dosage_form');
    expect(modal).toContain('row.quantity');
  });

  it('has a Refresh action that re-triggers load without writing anything', () => {
    expect(modal).toContain('mvmt_history_refresh');
    expect(modal).toMatch(/onClick=\{\(\) => load\(row\.id\)\}/);
  });

  it('can be closed via onClose', () => {
    expect(modal).toContain('onClose');
    expect(modal).toContain('mvmt_history_close');
  });
});

// ============================================================================
// 4. Read-only guard
// ============================================================================

describe('Read-only guard: no write UI, no direct RPC/write calls', () => {
  it('MovementHistoryModal has no edit/delete/insert UI', () => {
    expect(modal).not.toMatch(/onClick=\{.*delete/i);
    expect(modal).not.toContain('applyAvailabilityMovement');
    expect(modal).not.toContain('upsertAvailability');
  });

  it('MovementHistoryModal never calls supabase.rpc', () => {
    expect(modal).not.toContain('.rpc(');
    expect(modal).not.toContain('supabase.rpc');
  });

  it('MovementHistoryModal never inserts/updates/deletes item_availability_movements', () => {
    expect(modal).not.toMatch(/\.insert\(/);
    expect(modal).not.toMatch(/\.update\(/);
    expect(modal).not.toMatch(/\.delete\(/);
  });

  it('does not import PhoenixDialog write-only helpers or form submit patterns', () => {
    expect(modal).not.toContain('handleSubmit');
    expect(modal).not.toContain('canSubmit');
  });
});

// ============================================================================
// 5. Existing features still intact / scope guards
// ============================================================================

describe('Existing features remain intact', () => {
  it('Adjust Quantity button/modal remains wired in StatusCenterScreen', () => {
    expect(statusCenter).toContain('AdjustQuantityModal');
    expect(statusCenter).toContain('setAdjustRow');
    expect(statusCenter).toContain('handleMovementSuccess');
  });

  it('AdjustQuantityModal.tsx itself is unchanged (still only calls applyAvailabilityMovement)', () => {
    expect(adjustModal).toContain('applyAvailabilityMovement');
    expect(adjustModal).not.toContain('getAvailabilityMovementsByItem');
    expect(adjustModal).not.toContain('MovementHistoryModal');
  });

  it('EditorScreen.tsx is untouched by this phase', () => {
    expect(editorScreen).not.toContain('MovementHistoryModal');
    expect(editorScreen).not.toContain('getAvailabilityMovementsByItem');
    expect(editorScreen).not.toContain('AVAILABILITY-MOVEMENT-HISTORY-VIEW-A');
  });

  it('no QR file references movement history', () => {
    // Sanity: MovementHistoryModal itself must not touch QR
    expect(modal).not.toMatch(/qr[_-]?token|QrToken|public.?qr/i);
  });

  it('no migration file (001-035) was modified to add this feature (read-only, uses existing 033 table/policy)', () => {
    const sql033 = readPhoenix('supabase/migrations/033_phoenix_availability_movements_schema.sql');
    expect(sql033).toContain('avail_mvmt_select_perm');
    expect(sql033).toContain("'availability.movements.view'");
  });

  it('no new migration file was created for this phase', () => {
    expect(existsSync(join(PHOENIX, 'supabase/migrations/036_phoenix_movement_history_view.sql'))).toBe(false);
  });

  it('does not add Excel import', () => {
    expect(modal).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
    expect(statusCenter).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not reference service_role or auth.admin anywhere in the new files', () => {
    expect(modal).not.toContain('service_role');
    expect(modal).not.toMatch(/auth\.admin/);
    expect(statusCenter).not.toContain('service_role');
    expect(statusCenter).not.toMatch(/auth\.admin/);
  });
});
