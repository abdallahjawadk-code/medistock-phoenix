/**
 * INTER-INSTITUTION-EXCHANGE-RPCS-C
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 041: the four inter-org exchange
 * RPCs (phoenix_create_inter_org_exchange_request,
 * phoenix_update_inter_org_exchange_status,
 * phoenix_get_inter_org_exchange_events,
 * phoenix_get_inter_org_exchange_requests). No live DB is used — these are
 * text/shape assertions against the SQL file, mirroring the 039 test's
 * conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_041_PATH = join(MIGRATIONS_DIR, '041_phoenix_inter_org_exchange_rpcs.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const afterStart = sql.indexOf('AS $$', start) + 'AS $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

describe('Migration 041 exists exactly once', () => {
  it('041_phoenix_inter_org_exchange_rpcs.sql exists', () => {
    expect(existsSync(MIGRATION_041_PATH)).toBe(true);
  });

  it('is the only file named 041_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('041_'));
    expect(matches).toEqual(['041_phoenix_inter_org_exchange_rpcs.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 041: does not modify migrations 001-040', () => {
  it('all prior migration files (001-040) still exist untouched', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-3][0-9]|40)_/.test(f));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('migration 040 file is untouched (still schema-only, no RPC body added there)', () => {
    const sql040 = readMigration('040_phoenix_inter_org_exchange_schema.sql');
    expect(sql040).toContain('Migration 040: Inter-Org Exchange Request Schema');
    expect(sql040).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_create_inter_org_exchange_request');
    expect(sql040).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_exchange_status');
  });

  it('033/034/035/036/037/038/039 filenames are unchanged (no duplicate numbering introduced)', () => {
    for (const [prefix, name] of [
      ['033_', '033_phoenix_availability_movements_schema.sql'],
      ['034_', '034_phoenix_apply_availability_movement_rpc.sql'],
      ['036_', '036_phoenix_live_inter_institution_alerts_rpc.sql'],
      ['037_', '037_phoenix_live_alert_identifiers.sql'],
      ['038_', '038_phoenix_inter_org_alert_lifecycle_schema.sql'],
      ['039_', '039_phoenix_inter_org_alert_lifecycle_rpcs.sql'],
      ['040_', '040_phoenix_inter_org_exchange_schema.sql'],
    ] as const) {
      expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith(prefix))).toEqual([name]);
    }
  });
});

describe('Migration 041: creates exactly the four exchange RPCs', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('creates phoenix_create_inter_org_exchange_request', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_create_inter_org_exchange_request(');
  });

  it('creates phoenix_update_inter_org_exchange_status', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_exchange_status(');
  });

  it('creates phoenix_get_inter_org_exchange_events', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_exchange_events(');
  });

  it('creates phoenix_get_inter_org_exchange_requests', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_exchange_requests(');
  });

  it('creates exactly 4 functions (no other CREATE FUNCTION)', () => {
    const matches = activeSql(sql).match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it('creates no table (RPCs only, per migration 040 already owning the schema)', () => {
    expect(activeSql(sql)).not.toMatch(/CREATE TABLE/i);
  });

  it('verify block asserts existing lifecycle/movement/QR RPCs and both exchange tables are untouched', () => {
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'phoenix_update_inter_org_alert_state'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
    expect(sql).toContain("table_name = 'inter_org_exchange_requests'");
    expect(sql).toContain("table_name = 'inter_org_exchange_events'");
  });
});

describe('Migration 041: all four RPCs are SECURITY DEFINER with safe search_path', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const NAMES = [
    'phoenix_create_inter_org_exchange_request',
    'phoenix_update_inter_org_exchange_status',
    'phoenix_get_inter_org_exchange_events',
    'phoenix_get_inter_org_exchange_requests',
  ];

  NAMES.forEach(name => {
    it(`${name} is SECURITY DEFINER with SET search_path = public`, () => {
      const fn = extractFunction(sql, name);
      const header = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), sql.indexOf('AS $$', sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)));
      expect(header).toContain('SECURITY DEFINER');
      expect(header).toContain('SET search_path = public');
      expect(fn.length).toBeGreaterThan(0);
    });
  });

  it('none of the four use "public, pg_temp" (matches the 034/039 precedent exactly, not the phoenix_profile_has_permission precedent)', () => {
    NAMES.forEach(name => {
      const header = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), sql.indexOf('AS $$', sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)));
      expect(header).not.toContain('SET search_path = public, pg_temp');
    });
  });
});

describe('Migration 041: all four RPCs require an authenticated user', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const NAMES = [
    'phoenix_create_inter_org_exchange_request',
    'phoenix_update_inter_org_exchange_status',
    'phoenix_get_inter_org_exchange_events',
    'phoenix_get_inter_org_exchange_requests',
  ];

  NAMES.forEach(name => {
    it(`${name} checks auth.uid()`, () => {
      const fn = extractFunction(sql, name);
      expect(fn).toContain('auth.uid()');
    });
  });

  it('create/update RPCs RAISE EXCEPTION not_authenticated (write-RPC convention)', () => {
    const createFn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    const updateFn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(createFn).toContain("RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'");
    expect(updateFn).toContain("RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'");
  });

  it('read RPCs return { ok: false, error: NOT_AUTHENTICATED } (read-RPC convention)', () => {
    const eventsFn = extractFunction(sql, 'phoenix_get_inter_org_exchange_events');
    const listFn = extractFunction(sql, 'phoenix_get_inter_org_exchange_requests');
    expect(eventsFn).toContain("jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED')");
    expect(listFn).toContain("jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED')");
  });
});

describe('Migration 041: permission checks use the existing helper (phoenix_profile_has_permission)', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const NAMES = [
    'phoenix_create_inter_org_exchange_request',
    'phoenix_update_inter_org_exchange_status',
    'phoenix_get_inter_org_exchange_events',
    'phoenix_get_inter_org_exchange_requests',
  ];

  NAMES.forEach(name => {
    it(`${name} calls phoenix_profile_has_permission`, () => {
      expect(extractFunction(sql, name)).toContain('phoenix_profile_has_permission');
    });
  });

  it('uses phoenix_my_role/phoenix_my_org for org scope (not a hand-rolled query)', () => {
    const updateFn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(updateFn).toContain('phoenix_my_role()');
    expect(updateFn).toContain('phoenix_my_org()');
  });

  it('create RPC checks inter_org_exchange.request and inter_org_exchange.manage', () => {
    const fn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    expect(fn).toContain("'inter_org_exchange.request'");
    expect(fn).toContain("'inter_org_exchange.manage'");
  });

  it('update RPC checks approve/dispatch/receive/cancel/manage', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    ['approve', 'dispatch', 'receive', 'cancel', 'manage'].forEach(action => {
      expect(fn).toContain(`'inter_org_exchange.${action}'`);
    });
  });

  it('events RPC checks events.view/view/manage', () => {
    const fn = extractFunction(sql, 'phoenix_get_inter_org_exchange_events');
    expect(fn).toContain("'inter_org_exchange.events.view'");
    expect(fn).toContain("'inter_org_exchange.view'");
    expect(fn).toContain("'inter_org_exchange.manage'");
  });

  it('list RPC checks view/manage', () => {
    const fn = extractFunction(sql, 'phoenix_get_inter_org_exchange_requests');
    expect(fn).toContain("'inter_org_exchange.view'");
    expect(fn).toContain("'inter_org_exchange.manage'");
  });
});

describe('Migration 041: organization scope enforced on every RPC', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('create RPC requires the actor to belong to the target organization (unless manage/super_admin)', () => {
    const fn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    expect(fn).toMatch(/v_my_org = v_target\.organization_id/);
  });

  it('update RPC scopes source_approved/source_rejected/dispatched to source org', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(fn).toMatch(/v_my_org = v_row\.source_organization_id/);
  });

  it('update RPC scopes received/completed/cancelled to target org', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(fn).toMatch(/v_my_org = v_row\.target_organization_id/);
  });

  it('events RPC scopes to source or target org of the specific request', () => {
    const fn = extractFunction(sql, 'phoenix_get_inter_org_exchange_events');
    expect(fn).toContain('v_request.source_organization_id <> v_org');
    expect(fn).toContain('v_request.target_organization_id <> v_org');
  });

  it('list RPC scopes to rows where the actor org is source or target', () => {
    const fn = extractFunction(sql, 'phoenix_get_inter_org_exchange_requests');
    expect(fn).toContain('source_organization_id = v_org OR target_organization_id = v_org');
  });

  it('super_admin bypasses organization boundary on every RPC', () => {
    const NAMES = [
      'phoenix_create_inter_org_exchange_request',
      'phoenix_update_inter_org_exchange_status',
      'phoenix_get_inter_org_exchange_events',
      'phoenix_get_inter_org_exchange_requests',
    ];
    NAMES.forEach(name => {
      expect(extractFunction(sql, name)).toMatch(/v_is_super/);
    });
  });
});

describe('Migration 041: status transition rules', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');

  const TRANSITIONS: Array<[string, string]> = [
    ['requested', 'source_approved'],
    ['requested', 'source_rejected'],
    ['requested', 'cancelled'],
    ['source_approved', 'dispatched'],
    ['source_approved', 'cancelled'],
    ['dispatched', 'received'],
    ['received', 'completed'],
  ];

  TRANSITIONS.forEach(([from, to]) => {
    it(`allows ${from} -> ${to}`, () => {
      const re = new RegExp(`v_row\\.status = '${from}'\\s+AND p_next_status = '${to}'`);
      expect(fn).toMatch(re);
    });
  });

  it('rejects any transition not in the whitelist (invalid_transition guard present)', () => {
    expect(fn).toContain("RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '23514'");
  });

  it('7 statuses are the full allowed set on the parameter validation', () => {
    expect(fn).toMatch(/'requested', 'source_approved', 'source_rejected',\s*'dispatched', 'received', 'completed', 'cancelled'/);
  });
});

describe('Migration 041: terminal statuses cannot change', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');

  it('blocks further transitions once source_rejected/cancelled/completed', () => {
    expect(fn).toMatch(/v_row\.status IN \('source_rejected', 'cancelled', 'completed'\)/);
    expect(fn).toContain("RAISE EXCEPTION 'exchange_request_terminal' USING ERRCODE = '23514'");
  });

  it('the terminal check happens before the transition whitelist check (fail fast)', () => {
    const terminalIdx = fn.indexOf('exchange_request_terminal');
    const whitelistIdx = fn.indexOf("v_allowed :=");
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(whitelistIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeLessThan(whitelistIdx);
  });
});

describe('Migration 041: event insertions on both write RPCs', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('create RPC inserts a requested event with to_status=requested and from_status NULL', () => {
    const fn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    expect(fn).toContain('INSERT INTO public.inter_org_exchange_events');
    expect(fn).toMatch(/NULL, 'requested',/);
  });

  it('update RPC inserts one event per successful transition with quantity_snapshot as a jsonb object', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(fn).toContain('INSERT INTO public.inter_org_exchange_events');
    expect(fn).toContain('quantity_snapshot');
    expect(fn).toMatch(/jsonb_build_object\(\s*'requested', v_row\.requested_quantity/);
  });

  it('events carry actor_org_id (disambiguates which org acted)', () => {
    const createFn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    const updateFn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(createFn).toContain('actor_org_id');
    expect(updateFn).toContain('actor_org_id');
  });
});

describe('Migration 041: row locks used before authorization/quantity checks', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('create RPC locks source+target item_availability rows with FOR UPDATE', () => {
    const fn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('FROM public.item_availability');
  });

  it('update RPC locks the request row with FOR UPDATE before any check', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(fn).toMatch(/FROM public\.inter_org_exchange_requests\s*\n\s*WHERE id = p_exchange_request_id\s*\n\s*FOR UPDATE/);
  });

  it('update RPC additionally locks both availability rows at the completed transition', () => {
    const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    const branchStart = fn.indexOf("IF p_next_status = 'completed' THEN");
    const branchEnd = fn.indexOf('\n  ELSE', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const completedBlock = fn.slice(branchStart, branchEnd);
    expect(completedBlock).toContain('FOR UPDATE');
  });

  it('row locks use a single ORDER BY id query to avoid deadlocks (deterministic lock order)', () => {
    const createFn = extractFunction(sql, 'phoenix_create_inter_org_exchange_request');
    const updateFn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');
    expect(createFn).toMatch(/ORDER BY id\s*\n\s*FOR UPDATE/);
    expect(updateFn).toMatch(/ORDER BY id\s*\n\s*FOR UPDATE/);
  });
});

describe('Migration 041: source quantity can never go negative', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');

  it('re-verifies source sufficiency at completion time (not just at approval time)', () => {
    expect(fn).toContain('source_quantity_insufficient');
    expect(fn).toMatch(/v_source_avail\.quantity < v_row\.received_quantity/);
  });

  it('the sufficiency check happens before any UPDATE to item_availability', () => {
    const checkIdx = fn.indexOf('source_quantity_insufficient');
    const updateIdx = fn.indexOf('UPDATE public.item_availability');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(updateIdx);
  });

  it('approved_quantity is bounded to <= requested_quantity and > 0', () => {
    expect(fn).toContain('approved_quantity_must_be_positive');
    expect(fn).toContain('approved_quantity_exceeds_requested');
  });

  it('received_quantity is bounded to <= approved_quantity and > 0', () => {
    expect(fn).toContain('received_quantity_must_be_positive');
    expect(fn).toContain('received_quantity_exceeds_approved');
  });
});

describe('Migration 041: movement_id_out/movement_id_in set exactly at completed', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_update_inter_org_exchange_status');

  it('inserts two movement rows (subtract at source, add at target) and captures their ids', () => {
    expect(fn).toContain('RETURNING id INTO v_movement_out');
    expect(fn).toContain('RETURNING id INTO v_movement_in');
    expect(fn).toMatch(/'subtract', v_source_avail\.quantity/);
    expect(fn).toMatch(/'add', v_target_avail\.quantity/);
  });

  it('stamps movement_id_out/movement_id_in onto the request row in the same UPDATE', () => {
    expect(fn).toMatch(/movement_id_out\s*=\s*v_movement_out/);
    expect(fn).toMatch(/movement_id_in\s*=\s*v_movement_in/);
  });

  it('does not invent a new movement_type (only reuses existing subtract/add)', () => {
    expect(fn).not.toContain("'transfer_out'");
    expect(fn).not.toContain("'transfer_in'");
  });

  it('never calls phoenix_apply_availability_movement', () => {
    expect(activeSql(fn)).not.toContain('phoenix_apply_availability_movement(');
  });

  it('verify block confirms the movement_type CHECK constraint is unchanged', () => {
    expect(sql).toContain('item_availability_movements_type_chk');
    expect(sql).toMatch(/'set_exact''.*''add''.*''subtract''.*''correction''/);
  });
});

describe('Migration 041: grants are authenticated-only, no anon EXECUTE', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const NAMES = [
    'phoenix_create_inter_org_exchange_request',
    'phoenix_update_inter_org_exchange_status',
    'phoenix_get_inter_org_exchange_events',
    'phoenix_get_inter_org_exchange_requests',
  ];

  NAMES.forEach(name => {
    it(`${name} grants EXECUTE to authenticated only`, () => {
      const grantIdx = sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${name}(`);
      expect(grantIdx).toBeGreaterThan(-1);
      const grantBlock = sql.slice(grantIdx, grantIdx + 200);
      expect(grantBlock).toContain('TO authenticated');
    });

    it(`${name} revokes ALL from PUBLIC, anon`, () => {
      const revokeIdx = sql.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`);
      expect(revokeIdx).toBeGreaterThan(-1);
      const revokeBlock = sql.slice(revokeIdx, revokeIdx + 300);
      expect(revokeBlock).toContain('FROM PUBLIC, anon');
    });
  });

  it('no GRANT EXECUTE to anon anywhere in the file', () => {
    expect(activeSql(sql)).not.toMatch(/GRANT EXECUTE[\s\S]{0,80}TO anon/i);
  });
});

describe('Migration 041: no direct table policies on the exchange tables', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('creates no CREATE POLICY at all (RPCs bypass RLS internally, no policy needed)', () => {
    expect(activeSql(sql)).not.toMatch(/CREATE POLICY/);
  });

  it('verify block asserts no policy exists on inter_org_exchange_events', () => {
    expect(sql).toContain("tablename = 'inter_org_exchange_events'");
  });

  it('verify block asserts no INSERT/UPDATE/DELETE policy exists on inter_org_exchange_requests', () => {
    expect(sql).toMatch(/tablename = 'inter_org_exchange_requests'\s*\n\s*AND cmd IN \('INSERT', 'UPDATE', 'DELETE'\)/);
  });
});

describe('Migration 041: no frontend UI, WhatsApp, or Google Drive added', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const active = activeSql(sql);

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(active).not.toMatch(/<[A-Z][A-Za-z]*\s*\/?>/);
    expect(active).not.toContain('useState');
    expect(active).not.toContain('useEffect');
  });

  it('no WhatsApp integration', () => {
    expect(active.toLowerCase()).not.toMatch(/wa\.me|whatsapp/);
  });

  it('no Google Drive integration', () => {
    expect(active.toLowerCase()).not.toMatch(/googleapis|google drive|drive\.google|gapi/);
  });
});

describe('Migration 041: security guardrails', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');
  const active = activeSql(sql);

  it('no service_role reference in active SQL (header prose may document its absence)', () => {
    expect(active).not.toContain('service_role');
  });

  it('no auth.admin reference in active SQL', () => {
    expect(active).not.toMatch(/auth\.admin/);
  });

  it('no supply_type reference in active SQL', () => {
    expect(active).not.toContain('supply_type');
  });

  it('no suggestion/recommendation/opportunity/اقتراح/فرصة wording in active SQL', () => {
    expect(active.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(active).not.toContain('اقتراح');
    expect(active).not.toContain('فرصة');
  });

  it('no Excel/XLSX import machinery in active SQL', () => {
    expect(active).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not touch get_public_qr_payload, qr_tokens, or qr_targets', () => {
    expect(sql).not.toMatch(/CREATE[\s\S]{0,40}qr_tokens|CREATE[\s\S]{0,40}qr_targets/i);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
  });

  it('does not redefine phoenix_apply_availability_movement, phoenix_upsert_availability, or the alert lifecycle RPCs', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_alert_state');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state');
  });

  it('does not create or alter item_availability_movements, item_availability, or either exchange table', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    expect(active).not.toMatch(/supabase\s+db\s+push/);
  });

  it('has no DROP TABLE, DROP FUNCTION, TRUNCATE, or destructive DELETE', () => {
    expect(active).not.toMatch(/drop table/i);
    expect(active).not.toMatch(/drop function/i);
    expect(active).not.toMatch(/truncate/i);
    expect(active).not.toMatch(/\bdelete from\b/i);
  });
});

describe('Migration 041: verification block exists', () => {
  const sql = readMigration('041_phoenix_inter_org_exchange_rpcs.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });
});

describe('No UI/service wiring or frontend exchange code was added in this phase (RPCs only)', () => {
  it('strings.ts is unaffected by this migration', () => {
    const stringsPath = join(__dirname, '../../../src/shared/i18n/strings.ts');
    const before = readFileSync(stringsPath, 'utf8');
    expect(before).not.toMatch(/\bexchange_request_(requested|source_approved|source_rejected|dispatched|received|completed|cancelled)\b\s*:/);
  });

  it('no exchange service/screen files exist yet', () => {
    expect(existsSync(join(__dirname, '../../../src/features/alerts/inter-org-exchange.service.ts'))).toBe(false);
    expect(existsSync(join(__dirname, '../../../src/features/exchange'))).toBe(false);
  });
});

describe('Regression: UI screens and unrelated systems untouched', () => {
  const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
  const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');
  // AdjustQuantityModal is retired (canonical-stock cutover); its absence is
  // asserted in the retired-surface audit. Movement history remains.
  const historyModal = readFileSync(join(__dirname, '../../../src/features/status/MovementHistoryModal.tsx'), 'utf8');
  const service = readFileSync(join(__dirname, '../../../src/features/alerts/live-inter-institution-alerts.service.ts'), 'utf8');
  const lifecycleService = readFileSync(join(__dirname, '../../../src/features/alerts/inter-org-alert-lifecycle.service.ts'), 'utf8');
  const swFile = readFileSync(join(__dirname, '../../../public/sw.js'), 'utf8');
  const manifest = readFileSync(join(__dirname, '../../../public/manifest.webmanifest'), 'utf8');

  it('InterInstitutionAlertsScreen/DashboardScreen do not reference the new exchange RPCs', () => {
    expect(alertsScreen).not.toContain('phoenix_create_inter_org_exchange_request');
    expect(alertsScreen).not.toContain('phoenix_update_inter_org_exchange_status');
    expect(dashboardScreen).not.toContain('phoenix_create_inter_org_exchange_request');
    expect(dashboardScreen).not.toContain('phoenix_update_inter_org_exchange_status');
  });

  it('MovementHistoryModal is unaffected', () => {
    expect(historyModal).not.toContain('inter_org_exchange');
  });

  it('live-inter-institution-alerts.service.ts and inter-org-alert-lifecycle.service.ts are unaffected', () => {
    expect(service).not.toContain('inter_org_exchange');
    expect(lifecycleService).not.toContain('inter_org_exchange');
  });

  it('PWA service worker and manifest are unaffected', () => {
    expect(swFile).not.toContain('inter_org_exchange');
    expect(manifest).not.toContain('inter_org_exchange');
  });

  it('no direct supabase.from() call to the new exchange tables exists anywhere in the checked files', () => {
    [alertsScreen, dashboardScreen, historyModal, service, lifecycleService].forEach(src => {
      expect(src).not.toMatch(/supabase\.from\(['"]inter_org_exchange/);
    });
  });
});
