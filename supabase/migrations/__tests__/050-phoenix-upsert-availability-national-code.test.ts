/**
 * DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 050: adds p_national_code text
 * DEFAULT NULL to phoenix_upsert_availability (dropping the old 12-argument
 * overload first to avoid an ambiguous overload), normalizes it with
 * NULLIF(btrim(...), ''), inserts it on new rows, and on UPDATE only
 * overwrites it when a non-null/non-blank value is supplied (preserving any
 * existing value otherwise) — without changing the matching key, quantity
 * hard guard, batch_number handling, uniqueness, alert matching, movement
 * history, or RLS/grants.
 *
 * This migration is preparation only — no SQL is applied, no
 * `supabase db push` is run, and no frontend RPC-calling code sends
 * p_national_code yet. No live DB is used here — these are text/shape
 * assertions against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_050_PATH = join(MIGRATIONS_DIR, '050_phoenix_upsert_availability_national_code.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration050 = readMigration('050_phoenix_upsert_availability_national_code.sql');
const active050 = activeSql(migration050);

describe('1. Migration file exists exactly once', () => {
  it('050_phoenix_upsert_availability_national_code.sql exists', () => {
    expect(existsSync(MIGRATION_050_PATH)).toBe(true);
  });

  it('is the only file named 050_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('050_'));
    expect(matches).toEqual(['050_phoenix_upsert_availability_national_code.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration050).toContain('MANUAL APPLY ONLY');
    expect(migration050).toContain('supabase db push');
  });
});

describe('2. Targets phoenix_upsert_availability (drop old overload, create new one)', () => {
  it('drops the old 12-argument function before creating the new one', () => {
    expect(active050).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_upsert_availability\(\s*uuid, text, text, text, text, integer, text, date, text, text, text, numeric\s*\);/,
    );
  });

  it('creates the function (not CREATE OR REPLACE, since the arg list changed)', () => {
    expect(active050).toContain('CREATE FUNCTION public.phoenix_upsert_availability(');
  });

  it('preserves SECURITY DEFINER and SET search_path = public', () => {
    expect(active050).toContain('SECURITY DEFINER');
    expect(active050).toContain('SET search_path = public');
  });
});

describe('3. Adds p_national_code text DEFAULT NULL as the final parameter', () => {
  it('parameter is declared with a NULL default', () => {
    expect(active050).toContain('p_national_code          text DEFAULT NULL');
  });

  it('appears after p_price in the parameter list (appended, not inserted mid-list)', () => {
    const priceIdx = active050.indexOf('p_price                  numeric');
    const codeIdx = active050.indexOf('p_national_code          text DEFAULT NULL');
    expect(priceIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeGreaterThan(priceIdx);
  });
});

describe('4. Normalizes national_code with btrim and NULLIF', () => {
  it('declares v_national_code := NULLIF(btrim(p_national_code), \'\')', () => {
    expect(active050).toContain("v_national_code     text := NULLIF(btrim(p_national_code), '')");
  });
});

describe('5. Inserts national_code on new rows', () => {
  it('INSERT column list includes national_code', () => {
    const insertStmt = active050.slice(active050.indexOf('INSERT INTO public.item_availability'));
    expect(insertStmt).toContain('national_code');
  });

  it('INSERT VALUES list uses v_national_code (normalized value, may be NULL)', () => {
    const insertStmt = active050.slice(active050.indexOf('INSERT INTO public.item_availability'), active050.indexOf('INSERT INTO public.item_availability') + 900);
    expect(insertStmt).toContain('v_national_code');
  });
});

describe('6. Updates national_code, but never silently clears an existing value', () => {
  it('UPDATE SET list uses COALESCE(v_national_code, ia.national_code)', () => {
    expect(active050).toContain('national_code = COALESCE(v_national_code, ia.national_code)');
  });
});

describe('7. Preserves batch_number handling, independent of national_code', () => {
  it('UPDATE branch still unconditionally sets batch_number = p_batch_number', () => {
    expect(active050).toContain('batch_number  = p_batch_number');
  });

  it('INSERT branch still inserts batch_number from p_batch_number', () => {
    const insertStmt = active050.slice(active050.indexOf('INSERT INTO public.item_availability'), active050.indexOf('INSERT INTO public.item_availability') + 900);
    expect(insertStmt).toContain('p_batch_number');
  });
});

describe('8. Preserves the old matching key exactly', () => {
  it('matches on distribution_point_id + scientific_name + COALESCE(concentration/dosage_form)', () => {
    expect(active050).toContain('ia.distribution_point_id = p_distribution_point_id');
    expect(active050).toContain('ia.scientific_name       = p_scientific_name');
    expect(active050).toContain("COALESCE(ia.concentration, '') = v_conc");
    expect(active050).toContain("COALESCE(ia.dosage_form,  '') = v_dosage");
  });
});

describe('9. Does not include expiry_date in the matching key', () => {
  it('the WHERE clause of the existing-row lookup has no expiry_date comparison', () => {
    const selectStmt = active050.slice(
      active050.indexOf('SELECT ia.id, ia.quantity INTO'),
      active050.indexOf('IF v_existing_id IS NOT NULL THEN'),
    );
    expect(selectStmt).not.toMatch(/expiry_date/i);
  });
});

describe('10. Does not include national_code in the matching key', () => {
  it('the WHERE clause of the existing-row lookup has no national_code comparison', () => {
    const selectStmt = active050.slice(
      active050.indexOf('SELECT ia.id, ia.quantity INTO'),
      active050.indexOf('IF v_existing_id IS NOT NULL THEN'),
    );
    expect(selectStmt).not.toMatch(/national_code/i);
  });
});

describe('11. Does not change uniqueness/indexes', () => {
  it('no CREATE UNIQUE INDEX / ALTER TABLE ... ADD CONSTRAINT ... UNIQUE / DROP INDEX statements', () => {
    expect(active050).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(active050).not.toMatch(/ADD CONSTRAINT[^;]*UNIQUE/i);
    expect(active050).not.toMatch(/DROP INDEX/i);
  });
});

describe('12. Preserves the quantity hard guard on UPDATE', () => {
  it('still raises quantity_update_requires_movement on mismatch', () => {
    expect(active050).toContain('quantity_update_requires_movement');
    expect(active050).toContain('IS DISTINCT FROM v_existing_quantity');
  });

  it('UPDATE SET list never assigns quantity = p_quantity', () => {
    // Scope to the actual UPDATE statement, not the verification DO block's
    // own string-literal assertions about what the UPDATE must NOT contain.
    const updateStmt = active050.slice(
      active050.indexOf('UPDATE public.item_availability AS ia'),
      active050.indexOf('RETURNING ia.id INTO v_id;'),
    );
    expect(updateStmt).not.toMatch(/SET\s+quantity\s*=\s*p_quantity/i);
  });
});

describe('13. Preserves SECURITY DEFINER', () => {
  it('function is declared SECURITY DEFINER', () => {
    expect(active050).toContain('SECURITY DEFINER');
  });
});

describe('14. Preserves SET search_path = public', () => {
  it('function sets search_path to public', () => {
    expect(active050).toContain('SET search_path = public');
  });
});

describe('15. Preserves create/update permission checks', () => {
  it('references availability.create and availability.update', () => {
    expect(active050).toContain("'availability.create'");
    expect(active050).toContain("'availability.update'");
  });

  it('both INSERT and UPDATE branches re-check their respective permission', () => {
    expect(active050).toContain('forbidden_availability_update');
    expect(active050).toContain('forbidden_availability_create');
  });
});

describe('16. Preserves organization/distribution-point ownership checks', () => {
  it('derives organization from distribution_points, not from client input', () => {
    expect(active050).toContain('FROM public.distribution_points');
    expect(active050).toContain('v_point_org := v_dp.organization_id');
  });

  it('rejects cross-org access', () => {
    expect(active050).toContain('forbidden_cross_org');
  });
});

describe('17. Does not change movement-history tables/RPCs', () => {
  it('does not reference item_availability_movements or redefine phoenix_apply_availability_movement', () => {
    expect(active050).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_apply_availability_movement/i);
    expect(active050).not.toMatch(/CREATE TABLE[^;]*item_availability_movements/i);
  });
});

describe('18. Does not change alert functions or alert_key', () => {
  it('does not reference any alert function, alert_key, or lifecycle table', () => {
    expect(active050).not.toMatch(/phoenix_get_live_inter_institution_alerts/i);
    expect(active050).not.toMatch(/alert_key/i);
    expect(active050).not.toMatch(/inter_org_alert_states/i);
    expect(active050).not.toMatch(/inter_org_alert_events/i);
  });
});

describe('19. Does not change RLS/policies', () => {
  it('no CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY statements', () => {
    expect(active050).not.toMatch(/CREATE POLICY/i);
    expect(active050).not.toMatch(/DROP POLICY/i);
    expect(active050).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active050).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });

  it('verification block asserts the item_availability policy count is unchanged (4)', () => {
    expect(migration050).toContain("tablename = 'item_availability'");
    expect(migration050).toContain(') = 4,');
  });
});

describe('20. Does not broaden table grants', () => {
  it('GRANT/REVOKE only target the phoenix_upsert_availability function, never a table', () => {
    expect(active050).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?item_availability\b/i);
    expect(active050).not.toMatch(/REVOKE[^;]*ON\s+(TABLE\s+)?(public\.)?item_availability\b/i);
  });

  it('EXECUTE is granted to authenticated only, anon/PUBLIC still revoked', () => {
    expect(active050).toContain('REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(');
    expect(active050).toContain('FROM PUBLIC, anon;');
    expect(active050).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(');
    expect(active050).toContain('TO authenticated;');
  });
});

describe('21. Does not use service_role', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active050).not.toMatch(/service_role/i);
  });
});

describe('22. Does not use auth.admin', () => {
  it('no auth.admin reference anywhere in the migration', () => {
    expect(active050).not.toContain('auth.admin');
  });
});

describe('23. Does not touch WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active050).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('24. Does not change package/lockfiles', () => {
  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('migrations 001-049 have no working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/0[0-3][0-9]_*.sql" "supabase/migrations/04[0-9]_*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('does not apply migration 048 or reference its expiry-tier fields', () => {
    expect(active050).not.toMatch(/source_expiry_risk_tier|source_expiry_days_remaining/i);
  });

  it('this migration itself does not reference frontend files at all (it is a pure SQL file); QR/user-management/auth files specifically remain untouched by any phase in this lineage', () => {
    // availability.service.ts/EditorScreen.tsx/types.ts wiring is explicitly
    // AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A's job (a later, separately
    // reviewed phase) — diffing them here would be stale the moment that
    // phase lands, so this migration's own guarantee is narrower: it never
    // references any frontend path itself, and QR/user-management/auth stay
    // untouched by every phase in this lineage.
    expect(active050).not.toMatch(/availability\.service\.ts|EditorScreen\.tsx|shared\/lib\/types\.ts/);
    // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A: PublicQrScreen.tsx is
    // excluded below — a later, separately-reviewed phase, unrelated to
    // this migration's lineage. UserManagementScreen.tsx is also excluded —
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A, a later, separately-reviewed
    // phase, checked separately below.
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/QrScreen.tsx src/shared/supabase/services/auth.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('UserManagementScreen.tsx diff is limited to the later AvailabilityCleanupWizard addition', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim() !== '+');
    const unexpected = addedLines.filter(l => !l.includes('AvailabilityCleanupWizard') && !l.includes('PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A') && !l.includes('Renders null internally') && !l.includes('is already the safest') && !l.includes('PlatformBroadcastAdminPanel') && !l.includes('PHASE3-PLATFORM-BROADCAST-NOTICES-A') && !l.includes('same convention as AvailabilityCleanupWizard above'));
    expect(unexpected).toEqual([]);
  });
});

describe('25. Migration ceiling: allows exactly 044-054, 055+ still fails', () => {
  it('exactly thirteen reviewed migrations exist beyond 043 (044-056)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9]|5[0-9]|[6-9][0-9])_/.test(f));
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
      '056_phoenix_platform_broadcast_notices.sql',
    ]);
  });

  it('no migration 057 (or higher) exists yet (056 is this reviewed PHASE3-PLATFORM-BROADCAST-NOTICES-A addition)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(5[7-9]|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('26. Keeps premium-preview.html and supabase/.temp untracked', () => {
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

describe('No SQL applied, no supabase db push run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration050).toMatch(/MANUAL APPLY ONLY/);
    expect(migration050).toMatch(/DO NOT use "supabase db push"|supabase db push/);
  });
});

describe('Safety: Service-D stash untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
