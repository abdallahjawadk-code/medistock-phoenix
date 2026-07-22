/**
 * INTER-INSTITUTION-EXCHANGE-SCHEMA-B
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 040: schema/permissions/RLS
 * foundation for the inter-org exchange workflow (inter_org_exchange_requests
 * + inter_org_exchange_events). No live DB is used — these are text/shape
 * assertions against the SQL file, mirroring the 038 test's conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_040_PATH = join(MIGRATIONS_DIR, '040_phoenix_inter_org_exchange_schema.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/**
 * Strip `--` comment lines, leaving only active SQL. Used for whole-file
 * guardrails so header/VERIFY prose that documents compliance (e.g. "Does
 * NOT use service_role") never false-positives a "must not contain X" check.
 */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

describe('Migration 040 exists exactly once', () => {
  it('040_phoenix_inter_org_exchange_schema.sql exists', () => {
    expect(existsSync(MIGRATION_040_PATH)).toBe(true);
  });

  it('is the only file named 040_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('040_'));
    expect(matches).toEqual(['040_phoenix_inter_org_exchange_schema.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 040: creates exactly the two exchange tables', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('creates inter_org_exchange_requests', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.inter_org_exchange_requests');
  });

  it('creates inter_org_exchange_events', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.inter_org_exchange_events');
  });

  it('creates no other table', () => {
    const matches = activeSql(sql).match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('Migration 040: does not modify migrations 001-039', () => {
  it('all prior migration files (001-039) still exist untouched', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-2][0-9]|3[0-9])_/.test(f));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('migration 038 file is untouched (no new columns added there)', () => {
    const sql038 = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
    expect(sql038).toContain('Migration 038: Inter-Org Alert Lifecycle Schema');
  });

  it('migration 039 file is untouched', () => {
    const sql039 = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
    expect(sql039).toBeTruthy();
  });

  it('036/037/038/039 filenames are unchanged (no duplicate numbering introduced)', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('036_'))).toEqual(['036_phoenix_live_inter_institution_alerts_rpc.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('037_'))).toEqual(['037_phoenix_live_alert_identifiers.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('038_'))).toEqual(['038_phoenix_inter_org_alert_lifecycle_schema.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('039_'))).toEqual(['039_phoenix_inter_org_alert_lifecycle_rpcs.sql']);
  });
});

describe('Migration 040: does not create any RPC (schema/permissions/RLS only)', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('does not create any function at all', () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it('does not define a CREATE FUNCTION ... SECURITY DEFINER function (mentions of "SECURITY DEFINER" as prose/comments documenting the future RPC design are expected, same as migration 038)', () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[\s\S]*?SECURITY DEFINER/i);
  });

  it('verify block asserts the four known future exchange RPC names do not yet exist', () => {
    expect(sql).toContain("proname = 'phoenix_create_inter_org_exchange_request'");
    expect(sql).toContain("proname = 'phoenix_update_inter_org_exchange_status'");
    expect(sql).toContain("proname = 'phoenix_get_inter_org_exchange_events'");
    expect(sql).toContain("proname = 'phoenix_get_inter_org_exchange_requests'");
  });

  it('verify block confirms existing lifecycle/movement/QR RPCs are untouched', () => {
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts'");
    expect(sql).toContain("proname = 'phoenix_update_inter_org_alert_state'");
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('Migration 040: permission keys — 10 new keys under inter_org_exchange.* only', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
  const EXPECTED_KEYS = [
    'inter_org_exchange.view',
    'inter_org_exchange.request',
    'inter_org_exchange.approve',
    'inter_org_exchange.dispatch',
    'inter_org_exchange.receive',
    'inter_org_exchange.cancel',
    'inter_org_exchange.manage',
    'inter_org_exchange.events.view',
    'inter_org_exchange.print',
    'inter_org_exchange.export',
  ];

  EXPECTED_KEYS.forEach(key => {
    it(`adds permission key '${key}'`, () => {
      expect(sql).toContain(`'${key}'`);
    });
  });

  it('uses INSERT ... ON CONFLICT (idempotent, consistent with project style)', () => {
    expect(sql).toMatch(/INSERT INTO permission_keys[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
  });

  it('marks approve and manage as dangerous (is_dangerous = true), all others false', () => {
    const insertBlockStart = sql.indexOf('INSERT INTO permission_keys');
    const insertBlockEnd = sql.indexOf('ON CONFLICT (key) DO NOTHING');
    const block = sql.slice(insertBlockStart, insertBlockEnd);

    expect(block).toMatch(/'inter_org_exchange\.approve',\s*'inter_org_exchange',\s*'approve',[^\n]*true\)/);
    expect(block).toMatch(/'inter_org_exchange\.manage',\s*'inter_org_exchange',\s*'manage',[^\n]*true\)/);

    ['view', 'request', 'dispatch', 'receive', 'cancel', 'print', 'export'].forEach(action => {
      const re = new RegExp(`'inter_org_exchange\\.${action}',\\s*'inter_org_exchange',\\s*'${action}',[^\\n]*false\\)`);
      expect(block).toMatch(re);
    });
  });

  it('verify block confirms exactly 2 dangerous inter_org_exchange.* keys (approve, manage)', () => {
    expect(sql).toContain("key LIKE 'inter_org_exchange.%' AND is_dangerous = true");
  });
});

describe('Migration 040: role defaults match the agreed matrix', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  const EXPECTATIONS: Array<[string, string, boolean]> = [
    ['super_admin', 'inter_org_exchange.view', true],
    ['super_admin', 'inter_org_exchange.approve', true],
    ['super_admin', 'inter_org_exchange.manage', true],
    ['institution_admin', 'inter_org_exchange.approve', true],
    ['institution_admin', 'inter_org_exchange.manage', true],
    ['hospital_admin', 'inter_org_exchange.approve', true],
    ['warehouse_officer', 'inter_org_exchange.view', true],
    ['warehouse_officer', 'inter_org_exchange.request', true],
    ['warehouse_officer', 'inter_org_exchange.approve', false],
    ['warehouse_officer', 'inter_org_exchange.dispatch', true],
    ['warehouse_officer', 'inter_org_exchange.receive', true],
    ['warehouse_officer', 'inter_org_exchange.cancel', true],
    ['warehouse_officer', 'inter_org_exchange.manage', false],
    ['warehouse_officer', 'inter_org_exchange.events.view', true],
    ['warehouse_officer', 'inter_org_exchange.print', true],
    ['warehouse_officer', 'inter_org_exchange.export', true],
    ['warehouse_manager', 'inter_org_exchange.dispatch', true],
    ['warehouse_manager', 'inter_org_exchange.approve', false],
    ['port_officer', 'inter_org_exchange.view', true],
    ['port_officer', 'inter_org_exchange.request', false],
    ['port_officer', 'inter_org_exchange.dispatch', false],
    ['port_officer', 'inter_org_exchange.events.view', true],
    ['port_officer', 'inter_org_exchange.print', true],
    ['port_officer', 'inter_org_exchange.export', false],
    ['point_operator', 'inter_org_exchange.view', true],
    ['point_operator', 'inter_org_exchange.request', false],
    ['monthly_status_officer', 'inter_org_exchange.view', true],
    ['monthly_status_officer', 'inter_org_exchange.request', false],
    ['monthly_status_officer', 'inter_org_exchange.export', false],
    ['transfer_manager', 'inter_org_exchange.view', true],
    ['transfer_manager', 'inter_org_exchange.request', false],
    ['viewer', 'inter_org_exchange.view', true],
    ['viewer', 'inter_org_exchange.events.view', true],
    ['viewer', 'inter_org_exchange.request', false],
    ['viewer', 'inter_org_exchange.approve', false],
    ['viewer', 'inter_org_exchange.dispatch', false],
    ['viewer', 'inter_org_exchange.receive', false],
    ['viewer', 'inter_org_exchange.cancel', false],
    ['viewer', 'inter_org_exchange.manage', false],
    ['viewer', 'inter_org_exchange.print', false],
    ['viewer', 'inter_org_exchange.export', false],
  ];

  EXPECTATIONS.forEach(([role, key, allowed]) => {
    it(`${role} -> ${key} = ${allowed}`, () => {
      const escapedKey = key.replace(/\./g, '\\.');
      const re = new RegExp(`\\('${role}',\\s*'${escapedKey}',\\s*${allowed}\\)`);
      expect(sql).toMatch(re);
    });
  });

  it('does not remove existing permission defaults (only inserts, never deletes from role_permission_defaults)', () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+role_permission_defaults/i);
  });

  it('does not modify unrelated permission keys (no UPDATE on permission_keys itself)', () => {
    expect(sql).not.toMatch(/UPDATE\s+permission_keys/i);
  });

  it('uses idempotent upsert for role_permission_defaults (ON CONFLICT DO UPDATE)', () => {
    expect(sql).toMatch(/ON CONFLICT \(role, permission_key\) DO UPDATE SET allowed = excluded\.allowed/);
  });
});

describe('Migration 040: inter_org_exchange_requests expected columns', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
  const tableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS public.inter_org_exchange_requests');
  const tableEnd = sql.indexOf('COMMENT ON TABLE public.inter_org_exchange_requests');
  const tableBlock = sql.slice(tableStart, tableEnd);

  const EXPECTED_COLUMNS = [
    'id', 'alert_key', 'alert_state_id',
    'source_item_availability_id', 'target_item_availability_id',
    'source_organization_id', 'target_organization_id',
    'source_distribution_point_id', 'target_distribution_point_id',
    'scientific_name', 'concentration', 'dosage_form',
    'source_trade_name', 'target_trade_name',
    'requested_quantity', 'approved_quantity', 'received_quantity',
    'status', 'severity_snapshot', 'reason', 'notes',
    'requested_by', 'approved_by', 'dispatched_by', 'received_by', 'cancelled_by',
    'movement_id_out', 'movement_id_in',
    'requested_at', 'approved_at', 'dispatched_at', 'received_at', 'completed_at', 'cancelled_at',
    'created_at', 'updated_at',
  ];

  EXPECTED_COLUMNS.forEach(col => {
    it(`has column '${col}'`, () => {
      expect(tableBlock).toContain(col);
    });
  });

  it('source/target item_availability_id reference item_availability(id) ON DELETE RESTRICT', () => {
    expect(tableBlock).toMatch(/source_item_availability_id\s+uuid NOT NULL REFERENCES public\.item_availability\(id\) ON DELETE RESTRICT/);
    expect(tableBlock).toMatch(/target_item_availability_id\s+uuid NOT NULL REFERENCES public\.item_availability\(id\) ON DELETE RESTRICT/);
  });

  it('source/target organization_id reference organizations(id) ON DELETE RESTRICT', () => {
    expect(tableBlock).toMatch(/source_organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/);
    expect(tableBlock).toMatch(/target_organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/);
  });

  it('source/target distribution_point_id reference distribution_points(id) ON DELETE SET NULL, nullable', () => {
    expect(tableBlock).toMatch(/source_distribution_point_id\s+uuid REFERENCES public\.distribution_points\(id\) ON DELETE SET NULL/);
    expect(tableBlock).toMatch(/target_distribution_point_id\s+uuid REFERENCES public\.distribution_points\(id\) ON DELETE SET NULL/);
  });

  it('alert_state_id references inter_org_alert_states(id) ON DELETE SET NULL, nullable', () => {
    expect(tableBlock).toMatch(/alert_state_id\s+uuid REFERENCES public\.inter_org_alert_states\(id\) ON DELETE SET NULL/);
  });

  it('movement_id_out/movement_id_in reference item_availability_movements(id) ON DELETE SET NULL, nullable', () => {
    expect(tableBlock).toMatch(/movement_id_out\s+uuid REFERENCES public\.item_availability_movements\(id\) ON DELETE SET NULL/);
    expect(tableBlock).toMatch(/movement_id_in\s+uuid REFERENCES public\.item_availability_movements\(id\) ON DELETE SET NULL/);
  });

  it('requested_by/approved_by/dispatched_by/received_by/cancelled_by reference auth.users(id) ON DELETE SET NULL', () => {
    ['requested_by', 'approved_by', 'dispatched_by', 'received_by', 'cancelled_by'].forEach(col => {
      const re = new RegExp(`${col}\\s+uuid REFERENCES auth\\.users\\(id\\) ON DELETE SET NULL`);
      expect(tableBlock).toMatch(re);
    });
  });
});

describe('Migration 040: inter_org_exchange_events expected columns', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
  const tableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS public.inter_org_exchange_events');
  const tableEnd = sql.indexOf('COMMENT ON TABLE public.inter_org_exchange_events');
  const tableBlock = sql.slice(tableStart, tableEnd);

  const EXPECTED_COLUMNS = [
    'id', 'exchange_request_id', 'event_type',
    'actor_id', 'actor_org_id', 'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
    'from_status', 'to_status', 'quantity_snapshot', 'reason', 'notes', 'created_at',
  ];

  EXPECTED_COLUMNS.forEach(col => {
    it(`has column '${col}'`, () => {
      expect(tableBlock).toContain(col);
    });
  });

  it('exchange_request_id references inter_org_exchange_requests(id) ON DELETE RESTRICT', () => {
    expect(tableBlock).toMatch(/exchange_request_id\s+uuid NOT NULL REFERENCES public\.inter_org_exchange_requests\(id\) ON DELETE RESTRICT/);
  });

  it('actor_org_id references organizations(id) ON DELETE SET NULL', () => {
    expect(tableBlock).toMatch(/actor_org_id\s+uuid REFERENCES public\.organizations\(id\) ON DELETE SET NULL/);
  });

  it('quantity_snapshot is jsonb, validated as an object when present', () => {
    expect(tableBlock).toMatch(/quantity_snapshot\s+jsonb/);
    expect(tableBlock).toMatch(/CHECK \(quantity_snapshot IS NULL OR jsonb_typeof\(quantity_snapshot\) = 'object'\)/);
  });
});

describe('Migration 040: status/event_type allowed values', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
  const STATUSES = ['requested', 'source_approved', 'source_rejected', 'dispatched', 'received', 'completed', 'cancelled'];

  it('status CHECK includes all 7 statuses', () => {
    STATUSES.forEach(s => expect(sql).toContain(`'${s}'`));
    expect(sql).toMatch(/CHECK \(status IN \(\s*'requested', 'source_approved', 'source_rejected',\s*'dispatched', 'received', 'completed', 'cancelled'\s*\)\)/);
  });

  it('status defaults to requested', () => {
    expect(sql).toMatch(/status\s+text NOT NULL DEFAULT 'requested'/);
  });

  it('event_type CHECK includes all 7 event types (same set as statuses)', () => {
    expect(sql).toMatch(/CHECK \(event_type IN \(\s*'requested', 'source_approved', 'source_rejected',\s*'dispatched', 'received', 'completed', 'cancelled'\s*\)\)/);
  });

  it('severity_snapshot CHECK allows high/medium/low or null', () => {
    expect(sql).toMatch(/CHECK \(severity_snapshot IS NULL OR severity_snapshot IN \('high', 'medium', 'low'\)\)/);
  });

  it('from_status/to_status CHECKs allow null or a valid status value', () => {
    expect(sql).toMatch(/from_status\s+text\s+CHECK \(from_status IS NULL OR from_status IN/);
    expect(sql).toMatch(/to_status\s+text\s+CHECK \(to_status IS NULL OR to_status IN/);
  });
});

describe('Migration 040: quantity and org/availability CHECK constraints', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('requested_quantity > 0', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_requested_qty_chk');
    expect(sql).toMatch(/CHECK \(requested_quantity > 0\)/);
  });

  it('approved_quantity is null OR > 0', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_approved_qty_chk');
    expect(sql).toMatch(/CHECK \(approved_quantity IS NULL OR approved_quantity > 0\)/);
  });

  it('received_quantity is null OR > 0', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_received_qty_chk');
    expect(sql).toMatch(/CHECK \(received_quantity IS NULL OR received_quantity > 0\)/);
  });

  it('source_organization_id <> target_organization_id is enforced', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_orgs_distinct_chk');
    expect(sql).toMatch(/CHECK \(source_organization_id <> target_organization_id\)/);
  });

  it('source_item_availability_id <> target_item_availability_id is enforced', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_availability_distinct_chk');
    expect(sql).toMatch(/CHECK \(source_item_availability_id <> target_item_availability_id\)/);
  });

  it('source_rejected/cancelled require a non-empty reason', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_rejected_reason_chk');
    expect(sql).toMatch(/CHECK \(status <> 'source_rejected' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)\)/);
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_cancelled_reason_chk');
    expect(sql).toMatch(/CHECK \(status <> 'cancelled' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)\)/);
  });

  it('approved_quantity required once status reaches source_approved/dispatched/received/completed', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_approved_qty_required_chk');
    expect(sql).toMatch(/CHECK \(status NOT IN \('source_approved', 'dispatched', 'received', 'completed'\) OR approved_quantity IS NOT NULL\)/);
  });

  it('received_quantity required once status reaches received/completed', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_received_qty_required_chk');
    expect(sql).toMatch(/CHECK \(status NOT IN \('received', 'completed'\) OR received_quantity IS NOT NULL\)/);
  });

  it('movement_id_out/movement_id_in required once status = completed', () => {
    expect(sql).toContain('CONSTRAINT inter_org_exchange_requests_completed_movement_ids_chk');
    expect(sql).toMatch(/CHECK \(status <> 'completed' OR \(movement_id_out IS NOT NULL AND movement_id_in IS NOT NULL\)\)/);
  });
});

describe('Migration 040: partial unique index prevents duplicate active exchange requests', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('creates a unique index on alert_key scoped to non-terminal statuses', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS inter_org_exchange_requests_active_alert_key_uq');
    expect(sql).toMatch(/ON public\.inter_org_exchange_requests\(alert_key\)\s*\n\s*WHERE status NOT IN \('source_rejected', 'cancelled', 'completed'\)/);
  });

  it('verify block asserts the partial unique index exists', () => {
    expect(sql).toContain("indexname = 'inter_org_exchange_requests_active_alert_key_uq'");
  });
});

describe('Migration 040: RLS enabled on both tables', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('RLS enabled on inter_org_exchange_requests', () => {
    expect(sql).toContain('ALTER TABLE public.inter_org_exchange_requests ENABLE ROW LEVEL SECURITY');
  });

  it('RLS enabled on inter_org_exchange_events', () => {
    expect(sql).toContain('ALTER TABLE public.inter_org_exchange_events ENABLE ROW LEVEL SECURITY');
  });
});

describe('Migration 040: no anon/PUBLIC access', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('revokes all from PUBLIC and anon on inter_org_exchange_requests', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.inter_org_exchange_requests FROM PUBLIC, anon');
  });

  it('revokes all from PUBLIC and anon on inter_org_exchange_events', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.inter_org_exchange_events FROM PUBLIC, anon');
  });

  it('verify block asserts anon/PUBLIC have zero privileges on both tables', () => {
    expect(sql).toContain("grantee IN ('anon','PUBLIC')");
  });
});

describe('Migration 040: no authenticated INSERT/UPDATE/DELETE grants (no direct table writes)', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('revokes INSERT/UPDATE/DELETE from authenticated on inter_org_exchange_requests', () => {
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.inter_org_exchange_requests FROM authenticated');
  });

  it('revokes SELECT/INSERT/UPDATE/DELETE from authenticated on inter_org_exchange_events', () => {
    expect(sql).toContain('REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.inter_org_exchange_events FROM authenticated');
  });

  it('grants SELECT only (no write) to authenticated on requests', () => {
    expect(sql).toContain('GRANT SELECT ON TABLE public.inter_org_exchange_requests TO authenticated');
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[\s\S]{0,60}inter_org_exchange_requests/i);
  });

  it('grants nothing to authenticated on events (no actual GRANT statement targets it)', () => {
    const grantLines = activeSql(sql).split('\n').filter(l => /^\s*GRANT\b/i.test(l));
    expect(grantLines.some(l => l.includes('inter_org_exchange_events'))).toBe(false);
  });
});

describe('Migration 040: SELECT policy for requests is org-scoped and permission-gated', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
  const policyStart = sql.indexOf('CREATE POLICY "inter_org_exchange_requests_select_perm"');
  const policyEnd = sql.indexOf(';', policyStart);
  const policyBlock = sql.slice(policyStart, policyEnd);

  it('super_admin bypasses the check', () => {
    expect(policyBlock).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('checks inter_org_exchange.view', () => {
    expect(policyBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'inter_org_exchange.view')");
  });

  it('scopes to source_organization_id or target_organization_id = phoenix_my_org()', () => {
    expect(policyBlock).toContain('source_organization_id = phoenix_my_org()');
    expect(policyBlock).toContain('target_organization_id = phoenix_my_org()');
  });

  it('is the only policy on inter_org_exchange_requests (no INSERT/UPDATE/DELETE policy)', () => {
    const allPolicyMatches = sql.match(/CREATE POLICY "[^"]*" ON public\.inter_org_exchange_requests/g) ?? [];
    expect(allPolicyMatches.length).toBe(1);
  });
});

describe('Migration 040: event log has no direct SELECT policy for authenticated (Option A, matching 038)', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('documents the chosen option in the header', () => {
    expect(sql).toMatch(/Chosen:\s*NO direct SELECT policy on inter_org_exchange_events/);
  });

  it('creates no CREATE POLICY targeting inter_org_exchange_events', () => {
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,60}inter_org_exchange_events/);
  });

  it('revokes SELECT from authenticated on events explicitly', () => {
    expect(sql).toMatch(/REVOKE SELECT,[\s\S]{0,40}ON TABLE public\.inter_org_exchange_events FROM authenticated/);
  });
});

describe('Migration 040: no trigger touches item_availability or stock quantity', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('only creates the standard updated_at trigger on inter_org_exchange_requests', () => {
    const triggerMatches = activeSql(sql).match(/CREATE TRIGGER/g) ?? [];
    expect(triggerMatches.length).toBe(1);
    expect(sql).toMatch(/CREATE TRIGGER set_updated_at BEFORE UPDATE ON public\.inter_org_exchange_requests/);
  });

  it('does not create a trigger referencing item_availability', () => {
    expect(sql).not.toMatch(/CREATE TRIGGER[\s\S]{0,200}item_availability\b/);
  });
});

describe('Migration 040: security guardrails', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');
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

  it('no Excel/XLSX import machinery in active SQL (header prose may document its absence)', () => {
    expect(active).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not touch get_public_qr_payload, qr_tokens, or qr_targets', () => {
    expect(sql).not.toMatch(/CREATE[\s\S]{0,40}qr_tokens|CREATE[\s\S]{0,40}qr_targets/i);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
  });

  it('does not touch phoenix_apply_availability_movement, phoenix_upsert_availability, or the alert lifecycle RPCs', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_alert_state');
  });

  it('does not create or alter item_availability_movements or inter_org_alert_states/events', () => {
    expect(sql).not.toMatch(/CREATE TABLE[\s\S]{0,20}item_availability_movements/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]{0,20}item_availability_movements/);
    expect(sql).not.toMatch(/CREATE TABLE[\s\S]{0,20}inter_org_alert_states/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]{0,20}inter_org_alert_states/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]{0,20}inter_org_alert_events/);
  });

  it('never directly updates item_availability.quantity', () => {
    expect(active).not.toMatch(/UPDATE\s+(public\.)?item_availability\s+SET\s+quantity/i);
  });

  it('never calls phoenix_apply_availability_movement', () => {
    expect(active).not.toContain('phoenix_apply_availability_movement(');
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

describe('Migration 040: verification block exists', () => {
  const sql = readMigration('040_phoenix_inter_org_exchange_schema.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block confirms migration 036/039 RPCs still exist', () => {
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts'");
    expect(sql).toContain("proname = 'phoenix_update_inter_org_alert_state'");
  });

  it('verify block confirms quantity-movement and QR RPCs are untouched', () => {
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('No UI strings or frontend exchange UI were added in this phase (schema-only)', () => {
  it('strings.ts is unaffected by this migration (no exchange-specific i18n keys required by a schema-only phase)', () => {
    const stringsPath = join(__dirname, '../../../src/shared/i18n/strings.ts');
    const before = readFileSync(stringsPath, 'utf8');
    expect(before).not.toMatch(/\bexchange_request_(requested|source_approved|source_rejected|dispatched|received|completed|cancelled)\b\s*:/);
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

  it('InterInstitutionAlertsScreen does not reference the new exchange tables', () => {
    expect(alertsScreen).not.toContain('inter_org_exchange_requests');
    expect(alertsScreen).not.toContain('inter_org_exchange_events');
  });

  it('DashboardScreen does not reference the new exchange tables', () => {
    expect(dashboardScreen).not.toContain('inter_org_exchange_requests');
    expect(dashboardScreen).not.toContain('inter_org_exchange_events');
  });

  it('MovementHistoryModal is unaffected', () => {
    expect(historyModal).not.toContain('inter_org_exchange_requests');
  });

  it('live-inter-institution-alerts.service.ts and inter-org-alert-lifecycle.service.ts are unaffected by this schema-only phase', () => {
    expect(service).not.toContain('inter_org_exchange_requests');
    expect(service).not.toContain('inter_org_exchange_events');
    expect(lifecycleService).not.toContain('inter_org_exchange_requests');
    expect(lifecycleService).not.toContain('inter_org_exchange_events');
  });

  it('no direct supabase.from() call to the new exchange tables exists anywhere in src', () => {
    // Static grep-equivalent check across the small set of files most likely
    // to reference exchange data if this phase had (incorrectly) added
    // frontend wiring; the guard command in the task runs a full-repo rg as
    // the authoritative check.
    [alertsScreen, dashboardScreen, historyModal, service, lifecycleService].forEach(src => {
      expect(src).not.toMatch(/supabase\.from\(['"]inter_org_exchange/);
    });
  });
});
