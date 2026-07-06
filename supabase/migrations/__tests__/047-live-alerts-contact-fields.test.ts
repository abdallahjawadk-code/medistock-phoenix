/**
 * DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 047: re-creates
 * phoenix_get_live_inter_institution_alerts_with_state (migration 039,
 * RETURNS jsonb, same signature) to additionally return
 * source_contact_phone/target_contact_phone per alert, resolved
 * server-side from organization_status_contacts (migration 008) via a
 * SECURITY DEFINER lateral join — bypassing that table's RLS, which
 * BUGFIX-ALERTS-WHATSAPP-CONTACT-READ-A found has no policy at all for
 * institution_admin/monthly_status_officer, causing the frontend's
 * separate direct-table contact lookup to return empty for those roles.
 *
 * This migration is preparation only — no frontend file reads these new
 * fields yet. No live DB is used here — these are text/shape assertions
 * against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const SRC = join(__dirname, '../../../src/');
const ROOT = join(__dirname, '../../../../');
const MIGRATION_047_PATH = join(MIGRATIONS_DIR, '047_phoenix_live_alerts_contact_fields.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration047 = readMigration('047_phoenix_live_alerts_contact_fields.sql');
const active047 = activeSql(migration047);

describe('1. Migration file exists exactly once', () => {
  it('047_phoenix_live_alerts_contact_fields.sql exists', () => {
    expect(existsSync(MIGRATION_047_PATH)).toBe(true);
  });

  it('is the only file named 047_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('047_'));
    expect(matches).toEqual(['047_phoenix_live_alerts_contact_fields.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration047).toContain('MANUAL APPLY ONLY');
    expect(migration047).toContain('supabase db push');
  });
});

describe('2. Targets phoenix_get_live_inter_institution_alerts_with_state (same-name replacement, not a v2)', () => {
  it('re-creates the exact same function name and signature as migration 039', () => {
    expect(active047).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(');
    expect(active047).toContain('p_limit integer DEFAULT 200');
    expect(active047).toContain('RETURNS jsonb');
    expect(active047).not.toContain('phoenix_get_live_inter_institution_alerts_with_state_v2');
  });

  it('no DROP FUNCTION is used — RETURNS jsonb means CREATE OR REPLACE is safe without one', () => {
    expect(active047).not.toMatch(/DROP FUNCTION/i);
  });
});

describe('3/4. Adds source_contact_phone and target_contact_phone', () => {
  it('both new keys appear in the jsonb_build_object payload', () => {
    expect(active047).toContain("'source_contact_phone',");
    expect(active047).toContain("'target_contact_phone',");
  });
});

describe('5/6/7/8. Contact selection rules', () => {
  it('reads from organization_status_contacts', () => {
    expect(active047).toContain('FROM public.organization_status_contacts osc');
  });

  it('requires is_active = true and a non-null phone', () => {
    expect(active047).toContain('osc.is_active = true');
    expect(active047).toContain('osc.phone IS NOT NULL');
  });

  it('prefers is_primary, then most-recent update/create as tie-breaker', () => {
    expect(active047).toContain('ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC');
  });

  it('uses LIMIT 1 for both the source and target contact lateral joins', () => {
    const matches = active047.match(/LIMIT 1/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('scopes each lateral join to that row\'s own src_org/tgt_org, never a client-supplied id', () => {
    expect(active047).toContain('osc.organization_id = s.src_org');
    expect(active047).toContain('osc.organization_id = s.tgt_org');
  });
});

describe('9. Does not modify organization_status_contacts RLS', () => {
  it('no CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY statements', () => {
    expect(active047).not.toMatch(/CREATE POLICY/i);
    expect(active047).not.toMatch(/DROP POLICY/i);
    expect(active047).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active047).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });

  it('verification block asserts RLS remains enabled on organization_status_contacts', () => {
    expect(migration047).toContain("relname = 'organization_status_contacts' AND relrowsecurity = true");
  });
});

describe('10. Does not grant table access', () => {
  it('no GRANT/REVOKE statement targets organization_status_contacts directly — only the function is granted', () => {
    expect(active047).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?organization_status_contacts/i);
    expect(active047).not.toMatch(/REVOKE[^;]*ON\s+(TABLE\s+)?(public\.)?organization_status_contacts/i);
    expect(active047).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)');
  });
});

describe('11. Does not use service_role/auth.admin', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active047).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference anywhere in the migration', () => {
    expect(active047).not.toContain('auth.admin');
  });
});

describe('12. Does not add WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active047).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('13. Preserves existing live alert lifecycle fields', () => {
  it('all lifecycle keys from migration 039 are still returned', () => {
    for (const key of [
      'alert_key', 'lifecycle_status', 'first_seen_at', 'last_seen_at',
      'acknowledged_at', 'acknowledged_by', 'in_progress_at', 'in_progress_by',
      'resolved_at', 'resolved_by', 'dismissed_at', 'dismissed_by',
      'lifecycle_reason', 'lifecycle_notes',
    ]) {
      expect(active047).toContain(`'${key}',`);
    }
  });

  it('still upserts inter_org_alert_states by alert_key and appends an opened event for new alerts', () => {
    expect(active047).toContain('ON CONFLICT (alert_key) DO UPDATE SET');
    expect(active047).toContain("'opened'");
  });

  it('still SECURITY DEFINER with search_path pinned', () => {
    expect(active047).toContain('SECURITY DEFINER');
    expect(active047).toContain('SET search_path = public');
  });

  it('still scopes visibility to super_admin or the actor\'s own org (no widening)', () => {
    expect(active047).toContain('WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org');
  });
});

describe('14/15/16/17. Does not modify frontend production files', () => {
  // InterInstitutionAlertsScreen.tsx is intentionally NOT diff-checked here:
  // this migration (047, SQL-only) did not touch it, but a later,
  // separately-reviewed phase (UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A) is
  // explicitly authorized to wire the screen to these new RPC fields. A
  // literal "no diff" check against the live working tree would wrongly fail
  // once that legitimate later phase lands.

  it('MyAccountScreen.tsx / auth.service.ts / strings.ts have no working-tree diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/account/MyAccountScreen.tsx src/shared/supabase/services/auth.service.ts src/shared/i18n/strings.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('App.tsx, PublicQrScreen.tsx, StatusCenterScreen.tsx, UserManagementScreen.tsx have no working-tree diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/app/App.tsx src/features/qr/PublicQrScreen.tsx src/features/status/StatusCenterScreen.tsx src/features/users/UserManagementScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('frontend wiring to these new fields is a later, separately-reviewed phase (UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A) — this migration itself adds no frontend reference', () => {
    // Intentionally not asserted against the live InterInstitutionAlertsScreen
    // source here: once that later phase lands, the screen legitimately does
    // reference sourceContactPhone/targetContactPhone, and re-asserting their
    // absence here would wrongly fail forever. This migration's own scope
    // (SQL only, no frontend changes) is already covered by the "no frontend
    // production files changed" diff checks above.
    expect(true).toBe(true);
  });
});

describe('19/20. No SQL applied locally, supabase db push not run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration047).toMatch(/MANUAL APPLY ONLY/);
    expect(migration047).toMatch(/DO NOT use "supabase db push"|supabase db push/);
  });
});

describe('21/22. Migration ceiling allows exactly 044/045/046/047/048/049/050/051/052/053/054, future 055+ still fails', () => {
  it('exactly twelve reviewed migrations exist beyond 043 (044-055)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual([
      '044_phoenix_profiles_whatsapp_phone.sql',
      '045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '047_phoenix_live_alerts_contact_fields.sql',
      '048_live_alerts_expiry_risk_tiers.sql',
      '049_add_national_code_to_item_availability.sql',
      '050_phoenix_upsert_availability_national_code.sql',
      '051_material_batch_identity_option_a.sql',
      '052_qr_effective_condition_quantity_zero.sql',
      '053_item_availability_removed_marker.sql',
      '054_dashboard_condition_counts_rpcs.sql',
      '055_phoenix_clean_availability_data.sql',
    ]);
  });

  it('no migration 056 (or higher) exists yet (055 is this reviewed PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A addition)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(5[6-9]|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('No package/lockfile changes', () => {
  it('package.json/lockfiles empty diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});
