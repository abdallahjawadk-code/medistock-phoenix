/**
 * PHASE3-PLATFORM-BROADCAST-ACK-DETAILS-DELETE-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 057: phoenix_get_platform_broadcast_ack_status
 * and phoenix_delete_platform_broadcast. No live DB is used — these are
 * text/shape assertions against the SQL file, matching the 055/056 tests'
 * conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_057_PATH = join(MIGRATIONS_DIR, '057_phoenix_platform_broadcast_admin_details_delete.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const afterStart = sql.indexOf('AS $$', start) + 'AS $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

const migration057 = readMigration('057_phoenix_platform_broadcast_admin_details_delete.sql');
const migration056 = readMigration('056_phoenix_platform_broadcast_notices.sql');
const fnAckStatus = extractFunction(migration057, 'phoenix_get_platform_broadcast_ack_status');
const fnDelete = extractFunction(migration057, 'phoenix_delete_platform_broadcast');

describe('Migration 057 exists exactly once', () => {
  it('057_phoenix_platform_broadcast_admin_details_delete.sql exists', () => {
    expect(existsSync(MIGRATION_057_PATH)).toBe(true);
  });

  it('is the only file named 057_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('057_'));
    expect(matches).toEqual(['057_phoenix_platform_broadcast_admin_details_delete.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration057).toContain('MANUAL APPLY ONLY');
    expect(migration057).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration057).toContain('DO $$');
    expect(migration057).toContain('ASSERT');
  });
});

describe('Migration 057: does not modify migration 056 (read-only reference only)', () => {
  it('does not redefine any of the five migration 056 RPCs', () => {
    const names056 = [
      'phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
      'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
      'phoenix_ack_platform_broadcast',
    ];
    for (const name of names056) {
      expect(migration057).not.toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    }
  });

  it('does not ALTER or DROP the three migration 056 tables', () => {
    const active = activeSql(migration057);
    expect(active).not.toMatch(/ALTER TABLE public\.platform_broadcast_(messages|targets|acknowledgements)/i);
    expect(active).not.toMatch(/DROP TABLE public\.platform_broadcast_(messages|targets|acknowledgements)/i);
  });

  it('migration 056 file itself has no test-detectable change expected from this phase (056 is read-only reference)', () => {
    expect(migration056).toContain('CREATE TABLE IF NOT EXISTS public.platform_broadcast_messages');
  });
});

describe('Migration 057: RPC signatures and security properties', () => {
  it('phoenix_get_platform_broadcast_ack_status(p_message_id uuid) exists', () => {
    expect(migration057).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_get_platform_broadcast_ack_status\(\s*p_message_id uuid\s*\)/);
  });

  it('phoenix_delete_platform_broadcast(p_message_id uuid, p_confirmation text) exists', () => {
    expect(migration057).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_delete_platform_broadcast\(\s*p_message_id\s+uuid,\s*p_confirmation\s+text\s*\)/);
  });

  it('both return jsonb', () => {
    const ackStart = migration057.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_platform_broadcast_ack_status(');
    const delStart = migration057.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_delete_platform_broadcast(');
    const ackHeader = migration057.slice(ackStart, migration057.indexOf('AS $$', ackStart));
    const delHeader = migration057.slice(delStart, migration057.indexOf('AS $$', delStart));
    expect(ackHeader).toContain('RETURNS jsonb');
    expect(delHeader).toContain('RETURNS jsonb');
  });

  it('both declare SECURITY DEFINER and SET search_path = public in their header', () => {
    for (const name of ['phoenix_get_platform_broadcast_ack_status', 'phoenix_delete_platform_broadcast']) {
      const header = migration057.slice(migration057.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`));
      const headerSlice = header.slice(0, header.indexOf('AS $$'));
      expect(headerSlice).toContain('SECURITY DEFINER');
      expect(headerSlice).toContain('SET search_path = public');
    }
  });
});

describe('Migration 057: super_admin gating on both RPCs', () => {
  it('ack-status RPC requires super_admin', () => {
    expect(fnAckStatus).toContain('INSUFFICIENT_ROLE');
    expect(fnAckStatus).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
  });

  it('delete RPC requires super_admin', () => {
    expect(fnDelete).toContain('INSUFFICIENT_ROLE');
    expect(fnDelete).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
  });

  it('both reject unauthenticated callers', () => {
    expect(fnAckStatus).toContain('NOT_AUTHENTICATED');
    expect(fnDelete).toContain('NOT_AUTHENTICATED');
  });
});

describe('Migration 057: ack-status RPC returns institution-level detail', () => {
  it('returns NOT_FOUND for a missing message', () => {
    expect(fnAckStatus).toContain("RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');");
  });

  it('returns message basic fields', () => {
    expect(fnAckStatus).toContain("'id',           v_msg.id");
    expect(fnAckStatus).toContain("'title',        v_msg.title");
    expect(fnAckStatus).toContain("'severity',     v_msg.severity");
    expect(fnAckStatus).toContain("'target_scope', v_msg.target_scope");
    expect(fnAckStatus).toContain("'publish_at',   v_msg.publish_at");
    expect(fnAckStatus).toContain("'expires_at',   v_msg.expires_at");
    expect(fnAckStatus).toContain("'is_active',    v_msg.is_active");
  });

  it('returns target_count, acknowledged_count, pending_count', () => {
    expect(fnAckStatus).toContain("'target_count',       v_target_count");
    expect(fnAckStatus).toContain("'acknowledged_count',  v_acknowledged_count");
    expect(fnAckStatus).toContain("'pending_count',       GREATEST(v_target_count - v_acknowledged_count, 0)");
  });

  it('institutions array includes organization_id, organization_name, targeted, acknowledged, acknowledged_at, acknowledged_by_name/email/role', () => {
    expect(fnAckStatus).toContain("'organization_id',        o.id");
    expect(fnAckStatus).toContain("'organization_name',      o.name");
    expect(fnAckStatus).toContain("'targeted',                true");
    expect(fnAckStatus).toContain("'acknowledged',            (a.id IS NOT NULL)");
    expect(fnAckStatus).toContain("'acknowledged_at',         a.acknowledged_at");
    expect(fnAckStatus).toContain("'acknowledged_by_name',    ap.full_name");
    expect(fnAckStatus).toContain("'acknowledged_by_email',   au.email");
    expect(fnAckStatus).toContain("'acknowledged_by_role',    ap.role");
  });

  it('never includes the raw acknowledged_by uuid in the response', () => {
    expect(fnAckStatus).not.toMatch(/'acknowledged_by',\s*a\.acknowledged_by/);
  });

  it('resolves acknowledger identity via the established profiles+auth.users join pattern (migrations 034/039)', () => {
    expect(fnAckStatus).toContain('LEFT JOIN public.profiles ap ON ap.id = a.acknowledged_by');
    expect(fnAckStatus).toContain('LEFT JOIN auth.users au ON au.id = a.acknowledged_by');
  });

  it("for target_scope='all', selects from organizations WHERE status = 'active'", () => {
    expect(fnAckStatus).toContain('FROM public.organizations o');
    expect(fnAckStatus).toMatch(/WHERE o\.status = 'active';/);
  });

  it("for target_scope='selected', selects from platform_broadcast_targets scoped to this message", () => {
    expect(fnAckStatus).toContain('FROM public.platform_broadcast_targets t');
    expect(fnAckStatus).toContain('WHERE t.message_id = p_message_id');
  });
});

describe('Migration 057: delete RPC requires typed confirmation', () => {
  it("requires the exact phrase 'DELETE PLATFORM BROADCAST'", () => {
    expect(fnDelete).toContain("v_required text := 'DELETE PLATFORM BROADCAST';");
    expect(fnDelete).toMatch(/p_confirmation IS DISTINCT FROM v_required/);
    expect(fnDelete).toContain('INVALID_CONFIRMATION');
  });

  it('returns NOT_FOUND for a missing message', () => {
    expect(fnDelete).toContain("RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');");
  });

  it('the confirmation check happens before the NOT_FOUND lookup (fail fast on bad confirmation)', () => {
    const confirmIdx = fnDelete.indexOf('INVALID_CONFIRMATION');
    const notFoundIdx = fnDelete.indexOf("'error', 'NOT_FOUND'");
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(confirmIdx);
  });
});

describe('Migration 057: delete RPC uses safe, scoped WHERE clauses (never a bare DELETE)', () => {
  it('deletes targets scoped by message_id', () => {
    expect(fnDelete).toContain('DELETE FROM public.platform_broadcast_targets WHERE message_id = p_message_id;');
  });

  it('deletes acknowledgements scoped by message_id', () => {
    expect(fnDelete).toContain('DELETE FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id;');
  });

  it('deletes the message scoped by id', () => {
    expect(fnDelete).toContain('DELETE FROM public.platform_broadcast_messages WHERE id = p_message_id;');
  });

  it('deletes children before the parent message row', () => {
    const targetsIdx = fnDelete.indexOf('DELETE FROM public.platform_broadcast_targets WHERE message_id = p_message_id;');
    const acksIdx = fnDelete.indexOf('DELETE FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id;');
    const msgIdx = fnDelete.indexOf('DELETE FROM public.platform_broadcast_messages WHERE id = p_message_id;');
    expect(targetsIdx).toBeGreaterThan(-1);
    expect(acksIdx).toBeGreaterThan(targetsIdx);
    expect(msgIdx).toBeGreaterThan(acksIdx);
  });

  it('never uses TRUNCATE in the function body', () => {
    expect(activeSql(fnDelete)).not.toMatch(/TRUNCATE/i);
  });
});

describe('Migration 057: delete RPC writes an audit_logs snapshot before deleting', () => {
  it('inserts into audit_logs with action=platform_broadcast_deleted, entity_type=system, entity_id=p_message_id', () => {
    expect(fnDelete).toContain('INSERT INTO public.audit_logs');
    expect(fnDelete).toContain("'platform_broadcast_deleted'");
    expect(fnDelete).toContain("'system'");
    expect(fnDelete).toMatch(/entity_type, entity_id, payload\s*\)\s*VALUES\s*\(\s*NULL, v_actor, v_role, 'platform_broadcast_deleted',\s*'system', p_message_id,/);
  });

  it('payload includes title/severity/target_scope/target_count/acknowledged_count/deleted_by/deleted_at/confirmation_used', () => {
    const insertIdx = fnDelete.indexOf('INSERT INTO public.audit_logs');
    const payloadBlock = fnDelete.slice(insertIdx, fnDelete.indexOf('DELETE FROM public.platform_broadcast_targets', insertIdx));
    expect(payloadBlock).toContain("'title', v_msg.title");
    expect(payloadBlock).toContain("'severity', v_msg.severity");
    expect(payloadBlock).toContain("'target_scope', v_msg.target_scope");
    expect(payloadBlock).toContain("'target_count', v_target_count");
    expect(payloadBlock).toContain("'acknowledged_count', v_acknowledged_count");
    expect(payloadBlock).toContain("'deleted_by', v_actor");
    expect(payloadBlock).toContain("'deleted_at', now()");
    expect(payloadBlock).toContain("'confirmation_used', true");
  });

  it('the audit_logs INSERT occurs before all three DELETEs (textual order)', () => {
    const insertIdx = fnDelete.indexOf('INSERT INTO public.audit_logs');
    const firstDeleteIdx = fnDelete.indexOf('DELETE FROM public.platform_broadcast_targets WHERE message_id = p_message_id;');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(firstDeleteIdx).toBeGreaterThan(insertIdx);
  });
});

describe('Migration 057: no protected table is ever deleted from', () => {
  const protectedTables = [
    'organizations', 'profiles', 'qr_targets', 'qr_tokens',
    'item_availability', 'item_availability_movements',
    'permission_keys', 'role_permission_defaults', 'profile_permission_overrides',
    'audit_logs',
  ];

  it.each(protectedTables)('no DELETE FROM public.%s in the delete RPC body', (table) => {
    const re = new RegExp(`DELETE FROM public\\.${table}\\b`, 'i');
    expect(fnDelete).not.toMatch(re);
  });

  it('no DELETE FROM auth.users', () => {
    expect(fnDelete).not.toMatch(/DELETE FROM auth\.users/i);
  });

  it('has no DROP TABLE or DROP FUNCTION anywhere in the migration', () => {
    expect(activeSql(migration057)).not.toMatch(/DROP TABLE|DROP FUNCTION/i);
  });
});

describe('Migration 057: grants (authenticated only, no anon)', () => {
  it('REVOKEs from PUBLIC/anon and GRANTs EXECUTE to authenticated for both RPCs', () => {
    expect(migration057).toContain('REVOKE ALL ON FUNCTION public.phoenix_get_platform_broadcast_ack_status(uuid) FROM PUBLIC, anon;');
    expect(migration057).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_platform_broadcast_ack_status(uuid) TO authenticated;');
    expect(migration057).toContain('REVOKE ALL ON FUNCTION public.phoenix_delete_platform_broadcast(uuid, text) FROM PUBLIC, anon;');
    expect(migration057).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_delete_platform_broadcast(uuid, text) TO authenticated;');
  });

  it('no GRANT EXECUTE to anon anywhere in the file', () => {
    expect(activeSql(migration057)).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });
});

describe('Migration 057: search_path VERIFY uses the robust proconfig check (not the fragile pg_get_functiondef text match)', () => {
  const verifyBlock = migration057.slice(migration057.indexOf('DO $$'));

  it('does not use a literal pg_get_functiondef text match for search_path', () => {
    expect(verifyBlock).not.toMatch(/ASSERT v_src LIKE '%SET search_path = public%'/);
  });

  it('checks pg_proc.proconfig directly', () => {
    expect(verifyBlock).toContain("unnest(COALESCE(proconfig, '{}')) AS cfg WHERE cfg ILIKE 'search_path=%public%'");
  });
});

describe('Migration 057: hard no-touch scope', () => {
  // Checked against the two functions' own bodies, not the whole active SQL
  // file — the VERIFY block's own defensive "no protected table deleted"
  // ASSERT legitimately mentions these exact substrings (item_availability,
  // qr_tokens, qr_targets, etc.) as part of its own guard literals, which
  // must never itself trip this "did this migration touch X" check.
  const functionBodies = fnAckStatus + '\n' + fnDelete;

  it('does not touch item_availability or item_availability_movements', () => {
    expect(functionBodies).not.toMatch(/\bitem_availability\b/);
    expect(functionBodies).not.toMatch(/\bitem_availability_movements\b/);
  });

  it('does not touch QR tables or Deep Clean function', () => {
    expect(functionBodies).not.toMatch(/qr_tokens|qr_targets/);
    expect(functionBodies).not.toContain('phoenix_clean_availability_data');
  });

  it('does not touch inter_org_alert/exchange tables or dashboard RPCs', () => {
    expect(functionBodies).not.toMatch(/inter_org_alert_states|inter_org_alert_events|inter_org_exchange_requests|inter_org_exchange_events/);
    expect(functionBodies).not.toMatch(/phoenix_get_live_inter_institution_alerts_with_state|dashboard_condition_counts/i);
  });

  it('all prior migration files (001-056) still exist untouched by filename', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0[0-4][0-9]_|^05[0-6]_/.test(f));
    expect(matches.length).toBeGreaterThanOrEqual(56);
  });
});

describe('Migration 057: security guardrails', () => {
  it('no service_role reference', () => {
    expect(activeSql(migration057)).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference', () => {
    expect(activeSql(migration057)).not.toMatch(/auth\.admin/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration057).not.toMatch(/import React|export function|useState|useEffect/);
  });
});
