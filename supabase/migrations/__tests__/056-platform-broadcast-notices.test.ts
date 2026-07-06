/**
 * PHASE3-PLATFORM-BROADCAST-NOTICES-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 056: platform_broadcast_messages/
 * targets/acknowledgements + five SECURITY DEFINER RPCs. No live DB is used
 * — these are text/shape assertions against the SQL file, matching the
 * 042/053/055 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_056_PATH = join(MIGRATIONS_DIR, '056_phoenix_platform_broadcast_notices.sql');

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

const migration056 = readMigration('056_phoenix_platform_broadcast_notices.sql');
const fnCreate     = extractFunction(migration056, 'phoenix_create_platform_broadcast');
const fnDeactivate = extractFunction(migration056, 'phoenix_deactivate_platform_broadcast');
const fnListAdmin  = extractFunction(migration056, 'phoenix_list_platform_broadcasts_admin');
const fnPending     = extractFunction(migration056, 'phoenix_get_pending_platform_broadcasts');
const fnAck         = extractFunction(migration056, 'phoenix_ack_platform_broadcast');

describe('Migration 056 exists exactly once', () => {
  it('056_phoenix_platform_broadcast_notices.sql exists', () => {
    expect(existsSync(MIGRATION_056_PATH)).toBe(true);
  });

  it('is the only file named 056_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('056_'));
    expect(matches).toEqual(['056_phoenix_platform_broadcast_notices.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration056).toContain('MANUAL APPLY ONLY');
    expect(migration056).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration056).toContain('DO $$');
    expect(migration056).toContain('ASSERT');
  });
});

describe('Migration 056: platform_broadcast_messages table shape', () => {
  it('has all required columns with correct constraints', () => {
    expect(migration056).toMatch(/id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(migration056).toContain('title         text NOT NULL');
    expect(migration056).toContain('body          text NOT NULL');
    expect(migration056).toMatch(/severity\s+text NOT NULL\s*\n\s*CHECK \(severity IN \('info', 'warning', 'important', 'urgent'\)\)/);
    expect(migration056).toMatch(/target_scope\s+text NOT NULL\s*\n\s*CHECK \(target_scope IN \('all', 'selected'\)\)/);
    expect(migration056).toContain("publish_at    timestamptz NOT NULL DEFAULT now()");
    expect(migration056).toContain('expires_at    timestamptz NULL');
    expect(migration056).toContain('is_active     boolean NOT NULL DEFAULT true');
    expect(migration056).toContain('created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(migration056).toContain('updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL');
  });

  it('has title/body not-blank check constraints', () => {
    expect(migration056).toContain('CHECK (btrim(title) <> \'\')');
    expect(migration056).toContain('CHECK (btrim(body) <> \'\')');
  });

  it('has an expires_at > publish_at check constraint', () => {
    expect(migration056).toContain('CHECK (expires_at IS NULL OR expires_at > publish_at)');
  });

  it('has the pending-query composite index', () => {
    expect(migration056).toContain('CREATE INDEX IF NOT EXISTS platform_broadcast_messages_pending_idx');
    expect(migration056).toContain('ON public.platform_broadcast_messages (is_active, publish_at, expires_at)');
  });

  it('has an updated_at trigger using the existing phoenix_set_updated_at() function', () => {
    expect(migration056).toContain('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.platform_broadcast_messages');
    expect(migration056).toContain('EXECUTE FUNCTION phoenix_set_updated_at();');
  });
});

describe('Migration 056: platform_broadcast_targets table shape', () => {
  it('has message_id/organization_id FKs and a unique constraint', () => {
    expect(migration056).toContain('message_id      uuid NOT NULL REFERENCES public.platform_broadcast_messages(id) ON DELETE CASCADE');
    expect(migration056).toContain('organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE');
    expect(migration056).toContain('CONSTRAINT platform_broadcast_targets_unique UNIQUE (message_id, organization_id)');
  });

  it('has an organization_id index', () => {
    expect(migration056).toContain('CREATE INDEX IF NOT EXISTS platform_broadcast_targets_org_idx');
    expect(migration056).toContain('ON public.platform_broadcast_targets (organization_id)');
  });
});

describe('Migration 056: platform_broadcast_acknowledgements table shape', () => {
  it('has message_id/organization_id/acknowledged_by columns and a unique constraint', () => {
    expect(migration056).toContain('message_id       uuid NOT NULL REFERENCES public.platform_broadcast_messages(id) ON DELETE CASCADE');
    expect(migration056).toContain('acknowledged_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(migration056).toContain('CONSTRAINT platform_broadcast_acknowledgements_unique UNIQUE (message_id, organization_id)');
  });

  it('has an organization_id index', () => {
    expect(migration056).toContain('CREATE INDEX IF NOT EXISTS platform_broadcast_acks_org_idx');
    expect(migration056).toContain('ON public.platform_broadcast_acknowledgements (organization_id)');
  });
});

describe('Migration 056: RLS enabled, no authenticated write policy', () => {
  it('RLS is enabled on all three tables', () => {
    expect(migration056).toContain('ALTER TABLE public.platform_broadcast_messages ENABLE ROW LEVEL SECURITY;');
    expect(migration056).toContain('ALTER TABLE public.platform_broadcast_targets ENABLE ROW LEVEL SECURITY;');
    expect(migration056).toContain('ALTER TABLE public.platform_broadcast_acknowledgements ENABLE ROW LEVEL SECURITY;');
  });

  it('messages SELECT policy is super_admin only', () => {
    expect(migration056).toContain('CREATE POLICY "pbm_select_superadmin" ON public.platform_broadcast_messages');
    expect(migration056).toMatch(/pbm_select_superadmin[\s\S]{0,120}phoenix_my_role\(\) = 'super_admin'/);
  });

  it('targets SELECT policy is super_admin only', () => {
    expect(migration056).toContain('CREATE POLICY "pbt_select_superadmin" ON public.platform_broadcast_targets');
  });

  it('acknowledgements SELECT policy allows super_admin or the caller\'s own org', () => {
    expect(migration056).toContain('CREATE POLICY "pba_select_superadmin_or_own_org" ON public.platform_broadcast_acknowledgements');
    expect(migration056).toMatch(/pba_select_superadmin_or_own_org[\s\S]{0,200}organization_id = phoenix_my_org\(\)/);
  });

  it('every table REVOKEs INSERT/UPDATE/DELETE from authenticated (writes are RPC-only)', () => {
    expect(migration056).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_messages FROM authenticated;');
    expect(migration056).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_targets FROM authenticated;');
    expect(migration056).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_acknowledgements FROM authenticated;');
  });

  it('every table REVOKEs ALL from PUBLIC/anon', () => {
    expect(migration056).toContain('REVOKE ALL ON TABLE public.platform_broadcast_messages FROM PUBLIC, anon;');
    expect(migration056).toContain('REVOKE ALL ON TABLE public.platform_broadcast_targets FROM PUBLIC, anon;');
    expect(migration056).toContain('REVOKE ALL ON TABLE public.platform_broadcast_acknowledgements FROM PUBLIC, anon;');
  });
});

describe('Migration 056: RPC signatures, security properties', () => {
  const fns = [
    ['phoenix_create_platform_broadcast', fnCreate],
    ['phoenix_deactivate_platform_broadcast', fnDeactivate],
    ['phoenix_list_platform_broadcasts_admin', fnListAdmin],
    ['phoenix_get_pending_platform_broadcasts', fnPending],
    ['phoenix_ack_platform_broadcast', fnAck],
  ] as const;

  it.each(fns)('%s is defined (non-empty function body extracted)', (_name, body) => {
    expect(body.length).toBeGreaterThan(50);
  });

  it('all five RPCs declare SECURITY DEFINER and SET search_path = public in their header', () => {
    const names = ['phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
      'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
      'phoenix_ack_platform_broadcast'];
    for (const name of names) {
      const header = migration056.slice(migration056.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`));
      const headerSlice = header.slice(0, header.indexOf('AS $$'));
      expect(headerSlice).toContain('SECURITY DEFINER');
      expect(headerSlice).toContain('SET search_path = public');
    }
  });

  it('phoenix_create_platform_broadcast has the exact expected signature', () => {
    expect(migration056).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_create_platform_broadcast\(\s*p_title\s+text,\s*p_body\s+text,\s*p_severity\s+text,\s*p_target_scope\s+text,\s*p_org_ids\s+uuid\[\]\s+DEFAULT NULL,\s*p_publish_at\s+timestamptz\s+DEFAULT now\(\),\s*p_expires_at\s+timestamptz\s+DEFAULT NULL\s*\)/);
  });

  it('phoenix_ack_platform_broadcast and phoenix_deactivate_platform_broadcast take p_message_id uuid', () => {
    expect(migration056).toMatch(/phoenix_ack_platform_broadcast\(\s*p_message_id uuid\s*\)/);
    expect(migration056).toMatch(/phoenix_deactivate_platform_broadcast\(\s*p_message_id uuid\s*\)/);
  });
});

describe('Migration 056: super_admin gating on admin RPCs', () => {
  it('create requires super_admin', () => {
    expect(fnCreate).toContain('INSUFFICIENT_ROLE');
    expect(fnCreate).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
  });

  it('deactivate requires super_admin', () => {
    expect(fnDeactivate).toContain('INSUFFICIENT_ROLE');
    expect(fnDeactivate).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
  });

  it('list-admin requires super_admin', () => {
    expect(fnListAdmin).toContain('INSUFFICIENT_ROLE');
    expect(fnListAdmin).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
  });

  it('pending/ack RPCs do NOT require super_admin (any authenticated org user)', () => {
    expect(fnPending).not.toContain('INSUFFICIENT_ROLE');
    expect(fnAck).not.toContain('INSUFFICIENT_ROLE');
  });
});

describe('Migration 056: input validation in create', () => {
  it('rejects empty title/body, invalid severity, invalid target_scope', () => {
    expect(fnCreate).toContain('TITLE_REQUIRED');
    expect(fnCreate).toContain('BODY_REQUIRED');
    expect(fnCreate).toContain('INVALID_SEVERITY');
    expect(fnCreate).toContain('INVALID_TARGET_SCOPE');
  });

  it('requires non-empty p_org_ids when target_scope = selected', () => {
    expect(fnCreate).toContain('ORG_IDS_REQUIRED');
    expect(fnCreate).toMatch(/p_target_scope = 'selected' AND \(p_org_ids IS NULL OR array_length\(p_org_ids, 1\) IS NULL OR array_length\(p_org_ids, 1\) = 0\)/);
  });

  it('does not insert target rows for target_scope = all', () => {
    expect(fnCreate).toMatch(/IF p_target_scope = 'selected' THEN\s*\n\s*FOREACH v_org_id IN ARRAY p_org_ids LOOP/);
  });

  it('validates expires_at is after publish_at', () => {
    expect(fnCreate).toContain('INVALID_EXPIRES_AT');
  });
});

describe('Migration 056: pending-broadcasts RPC filtering', () => {
  it('returns ok=true with empty array when caller has no organization (not an error)', () => {
    expect(fnPending).toMatch(/IF v_org IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok', true, 'broadcasts', '\[\]'::jsonb\);/);
  });

  it('filters by is_active, publish_at <= now(), and expires_at window', () => {
    expect(fnPending).toContain('m.is_active = true');
    expect(fnPending).toContain('m.publish_at <= now()');
    expect(fnPending).toContain('(m.expires_at IS NULL OR m.expires_at > now())');
  });

  it('filters by target_scope = all OR an explicit target row for the caller org', () => {
    expect(fnPending).toContain("m.target_scope = 'all'");
    expect(fnPending).toMatch(/EXISTS \(\s*\n\s*SELECT 1 FROM public\.platform_broadcast_targets t\s*\n\s*WHERE t\.message_id = m\.id AND t\.organization_id = v_org/);
  });

  it('excludes messages already acknowledged by the caller org', () => {
    expect(fnPending).toMatch(/NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.platform_broadcast_acknowledgements a\s*\n\s*WHERE a\.message_id = m\.id AND a\.organization_id = v_org/);
  });

  it('returns only safe fields: id, title, body, severity, publish_at, expires_at', () => {
    expect(fnPending).toContain("'id',         m.id");
    expect(fnPending).toContain("'title',      m.title");
    expect(fnPending).toContain("'body',       m.body");
    expect(fnPending).toContain("'severity',   m.severity");
    expect(fnPending).toContain("'publish_at', m.publish_at");
    expect(fnPending).toContain("'expires_at', m.expires_at");
  });
});

describe('Migration 056: acknowledge RPC', () => {
  it('requires the caller to have an organization', () => {
    expect(fnAck).toContain('NO_ORGANIZATION');
  });

  it('requires the message to exist', () => {
    expect(fnAck).toContain('MESSAGE_NOT_FOUND');
  });

  it('requires the message to currently be targeted/visible to the caller org before acking', () => {
    expect(fnAck).toContain('NOT_TARGETED');
    expect(fnAck).toMatch(/v_targeted := v_msg\.is_active/);
  });

  it('uses ON CONFLICT (message_id, organization_id) DO NOTHING for idempotent multi-tab/multi-user acking', () => {
    expect(fnAck).toContain('ON CONFLICT (message_id, organization_id) DO NOTHING');
  });

  it('writes no audit_logs row (the acknowledgements table itself is the audit trail)', () => {
    expect(fnAck).not.toMatch(/INSERT INTO public\.audit_logs/);
  });
});

describe('Migration 056: audit logging is limited to create/deactivate', () => {
  it('create writes an audit_logs row with action=platform_broadcast_created', () => {
    expect(fnCreate).toContain('INSERT INTO public.audit_logs');
    expect(fnCreate).toContain("'platform_broadcast_created'");
  });

  it('deactivate writes an audit_logs row with action=platform_broadcast_deactivated', () => {
    expect(fnDeactivate).toContain('INSERT INTO public.audit_logs');
    expect(fnDeactivate).toContain("'platform_broadcast_deactivated'");
  });

  it('list-admin and pending (read-only RPCs) never write audit_logs', () => {
    expect(fnListAdmin).not.toMatch(/INSERT INTO public\.audit_logs/);
    expect(fnPending).not.toMatch(/INSERT INTO public\.audit_logs/);
  });
});

describe('Migration 056: admin list RPC ack-summary counts', () => {
  it('computes target_count as active-org-count for scope=all, target-row-count for scope=selected', () => {
    expect(fnListAdmin).toMatch(/WHEN m\.target_scope = 'all' THEN v_active_org_count/);
    expect(fnListAdmin).toContain('SELECT count(*) FROM public.platform_broadcast_targets t WHERE t.message_id = m.id');
  });

  it('computes acknowledged_count from platform_broadcast_acknowledgements', () => {
    expect(fnListAdmin).toContain('SELECT count(*) FROM public.platform_broadcast_acknowledgements a WHERE a.message_id = m.id');
  });

  it('computes pending_count as target_count - acknowledged_count, floored at 0', () => {
    expect(fnListAdmin).toContain('GREATEST(');
  });
});

describe('Migration 056: grants (authenticated only, no anon)', () => {
  const fnNames = [
    'phoenix_create_platform_broadcast(\n  text, text, text, text, uuid[], timestamptz, timestamptz\n)',
  ];

  it('REVOKEs and GRANTs are present for all five RPCs', () => {
    expect(migration056).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_deactivate_platform_broadcast(uuid) TO authenticated;');
    expect(migration056).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_list_platform_broadcasts_admin() TO authenticated;');
    expect(migration056).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_pending_platform_broadcasts() TO authenticated;');
    expect(migration056).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_ack_platform_broadcast(uuid) TO authenticated;');
    expect(migration056).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_create_platform_broadcast(');
  });

  it('no GRANT EXECUTE to anon anywhere in the file', () => {
    expect(activeSql(migration056)).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });

  it('every RPC REVOKEs ALL from PUBLIC, anon', () => {
    expect(migration056).toContain('FROM PUBLIC, anon;');
    const revokeCount = (migration056.match(/FROM PUBLIC, anon;/g) ?? []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(8); // 3 tables + 5 RPCs
  });
});

describe('Migration 056: no TRUNCATE, no DELETE/DROP on any existing or new table beyond CASCADE FKs', () => {
  it('has no TRUNCATE anywhere', () => {
    expect(activeSql(migration056)).not.toMatch(/TRUNCATE/i);
  });

  it('has no DROP TABLE or DROP FUNCTION', () => {
    expect(activeSql(migration056)).not.toMatch(/DROP TABLE|DROP FUNCTION/i);
  });

  it('has no DELETE FROM statement anywhere (this feature never deletes data directly; only ON DELETE CASCADE/SET NULL FK actions exist)', () => {
    expect(activeSql(migration056)).not.toMatch(/\bDELETE FROM\b/i);
  });
});

describe('Migration 056: hard no-touch scope — QR, availability, movements, Deep Clean, existing RPCs', () => {
  // Checked against the comment-stripped active SQL, not the raw file — the
  // migration header/footer legitimately documents (in prose) that these
  // exact tables/functions/features are NOT touched by this migration (the
  // same "what this migration does NOT do" convention used by migrations
  // 042/053/055). A comment saying "does not touch item_availability" must
  // never itself trip this guard.
  const active = activeSql(migration056);

  it('does not touch item_availability or item_availability_movements in active SQL', () => {
    expect(active).not.toMatch(/\bitem_availability\b/);
    expect(active).not.toMatch(/\bitem_availability_movements\b/);
  });

  it('does not redefine or reference phoenix_clean_availability_data (migration 055 / Deep Clean) in active SQL', () => {
    expect(active).not.toContain('phoenix_clean_availability_data');
  });

  it('does not redefine get_public_qr_payload, clear_port_availability, phoenix_apply_availability_movement, or phoenix_upsert_availability', () => {
    expect(migration056).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
    expect(migration056).not.toContain('CREATE OR REPLACE FUNCTION public.clear_port_availability');
    expect(migration056).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(migration056).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('does not touch inter_org_alert_states/events, inter_org_exchange_requests/events, or dashboard RPCs in active SQL', () => {
    expect(active).not.toMatch(/inter_org_alert_states|inter_org_alert_events|inter_org_exchange_requests|inter_org_exchange_events/);
    expect(active).not.toMatch(/phoenix_get_live_inter_institution_alerts_with_state|dashboard_condition_counts/i);
  });

  it('does not touch qr_tokens or qr_targets in active SQL', () => {
    expect(active).not.toMatch(/qr_tokens|qr_targets/);
  });

  it('all prior migration files (001-055) still exist untouched by filename', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0[0-4][0-9]_|^05[0-5]_/.test(f));
    expect(matches.length).toBeGreaterThanOrEqual(55);
  });
});

describe('Migration 056: security guardrails', () => {
  it('no service_role reference in active SQL', () => {
    expect(activeSql(migration056)).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference', () => {
    expect(activeSql(migration056)).not.toMatch(/auth\.admin/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration056).not.toMatch(/import React|export function|useState|useEffect/);
  });

  it('organizations table itself is never deleted/altered destructively — only read (status) or referenced by FK', () => {
    expect(migration056).not.toMatch(/DELETE FROM public\.organizations|DROP TABLE.*organizations|ALTER TABLE public\.organizations DROP/i);
  });
});

// FIX-MIGRATION-056-SEARCH-PATH-VERIFY-FALSE-POSITIVE-A: the VERIFY block's
// original search_path check ran a literal '%SET search_path = public%' text
// search against pg_get_functiondef() output. Postgres reconstructs a
// function's SET clause in its own canonical GUC-assignment form — `SET
// search_path TO 'public'` (TO + quoted value) — not the `= public` (equals +
// unquoted) form these CREATE FUNCTION statements are written with. The
// literal text search therefore never matched the reconstructed definition
// and failed manual apply in Supabase SQL Editor even though every function
// was correctly configured. These tests guard against that exact class of
// bug recurring.
describe('Migration 056: search_path VERIFY check is robust to pg_get_functiondef reconstruction format', () => {
  const verifyBlock = migration056.slice(migration056.indexOf('-- 5. RPCs exist, SECURITY DEFINER, search_path public'));

  it('the VERIFY block does not use a literal pg_get_functiondef text match for search_path (the fragile, since-removed check)', () => {
    expect(verifyBlock).not.toMatch(/ASSERT v_src LIKE '%SET search_path = public%'/);
  });

  it('the VERIFY block checks pg_proc.proconfig directly instead — immune to SET-clause re-rendering differences', () => {
    expect(verifyBlock).toContain('unnest(COALESCE(proconfig, \'{}\')) AS cfg WHERE cfg ILIKE \'search_path=%public%\'');
  });

  it('the proconfig check still covers all five RPCs by name', () => {
    const names = ['phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
      'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
      'phoenix_ack_platform_broadcast'];
    const proconfigCheckStart = verifyBlock.indexOf('ASSERT NOT EXISTS (');
    const proconfigCheck = verifyBlock.slice(proconfigCheckStart, verifyBlock.indexOf('VERIFY FAILED: an RPC is missing SET search_path = public', proconfigCheckStart));
    for (const name of names) {
      expect(proconfigCheck).toContain(name);
    }
  });

  it('the SECURITY DEFINER check (which pg_get_functiondef renders literally and reliably) is unchanged', () => {
    expect(verifyBlock).toContain("ASSERT v_src LIKE '%SECURITY DEFINER%', 'VERIFY FAILED: an RPC is missing SECURITY DEFINER';");
  });

  it('every CREATE FUNCTION statement still has the source-level SET search_path = public (unrelated to the VERIFY-block bug — this is the actual function definition, not its runtime reconstruction)', () => {
    // Matches only a standalone `SET search_path = public` clause line (the
    // actual function definitions) — not the VERIFY block's own error
    // message string, which contains the same phrase as prose, not a SQL
    // clause.
    const count = (migration056.match(/^SET search_path = public$/gm) ?? []).length;
    expect(count).toBe(5);
  });
});
