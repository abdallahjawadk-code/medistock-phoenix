/**
 * AVAILABILITY-QUANTITY-MOVEMENT-DB-A
 *
 * Verifies migration 033 (schema + permission-matrix foundation for
 * auditable quantity movements) exists, is manual-apply-only, and:
 *  - adds the 7 quantity-movement/movement-view permission keys and seeds
 *    role_permission_defaults per the approved matrix;
 *  - creates item_availability_movements as an immutable, SELECT-only,
 *    org-scoped + permission-gated ledger table (no INSERT/UPDATE/DELETE
 *    policy, no anon access);
 *  - does NOT create any RPC (phoenix_apply_availability_movement or
 *    otherwise) and does NOT modify phoenix_upsert_availability.
 *
 * Also guards that this DB-only phase did not touch EditorScreen,
 * StatusCenter, or any QR/public-QR file.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const migration033 = readPhoenix('supabase/migrations/033_phoenix_availability_movements_schema.sql');
const migration032 = readPhoenix('supabase/migrations/032_phoenix_availability_permission_matrix_integration.sql');

// ============================================================================
// Migration 033 exists and is manual-apply-only
// ============================================================================

describe('Migration 033 exists and is manual-apply-only', () => {
  it('file exists and is non-empty', () => {
    expect(migration033.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(migration033).toContain('MANUAL APPLY ONLY');
    expect(migration033).toContain('DO NOT use');
    expect(migration033).toContain('supabase db push');
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const noComments = migration033.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*(drop table|truncate)\b/im);
    expect(noComments).not.toMatch(/^\s*delete from\b/im);
  });

  it('does not reference service_role', () => {
    expect(migration033).not.toMatch(/service_role/i);
  });

  it('does not write to auth.users', () => {
    expect(migration033).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });
});

// ============================================================================
// Permission keys + role defaults seeded
// ============================================================================

describe('Migration 033 seeds the 7 quantity-movement permission keys', () => {
  it('inserts all 7 keys', () => {
    [
      "'availability.quantity.set'",
      "'availability.quantity.add'",
      "'availability.quantity.subtract'",
      "'availability.quantity.correct'",
      "'availability.movements.view'",
      "'availability.movements.export'",
      "'availability.movements.print'",
    ].forEach(key => expect(migration033).toContain(key));
    expect(migration033).toContain('INSERT INTO permission_keys');
  });

  it('is idempotent for the catalog insert (ON CONFLICT DO NOTHING)', () => {
    const block = migration033.slice(
      migration033.indexOf('INSERT INTO permission_keys'),
      migration033.indexOf('-- =', migration033.indexOf('INSERT INTO permission_keys')),
    );
    expect(block).toContain('ON CONFLICT (key) DO NOTHING');
  });
});

describe('Migration 033 seeds role_permission_defaults per the approved matrix', () => {
  const seedBlock = migration033.slice(
    migration033.indexOf('INSERT INTO role_permission_defaults'),
    migration033.indexOf('ON CONFLICT (role, permission_key) DO UPDATE'),
  );

  it('super_admin: all 7 keys true', () => {
    expect(seedBlock).toContain("('super_admin',             'availability.quantity.correct',  true)");
    expect(seedBlock).toContain("('super_admin',             'availability.movements.print',   true)");
  });

  it('institution_admin and hospital_admin: all 7 keys true', () => {
    expect(seedBlock).toContain("('institution_admin',       'availability.quantity.correct',  true)");
    expect(seedBlock).toContain("('hospital_admin',          'availability.quantity.correct',  true)");
  });

  it('warehouse_officer/warehouse_manager: correct = false, rest true', () => {
    expect(seedBlock).toContain("('warehouse_officer',       'availability.quantity.set',      true)");
    expect(seedBlock).toContain("('warehouse_officer',       'availability.quantity.correct',  false)");
    expect(seedBlock).toContain("('warehouse_manager',       'availability.quantity.correct',  false)");
  });

  it('port_officer/point_operator: only add/subtract/view true', () => {
    expect(seedBlock).toContain("('port_officer',            'availability.quantity.set',      false)");
    expect(seedBlock).toContain("('port_officer',            'availability.quantity.add',      true)");
    expect(seedBlock).toContain("('port_officer',            'availability.quantity.subtract', true)");
    expect(seedBlock).toContain("('port_officer',            'availability.quantity.correct',  false)");
    expect(seedBlock).toContain("('port_officer',            'availability.movements.view',    true)");
    expect(seedBlock).toContain("('port_officer',            'availability.movements.export',  false)");
    expect(seedBlock).toContain("('point_operator',          'availability.quantity.add',      true)");
  });

  it('monthly_status_officer/transfer_manager/viewer: view only', () => {
    expect(seedBlock).toContain("('monthly_status_officer',  'availability.movements.view',    true)");
    expect(seedBlock).toContain("('transfer_manager',        'availability.movements.view',    true)");
    expect(seedBlock).toContain("('viewer',                  'availability.movements.view',    true)");
    expect(seedBlock).toContain("('monthly_status_officer',  'availability.quantity.set',      false)");
    expect(seedBlock).toContain("('viewer',                  'availability.quantity.set',      false)");
  });
});

// ============================================================================
// Table design
// ============================================================================

describe('Migration 033 creates item_availability_movements correctly', () => {
  const tableBlock = migration033.slice(
    migration033.indexOf('CREATE TABLE IF NOT EXISTS public.item_availability_movements'),
    migration033.indexOf('COMMENT ON TABLE public.item_availability_movements'),
  );

  it('creates the table with the recommended columns', () => {
    [
      'item_availability_id', 'organization_id', 'distribution_point_id',
      'scientific_name', 'concentration', 'dosage_form', 'trade_name',
      'movement_type', 'quantity_before', 'quantity_delta', 'quantity_after',
      'reason', 'notes', 'created_by', 'actor_name_snapshot',
      'actor_email_snapshot', 'actor_role_snapshot', 'created_at',
    ].forEach(col => expect(tableBlock).toContain(col));
  });

  it('movement_type check constraint has exactly the 4 modes', () => {
    expect(tableBlock).toContain("CHECK (movement_type IN ('set_exact', 'add', 'subtract', 'correction'))");
  });

  it('quantity_before and quantity_after have non-negative checks', () => {
    expect(tableBlock).toContain('CHECK (quantity_before >= 0)');
    expect(tableBlock).toContain('CHECK (quantity_after >= 0)');
  });

  it('correction requires a non-empty reason at the table level', () => {
    expect(tableBlock).toMatch(/CHECK \(movement_type <> 'correction' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)\)/);
  });

  it('does not require reason for add/subtract/set_exact at the table level', () => {
    // Only one CHECK constraint references reason, and it is scoped to correction only.
    const reasonChecks = (tableBlock.match(/CHECK\s*\([^)]*reason[^)]*\)/gi) ?? []).length
      + (tableBlock.match(/CHECK\s*\(movement_type <> 'correction'[^;]*?\)\)/gi) ?? []).length;
    expect(reasonChecks).toBeGreaterThan(0);
    expect(tableBlock).not.toMatch(/reason\s+text\s+not\s+null/i);
  });

  it('references item_availability, organizations, distribution_points with ON DELETE RESTRICT', () => {
    expect(tableBlock).toContain('REFERENCES public.item_availability(id) ON DELETE RESTRICT');
    expect(tableBlock).toContain('REFERENCES public.organizations(id) ON DELETE RESTRICT');
    expect(tableBlock).toContain('REFERENCES public.distribution_points(id) ON DELETE RESTRICT');
  });
});

describe('Migration 033 indexes', () => {
  it('creates all recommended indexes', () => {
    expect(migration033).toContain('item_avail_mvmt_org_idx');
    expect(migration033).toContain('item_avail_mvmt_item_idx');
    expect(migration033).toContain('item_avail_mvmt_point_idx');
    expect(migration033).toContain('item_avail_mvmt_created_idx');
    expect(migration033).toContain('item_avail_mvmt_org_created_idx');
  });
});

// ============================================================================
// RLS / security: SELECT-only, no direct writes, no anon
// ============================================================================

describe('Migration 033 RLS: SELECT-only, immutable, no anon writes', () => {
  it('enables RLS on the table', () => {
    expect(migration033).toContain('ALTER TABLE public.item_availability_movements ENABLE ROW LEVEL SECURITY');
  });

  it('creates a SELECT policy gated by availability.movements.view + org scope (or super_admin)', () => {
    expect(migration033).toContain('CREATE POLICY "avail_mvmt_select_perm"');
    expect(migration033).toContain('FOR SELECT TO authenticated');
    expect(migration033).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.movements.view')");
    expect(migration033).toContain("phoenix_my_role() = 'super_admin'");
    expect(migration033).toContain('organization_id = phoenix_my_org()');
  });

  it('does not create any INSERT policy', () => {
    expect(migration033).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+(public\.)?item_availability_movements\s+FOR\s+INSERT/i);
  });

  it('does not create any UPDATE policy', () => {
    expect(migration033).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+(public\.)?item_availability_movements\s+FOR\s+UPDATE/i);
  });

  it('does not create any DELETE policy', () => {
    expect(migration033).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+(public\.)?item_availability_movements\s+FOR\s+DELETE/i);
  });

  it('does not grant INSERT/UPDATE/DELETE to authenticated or anon', () => {
    expect(migration033).not.toMatch(/GRANT\s+.*INSERT.*ON\s+TABLE\s+public\.item_availability_movements/i);
    expect(migration033).not.toMatch(/GRANT\s+.*UPDATE.*ON\s+TABLE\s+public\.item_availability_movements/i);
    expect(migration033).not.toMatch(/GRANT\s+.*DELETE.*ON\s+TABLE\s+public\.item_availability_movements/i);
    expect(migration033).not.toMatch(/GRANT\s+.*ON\s+TABLE\s+public\.item_availability_movements\s+TO\s+anon/i);
  });

  it('revokes from PUBLIC and anon, grants SELECT only to authenticated', () => {
    expect(migration033).toContain('REVOKE ALL ON TABLE public.item_availability_movements FROM PUBLIC, anon');
    expect(migration033).toContain('GRANT SELECT ON TABLE public.item_availability_movements TO authenticated');
  });

  it('documents immutability and that only a future RPC may insert rows', () => {
    expect(migration033).toMatch(/immutable/i);
    expect(migration033).toMatch(/future SECURITY DEFINER RPC/i);
  });

  it('documents the assigned-distribution-point scope gap consistent with migration 032', () => {
    expect(migration033).toMatch(/no assigned[\s-]?(distribution[\s-]?point|_point)/i);
    expect(migration033).toContain('migration 032');
  });
});

// ============================================================================
// Verification block
// ============================================================================

describe('Migration 033 verification block', () => {
  it('asserts the table exists', () => {
    expect(migration033).toContain('item_availability_movements table not found');
  });

  it('asserts the 7 permission keys exist', () => {
    expect(migration033).toContain('expected 7 new permission keys');
  });

  it('asserts RLS is enabled', () => {
    expect(migration033).toContain('RLS is not enabled on item_availability_movements');
  });

  it('asserts no INSERT/UPDATE/DELETE policy exists', () => {
    expect(migration033).toContain("cmd IN ('INSERT', 'UPDATE', 'DELETE')");
    expect(migration033).toContain('expected 0 INSERT/UPDATE/DELETE policies');
  });

  it('asserts exactly 1 policy total (SELECT only)', () => {
    expect(migration033).toContain('expected exactly 1 policy (SELECT only)');
  });
});

// ============================================================================
// No RPC created, phoenix_upsert_availability untouched
// ============================================================================

describe('Migration 033 does not create any RPC and does not touch phoenix_upsert_availability', () => {
  it('does not create phoenix_apply_availability_movement', () => {
    expect(migration033).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_apply_availability_movement/i);
  });

  it('does not create or replace any function at all', () => {
    expect(migration033).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it('mentions phoenix_upsert_availability only in explanatory comments, never in executable SQL', () => {
    // The header prose explains context ("Today, phoenix_upsert_availability
    // overwrites...", "Does NOT modify phoenix_upsert_availability") — that is
    // documentation, not a functional touch. Assert no CREATE/ALTER/DROP
    // statement targets it.
    expect(migration033).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_upsert_availability/i);
    expect(migration033).not.toMatch(/ALTER\s+FUNCTION\s+.*phoenix_upsert_availability/i);
    expect(migration033).not.toMatch(/DROP\s+FUNCTION\s+.*phoenix_upsert_availability/i);
  });

  it('migration 032 (phoenix_upsert_availability) is unaffected by migration 033', () => {
    expect(migration032).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
    expect(migration032).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
  });
});

// ============================================================================
// Guard: EditorScreen, StatusCenter, QR/public-QR untouched by this DB-only phase
// ============================================================================

describe('EditorScreen, StatusCenter, and QR/public-QR are untouched by this phase', () => {
  it('EditorScreen.tsx still gates save on availability.create/update, not quantity-movement keys', () => {
    const editorScreen = readSrc('features/editor/EditorScreen.tsx');
    expect(editorScreen).toContain("myPermissions.has('availability.create')");
    expect(editorScreen).toContain("myPermissions.has('availability.update')");
    expect(editorScreen).not.toContain('availability.quantity.');
    expect(editorScreen).not.toContain('availability.movements.');
    expect(editorScreen).not.toContain('phoenix_apply_availability_movement');
  });

  it('StatusCenterScreen.tsx has no quantity-movement UI wiring yet', () => {
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    expect(statusCenter).not.toContain('availability.quantity.');
    expect(statusCenter).not.toContain('availability.movements.');
    expect(statusCenter).not.toContain('phoenix_apply_availability_movement');
    expect(statusCenter).not.toContain('item_availability_movements');
  });

  it('migration 033 does not modify get_public_qr_payload or any QR table', () => {
    // The header prose mentions get_public_qr_payload/qr_tokens/qr_targets only
    // in a "what this does NOT do" list — assert no CREATE/ALTER/DROP/policy
    // statement actually targets them.
    expect(migration033).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.get_public_qr_payload/i);
    expect(migration033).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+(public\.)?qr_(tokens|targets)/i);
    expect(migration033).not.toMatch(/ALTER\s+TABLE\s+(public\.)?qr_(tokens|targets)/i);
  });

  it('qr.service.ts is unaffected (still exposes getPublicQrPayload calling get_public_qr_payload)', () => {
    const qrService = readSrc('shared/supabase/services/qr.service.ts');
    expect(qrService).toContain('export async function getPublicQrPayload');
    expect(qrService).toContain("supabase.rpc('get_public_qr_payload'");
  });
});
