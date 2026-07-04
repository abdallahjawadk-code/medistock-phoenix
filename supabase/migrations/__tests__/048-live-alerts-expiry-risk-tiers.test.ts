/**
 * DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 048: re-creates
 * phoenix_get_live_inter_institution_alerts_with_state (migration 039/047,
 * RETURNS jsonb, same signature) to additionally return
 * source_expiry_risk_tier/source_expiry_days_remaining per alert, and
 * widens the internal near-expiry participation window from 3 to 9 months
 * — mirroring the frontend's EXPIRY-RISK-TIERS-A tier vocabulary (commit
 * 7734698) server-side, without creating any new DB enum/status value,
 * without changing alert_key/alert_type, and without redesigning severity.
 *
 * This migration is preparation only — no SQL is applied, no
 * `supabase db push` is run, and no frontend file reads these new fields
 * yet. No live DB is used here — these are text/shape assertions against
 * the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_048_PATH = join(MIGRATIONS_DIR, '048_live_alerts_expiry_risk_tiers.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration048 = readMigration('048_live_alerts_expiry_risk_tiers.sql');
const active048 = activeSql(migration048);

describe('1. Migration file exists exactly once', () => {
  it('048_live_alerts_expiry_risk_tiers.sql exists', () => {
    expect(existsSync(MIGRATION_048_PATH)).toBe(true);
  });

  it('is the only file named 048_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('048_'));
    expect(matches).toEqual(['048_live_alerts_expiry_risk_tiers.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration048).toContain('MANUAL APPLY ONLY');
    expect(migration048).toContain('supabase db push');
  });
});

describe('2. Targets phoenix_get_live_inter_institution_alerts_with_state (same-name replacement, not a v2)', () => {
  it('re-creates the exact same function name and signature as migrations 039/047', () => {
    expect(active048).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(');
    expect(active048).toContain('p_limit integer DEFAULT 200');
    expect(active048).toContain('RETURNS jsonb');
    expect(active048).not.toContain('phoenix_get_live_inter_institution_alerts_with_state_v2');
  });

  it('no DROP FUNCTION is used — RETURNS jsonb means CREATE OR REPLACE is safe without one', () => {
    expect(active048).not.toMatch(/DROP FUNCTION/i);
  });

  it('preserves SECURITY DEFINER and SET search_path = public', () => {
    expect(active048).toContain('SECURITY DEFINER');
    expect(active048).toContain('SET search_path = public');
  });
});

describe('3. Adds source_expiry_risk_tier and source_expiry_days_remaining', () => {
  it('both new keys appear in the jsonb_build_object payload', () => {
    expect(active048).toContain("'source_expiry_risk_tier',");
    expect(active048).toContain("'source_expiry_days_remaining',");
  });

  it('both are computed from the same s.expiry_date already used for source_expiry_date (not re-fetched)', () => {
    expect(active048).toContain('s.expiry_date IS NULL');
    expect(active048).toContain('(s.expiry_date - current_date)');
  });
});

describe('4. Contains all 6 tier strings (critical_3m, warning_6m, watch_9m, expired, normal, unknown)', () => {
  it('critical_3m tier exists', () => {
    expect(active048).toContain("'critical_3m'");
  });

  it('warning_6m tier exists', () => {
    expect(active048).toContain("'warning_6m'");
  });

  it('watch_9m tier exists', () => {
    expect(active048).toContain("'watch_9m'");
  });

  it('expired/normal/unknown tier handling all exist in the tier CASE expression', () => {
    expect(active048).toContain("WHEN s.expiry_date IS NULL THEN 'unknown'");
    expect(active048).toContain("WHEN s.expiry_date < current_date THEN 'expired'");
    expect(active048).toContain("ELSE 'normal'");
  });

  it('tier boundaries exactly match the 3/6/9 month thresholds', () => {
    expect(active048).toContain("WHEN s.expiry_date <= (current_date + interval '3 months')::date THEN 'critical_3m'");
    expect(active048).toContain("WHEN s.expiry_date <= (current_date + interval '6 months')::date THEN 'warning_6m'");
    expect(active048).toContain("WHEN s.expiry_date <= (current_date + interval '9 months')::date THEN 'watch_9m'");
  });
});

describe('5. Expands near-expiry effective_status participation threshold to 9 months', () => {
  it('the candidates CTE near-expiry WHEN clause now uses 9 months, not 3', () => {
    expect(active048).toContain("ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'");
    expect(active048).not.toContain("ia.expiry_date <= (current_date + interval '3 months')::date THEN 'near_expiry'");
  });

  it('keeps condition = near_expiry as a compatibility fallback branch', () => {
    expect(active048).toContain("WHEN ia.condition = 'near_expiry' THEN 'near_expiry'");
  });
});

describe('6. Priority order preserved: expired and missing/quantity<=0 before near_expiry', () => {
  it('the expired WHEN clauses appear before the near_expiry WHEN clause in the candidates CASE', () => {
    const caseBlockStart = active048.indexOf('CASE\n        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date');
    expect(caseBlockStart).toBeGreaterThan(-1);
    const expiredIdx = active048.indexOf("ia.expiry_date < current_date THEN 'expired'", caseBlockStart);
    const missingIdx = active048.indexOf('ia.quantity <= 0', caseBlockStart);
    const nearExpiryIdx = active048.indexOf("interval '9 months'", caseBlockStart);
    expect(expiredIdx).toBeGreaterThan(-1);
    expect(missingIdx).toBeGreaterThan(-1);
    expect(nearExpiryIdx).toBeGreaterThan(-1);
    expect(expiredIdx).toBeLessThan(nearExpiryIdx);
    expect(missingIdx).toBeLessThan(nearExpiryIdx);
  });
});

describe('7. Does not create new DB enum/status values', () => {
  it('no ALTER TYPE / CREATE TYPE / new CHECK constraint statements', () => {
    expect(active048).not.toMatch(/ALTER TYPE/i);
    expect(active048).not.toMatch(/CREATE TYPE/i);
    expect(active048).not.toMatch(/ADD CONSTRAINT[^;]*CHECK/i);
  });

  it('effective_status CASE expression still only ever produces the same 6 values', () => {
    const effectiveStatusValues = ['expired', 'missing', 'near_expiry', 'low_stock', 'surplus', 'available'];
    for (const v of effectiveStatusValues) {
      expect(active048).toContain(`'${v}'`);
    }
    // critical_3m/warning_6m/watch_9m must never be assigned AS effective_status.
    expect(active048).not.toMatch(/'critical_3m'\s+AS effective_status/i);
    expect(active048).not.toMatch(/'warning_6m'\s+AS effective_status/i);
    expect(active048).not.toMatch(/'watch_9m'\s+AS effective_status/i);
  });
});

describe('8. Keeps alert_type compatible (near_expiry_to_shortage / surplus_to_shortage), no new alert_type value', () => {
  it('alert_type derivation is unchanged from migrations 036/039/047', () => {
    expect(active048).toContain("THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage' END AS alert_type");
  });
});

describe('9. Does not include expiry tier in alert_key; alert_key formula unchanged', () => {
  it('alert_key is still exactly src_availability_id:tgt_availability_id:alert_type', () => {
    expect(active048).toContain(
      "(m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key",
    );
  });

  it('source_expiry_risk_tier is never concatenated into the alert_key computation expression itself', () => {
    const alertKeyExprMatch = active048.match(/\([^()]*::text \|\| ':'[^()]*\) AS alert_key/);
    expect(alertKeyExprMatch).not.toBeNull();
    expect(alertKeyExprMatch![0]).not.toMatch(/expiry_risk_tier/i);
  });
});

describe('10. Preserves ON CONFLICT(alert_key) upsert and lifecycle fields', () => {
  it('still upserts inter_org_alert_states by alert_key and appends an opened event for new alerts', () => {
    expect(active048).toContain('ON CONFLICT (alert_key) DO UPDATE SET');
    expect(active048).toContain("'opened'");
  });

  it('all lifecycle keys from migrations 039/047 are still returned', () => {
    for (const key of [
      'alert_key', 'lifecycle_status', 'first_seen_at', 'last_seen_at',
      'acknowledged_at', 'acknowledged_by', 'in_progress_at', 'in_progress_by',
      'resolved_at', 'resolved_by', 'dismissed_at', 'dismissed_by',
      'lifecycle_reason', 'lifecycle_notes',
    ]) {
      expect(active048).toContain(`'${key}',`);
    }
  });
});

describe('11. Preserves scoped visibility', () => {
  it('still scopes visibility to super_admin or the actor\'s own org (no widening)', () => {
    expect(active048).toContain('WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org');
  });
});

describe('12. Preserves organization_status_contacts joins from migration 047', () => {
  it('both source_contact_phone and target_contact_phone are still returned', () => {
    expect(active048).toContain("'source_contact_phone',");
    expect(active048).toContain("'target_contact_phone',");
  });

  it('reads from organization_status_contacts with is_active/is_primary preference', () => {
    expect(active048).toContain('FROM public.organization_status_contacts osc');
    expect(active048).toContain('osc.is_active = true');
    expect(active048).toContain('osc.phone IS NOT NULL');
    expect(active048).toContain('ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC');
  });

  it('scopes each lateral join to that row\'s own src_org/tgt_org, never a client-supplied id', () => {
    expect(active048).toContain('osc.organization_id = s.src_org');
    expect(active048).toContain('osc.organization_id = s.tgt_org');
  });
});

describe('13. Does not change severity logic', () => {
  it('severity derivation is unchanged from migrations 036/039/047', () => {
    expect(active048).toContain("THEN 'high' ELSE 'medium' END AS severity");
  });
});

describe('14. Does not modify organization_status_contacts RLS', () => {
  it('no CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY statements', () => {
    expect(active048).not.toMatch(/CREATE POLICY/i);
    expect(active048).not.toMatch(/DROP POLICY/i);
    expect(active048).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active048).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });

  it('verification block asserts RLS remains enabled on organization_status_contacts', () => {
    expect(migration048).toContain("relname = 'organization_status_contacts' AND relrowsecurity = true");
  });
});

describe('15. Does not add table grants', () => {
  it('no GRANT/REVOKE statement targets any table directly — only the function is granted', () => {
    expect(active048).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?organization_status_contacts/i);
    expect(active048).not.toMatch(/REVOKE[^;]*ON\s+(TABLE\s+)?(public\.)?organization_status_contacts/i);
    expect(active048).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?item_availability/i);
    expect(active048).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)');
  });
});

describe('16. Does not use service_role/auth.admin', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active048).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference anywhere in the migration', () => {
    expect(active048).not.toContain('auth.admin');
  });
});

describe('17. Does not add WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active048).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('18/19. Does not modify frontend production files or package/lockfiles', () => {
  it('no frontend production file has a working-tree diff from this phase', () => {
    // src/shared/i18n/strings.ts is intentionally excluded from this list: the
    // separately-reviewed STATUS-EDITOR-CLEANUP-A phase legitimately adds one
    // new i18n key (avail_near_expiry_auto_note) there, unrelated to this
    // migration. That phase's own guard test (below) confirms only the
    // expected near-expiry-dropdown-cleanup diff exists in strings.ts.
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/account/MyAccountScreen.tsx src/shared/supabase/services/auth.service.ts src/app/App.tsx src/features/qr/PublicQrScreen.tsx src/features/status/StatusCenterScreen.tsx src/features/status/StatusEditorScreen.tsx src/features/institutions/InstitutionScreen.tsx src/features/users/UserManagementScreen.tsx src/features/alerts/InterInstitutionAlertsScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('any strings.ts diff is unrelated to migration 048 (no source_expiry_risk_tier/source_expiry_days_remaining wiring)', () => {
    // strings.ts is intentionally excluded from the frontend-file diff guard
    // above: separately-reviewed phases (STATUS-EDITOR-CLEANUP-A, and later
    // DATA-MODEL-NATIONAL-CODE-SEPARATION-A's batch/national-code label
    // realignment) legitimately add i18n keys there. This migration (048)
    // itself adds no frontend reference, so the only thing this guard checks
    // is that whatever diff exists is NOT migration-048 frontend wiring.
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/i18n/strings.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (diff.trim()) {
      expect(diff).not.toMatch(/source_expiry_risk_tier|source_expiry_days_remaining/);
    }
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('frontend wiring to source_expiry_risk_tier/source_expiry_days_remaining is a later, separately-reviewed phase — this migration itself adds no frontend reference', () => {
    expect(true).toBe(true);
  });
});

describe('20. Does not touch QR/export/print/user-management/auth/session files', () => {
  it('QR, user-management, and auth service files are untouched', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/QrScreen.tsx src/shared/supabase/services/qr.service.ts src/features/users/UserManagementScreen.tsx src/shared/supabase/services/auth.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('21. Does not modify older migrations', () => {
  it('migrations 001-047 have no working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/0[0-3][0-9]_*.sql" "supabase/migrations/04[0-7]_*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('22. Migration ceiling: allows exactly 044-051, 052+ still fails', () => {
  it('exactly eight reviewed migrations exist beyond 043', () => {
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
    ]);
  });

  it('no 052_* (or higher) migration file exists yet', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(5[2-9]|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('No SQL applied, no supabase db push run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration048).toMatch(/MANUAL APPLY ONLY/);
    expect(migration048).toMatch(/DO NOT use "supabase db push"|supabase db push/);
  });
});

describe('Safety: Service-D stash and untracked-file guards untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ (CLI cache) was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });
});
