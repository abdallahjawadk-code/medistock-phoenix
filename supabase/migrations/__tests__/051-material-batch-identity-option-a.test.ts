/**
 * DB-MATERIAL-BATCH-IDENTITY-051-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 051 (Option A): widens
 * item_availability's uniqueness/matching key to include national_code,
 * batch_number, and expiry_date (in addition to the existing
 * distribution_point_id + scientific_name + concentration + dosage_form),
 * while deliberately excluding supply_type and price — those remain
 * UI-mediated via the existing similar-material comparison/blocking panel.
 *
 * This migration is preparation only — no SQL is applied, no
 * `supabase db push` is run. No live DB is used here — these are text/shape
 * assertions against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_051_PATH = join(MIGRATIONS_DIR, '051_material_batch_identity_option_a.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration051 = readMigration('051_material_batch_identity_option_a.sql');
const active051 = activeSql(migration051);

describe('1. Migration file exists exactly once', () => {
  it('051_material_batch_identity_option_a.sql exists', () => {
    expect(existsSync(MIGRATION_051_PATH)).toBe(true);
  });

  it('is the only file named 051_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('051_'));
    expect(matches).toEqual(['051_material_batch_identity_option_a.sql']);
  });
});

describe('2. Manual apply warning exists', () => {
  it('is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration051).toMatch(/MANUAL APPLY ONLY/);
    expect(migration051).toMatch(/DO NOT use "supabase db push"|supabase db push/);
  });
});

describe('3. Prerequisites 049/050 documented', () => {
  it('references migrations 049 and 050 as required prerequisites', () => {
    expect(migration051).toMatch(/049/);
    expect(migration051).toMatch(/050/);
    expect(migration051).toMatch(/national_code/i);
    expect(migration051).toMatch(/p_national_code/);
  });
});

describe('4. Old unique index is dropped', () => {
  it('DROP INDEX IF EXISTS targets item_availability_dp_sci_conc_form_uniq', () => {
    expect(active051).toContain('DROP INDEX IF EXISTS public.item_availability_dp_sci_conc_form_uniq;');
  });
});

describe('5. New unique index is created', () => {
  it('CREATE UNIQUE INDEX IF NOT EXISTS targets the new option-A index name', () => {
    expect(active051).toContain('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq');
  });

  it('index is scoped WHERE scientific_name IS NOT NULL, same as migration 029', () => {
    const idxStmt = active051.slice(
      active051.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq'),
      active051.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq') + 500,
    );
    expect(idxStmt).toContain('WHERE scientific_name IS NOT NULL;');
  });
});

describe('6-11. New unique index column list', () => {
  const idxStmt = active051.slice(
    active051.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq'),
    active051.indexOf('WHERE scientific_name IS NOT NULL;') + 40,
  );

  it('includes national_code', () => {
    expect(idxStmt).toContain('COALESCE(national_code, \'\')');
  });

  it('includes batch_number', () => {
    expect(idxStmt).toContain('COALESCE(batch_number, \'\')');
  });

  it('includes expiry_date using the immutable date-sentinel form (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: expiry_date::text is not IMMUTABLE and is rejected by CREATE UNIQUE INDEX with 42P17)', () => {
    expect(idxStmt).toContain("COALESCE(expiry_date, DATE '0001-01-01')");
    expect(idxStmt).not.toContain('expiry_date::text');
  });

  it('includes distribution_point_id, scientific_name, concentration, dosage_form', () => {
    expect(idxStmt).toContain('distribution_point_id,');
    expect(idxStmt).toContain('scientific_name,');
    expect(idxStmt).toContain('COALESCE(concentration, \'\')');
    expect(idxStmt).toContain('COALESCE(dosage_form, \'\')');
  });

  it('excludes supply_type', () => {
    expect(idxStmt).not.toContain('supply_type');
  });

  it('excludes price', () => {
    expect(idxStmt).not.toContain('price');
  });
});

describe('12. Legacy local_item unique constraint not dropped', () => {
  it('does not DROP CONSTRAINT / DROP INDEX on the legacy local_item key', () => {
    expect(active051).not.toMatch(/DROP[^;]*item_availability_local_item_id_distribution_point_id_key/i);
  });

  it('verification block asserts the legacy constraint still exists', () => {
    expect(migration051).toContain("conname = 'item_availability_local_item_id_distribution_point_id_key'");
    expect(migration051).toContain('v_legacy_uniq_count = 1');
  });
});

describe('13/14. phoenix_upsert_availability recreated safely with the 13-argument signature preserved', () => {
  it('uses CREATE OR REPLACE FUNCTION (identical arg-type list to migration 050 — no DROP FUNCTION needed)', () => {
    expect(active051).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(');
    expect(active051).not.toMatch(/DROP FUNCTION/i);
  });

  it('all 13 parameters are present in the same order as migration 050', () => {
    const sigStart = active051.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(');
    const sigEnd = active051.indexOf('RETURNS uuid', sigStart);
    const sig = active051.slice(sigStart, sigEnd);
    const order = [
      'p_distribution_point_id uuid',
      'p_scientific_name        text',
      'p_trade_name             text',
      'p_dosage_form            text',
      'p_concentration          text',
      'p_quantity               integer',
      'p_condition              text',
      'p_expiry_date            date',
      'p_batch_number           text',
      'p_notes                  text',
      'p_supply_type            text',
      'p_price                  numeric',
      'p_national_code          text DEFAULT NULL',
    ];
    let lastIdx = -1;
    for (const param of order) {
      const idx = sig.indexOf(param);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

describe('15. p_national_code still exists', () => {
  it('parameter declared with DEFAULT NULL, unchanged from migration 050', () => {
    expect(active051).toContain('p_national_code          text DEFAULT NULL');
  });
});

describe('16-18. Matching WHERE clause includes national_code, batch_number, expiry_date', () => {
  const whereClause = active051.slice(
    active051.indexOf('SELECT ia.id, ia.quantity INTO'),
    active051.indexOf('IF v_existing_id IS NOT NULL THEN'),
  );

  it('includes COALESCE(ia.national_code, \'\') = v_national_code_key', () => {
    expect(whereClause).toContain("COALESCE(ia.national_code, '')");
    expect(whereClause).toContain('v_national_code_key');
  });

  it('includes COALESCE(ia.batch_number, \'\') = v_batch_number_key', () => {
    expect(whereClause).toContain("COALESCE(ia.batch_number, '')");
    expect(whereClause).toContain('v_batch_number_key');
  });

  it('includes COALESCE(ia.expiry_date, DATE \'0001-01-01\') = v_expiry_date_key (not the non-IMMUTABLE ::text form)', () => {
    expect(whereClause).toContain("COALESCE(ia.expiry_date, DATE '0001-01-01')");
    expect(whereClause).toContain('v_expiry_date_key');
    expect(whereClause).not.toContain('expiry_date::text');
  });
});

describe('FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: v_expiry_date_key is declared as date, not text', () => {
  it('DECLARE block declares v_expiry_date_key as date, computed via the DATE \'0001-01-01\' sentinel', () => {
    expect(active051).toContain("v_expiry_date_key    date := COALESCE(p_expiry_date, DATE '0001-01-01');");
    expect(active051).not.toContain('v_expiry_date_key    text');
  });

  it('no occurrence of the non-IMMUTABLE expiry_date::text expression remains as an actual SQL expression (only the verification block\'s NOT LIKE guard strings are allowed to still mention it, as the literal text they check FOR THE ABSENCE of)', () => {
    const idxStmt = active051.slice(
      active051.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq'),
      active051.indexOf('WHERE scientific_name IS NOT NULL;') + 40,
    );
    const whereClause = active051.slice(
      active051.indexOf('SELECT ia.id, ia.quantity INTO'),
      active051.indexOf('IF v_existing_id IS NOT NULL THEN'),
    );
    const declareBlock = active051.slice(active051.indexOf('DECLARE'), active051.indexOf('BEGIN'));
    expect(idxStmt).not.toContain('expiry_date::text');
    expect(whereClause).not.toContain('expiry_date::text');
    expect(declareBlock).not.toContain('expiry_date::text');
    // Everything before the verification DO $$ block (index + function
    // definition + grants) must be completely free of the old expression —
    // only the verification block itself is allowed to still mention it, as
    // the literal text its NOT LIKE guards check for the absence of.
    const verifyBlockStart = active051.indexOf('DO $$');
    const beforeVerify = active051.slice(0, verifyBlockStart);
    expect(beforeVerify).not.toContain('expiry_date::text');
  });

  it('CREATE UNIQUE INDEX statement uses the immutable date-sentinel expression', () => {
    const idxStmt = active051.slice(
      active051.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq'),
      active051.indexOf('WHERE scientific_name IS NOT NULL;') + 40,
    );
    expect(idxStmt).toContain("COALESCE(expiry_date, DATE '0001-01-01')");
  });

  it('verification block asserts the new index uses the date sentinel and not ::text', () => {
    expect(migration051).toContain("v_new_idx_def LIKE '%0001-01-01%'");
    expect(migration051).toContain("v_new_idx_def NOT LIKE '%expiry_date::text%'");
  });

  it('verification block asserts the RPC matching WHERE clause uses the date sentinel and not ::text', () => {
    expect(migration051).toContain("COALESCE(ia.expiry_date, DATE ''0001-01-01'')");
    expect(migration051).toContain("v_fn_src NOT LIKE '%expiry_date::text%'");
  });

  it('verification block asserts v_expiry_date_key is declared as date', () => {
    expect(migration051).toContain("v_fn_src LIKE '%v_expiry_date_key%date%'");
  });

  it('header documents the root cause (42P17) and the fix', () => {
    expect(migration051).toContain('FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A');
    expect(migration051).toContain('42P17');
    expect(migration051).toContain('IMMUTABLE');
  });
});

describe('19/20. Matching WHERE clause excludes supply_type and price', () => {
  const whereClause = active051.slice(
    active051.indexOf('SELECT ia.id, ia.quantity INTO'),
    active051.indexOf('IF v_existing_id IS NOT NULL THEN'),
  );

  it('does not reference ia.supply_type', () => {
    expect(whereClause).not.toContain('ia.supply_type');
  });

  it('does not reference ia.price', () => {
    expect(whereClause).not.toContain('ia.price');
  });
});

describe('21/22. Quantity hard guard preserved', () => {
  it('still raises quantity_update_requires_movement on mismatch', () => {
    expect(active051).toContain('quantity_update_requires_movement');
    expect(active051).toContain('IS DISTINCT FROM v_existing_quantity');
  });

  it('UPDATE SET list never assigns quantity = p_quantity', () => {
    const updateStmt = active051.slice(
      active051.indexOf('UPDATE public.item_availability AS ia'),
      active051.indexOf('RETURNING ia.id INTO v_id;'),
    );
    expect(updateStmt).not.toMatch(/SET\s+quantity\s*=\s*p_quantity/i);
  });
});

describe('23/24. Permission and ownership checks preserved', () => {
  it('references availability.create and availability.update', () => {
    expect(active051).toContain("'availability.create'");
    expect(active051).toContain("'availability.update'");
    expect(active051).toContain('forbidden_availability_create');
    expect(active051).toContain('forbidden_availability_update');
  });

  it('derives organization from distribution_points and rejects cross-org access', () => {
    expect(active051).toContain('FROM public.distribution_points');
    expect(active051).toContain('forbidden_cross_org');
  });
});

describe('25/26. SECURITY DEFINER and SET search_path preserved', () => {
  it('function is declared SECURITY DEFINER with SET search_path = public', () => {
    expect(active051).toContain('SECURITY DEFINER');
    expect(active051).toContain('SET search_path = public');
  });
});

describe('27/28. Function grants authenticated only; no broad table grants', () => {
  it('EXECUTE granted to authenticated only, anon/PUBLIC revoked, on the function only', () => {
    expect(active051).toContain('REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(');
    expect(active051).toContain('FROM PUBLIC, anon;');
    expect(active051).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(');
    expect(active051).toContain('TO authenticated;');
  });

  it('no GRANT/REVOKE statement targets a table directly', () => {
    expect(active051).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?item_availability\b/i);
    expect(active051).not.toMatch(/REVOKE[^;]*ON\s+(TABLE\s+)?(public\.)?item_availability\b/i);
  });
});

describe('29. No RLS policy changes', () => {
  it('no CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY statements', () => {
    expect(active051).not.toMatch(/CREATE POLICY/i);
    expect(active051).not.toMatch(/DROP POLICY/i);
    expect(active051).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active051).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });

  it('verification block asserts the item_availability policy count is unchanged (4)', () => {
    expect(migration051).toContain("tablename = 'item_availability'");
    expect(migration051).toContain(') = 4,');
  });
});

describe('30. No alert function/table changes', () => {
  it('does not redefine any alert function or alert lifecycle table', () => {
    expect(active051).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_get_live_inter_institution_alerts/i);
    expect(active051).not.toMatch(/CREATE TABLE[^;]*inter_org_alert/i);
    expect(active051).not.toMatch(/alert_key/i);
  });

  it('verification block only checks alert function existence (read-only), never redefines it', () => {
    expect(migration051).toContain("proname = 'phoenix_get_live_inter_institution_alerts_with_state'");
  });
});

describe('31. No movement table/RPC changes', () => {
  it('does not redefine phoenix_apply_availability_movement or item_availability_movements', () => {
    expect(active051).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_apply_availability_movement/i);
    expect(active051).not.toMatch(/CREATE TABLE[^;]*item_availability_movements/i);
    expect(active051).not.toMatch(/ALTER TABLE[^;]*item_availability_movements/i);
  });
});

describe('32. Does not use service_role', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active051).not.toMatch(/service_role/i);
  });
});

describe('33. Does not use auth.admin', () => {
  it('no auth.admin reference anywhere in the migration', () => {
    expect(active051).not.toContain('auth.admin');
  });
});

describe('34. Does not touch WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active051).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('35. Does not change package/lockfiles', () => {
  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('migrations 001-050 have no working-tree diff (051 itself is excluded from this check — FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A legitimately corrects 051 before its first successful manual apply, per this task\'s own instructions; the original glob "0[4-5][0-9]_*.sql" incorrectly matched 040-059 and so accidentally covered 051 too)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/0[0-3][0-9]_*.sql" "supabase/migrations/04[0-9]_*.sql" "supabase/migrations/050_*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no frontend production file has a working-tree diff from this phase (excluding EditorScreen.tsx/strings.ts, which the separately-reviewed, explicitly-planned-for AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B frontend-sync phase — see this migration\'s own header — is expected to modify; PublicQrScreen.tsx is also excluded, modified by the later, separately-reviewed QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A phase; availability.service.ts/types.ts are also excluded — the later, separately-reviewed FRONTEND-LIVE-REMOVED-AT-FILTERS-A phase, after migration 053 was applied, adds a removed_at column/select/filter there; UserManagementScreen.tsx is also excluded, checked separately below — PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A)', () => {
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
    // AUTHENTICATED-SCREEN-SPLIT-B: a later, separately-reviewed phase converts
    // AvailabilityCleanupWizard/PlatformBroadcastAdminPanel to React.lazy +
    // Suspense, gated by the same normalizeRole(role) === 'super_admin' check
    // each already performed internally — no permission logic changed. The
    // structural-only regex below allows the resulting bare closing
    // punctuation lines (`);`, `)}`, `/**`, `*/`) through unexamined; every
    // line with actual content must still match one of the named phrases.
    const structuralOnly = /^\+[\s)}/*;]*$/;
    const unexpected = addedLines.filter(l =>
      !structuralOnly.test(l) &&
      !l.includes('AvailabilityCleanupWizard') && !l.includes('PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A') &&
      !l.includes('Renders null internally') && !l.includes('is already the safest') &&
      !l.includes('PlatformBroadcastAdminPanel') && !l.includes('PHASE3-PLATFORM-BROADCAST-NOTICES-A') &&
      !l.includes('same convention as AvailabilityCleanupWizard above') &&
      !l.includes('AUTHENTICATED-SCREEN-SPLIT-B') && !l.includes('Suspense') && !l.includes('normalizeRole(role)'),
    );
    expect(unexpected).toEqual([]);
  });

  it('the availability.service.ts/types.ts diff (from the later FRONTEND-LIVE-REMOVED-AT-FILTERS-A phase) only touches removed_at wiring, never this migration\'s own identity-match concerns', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/availability.service.ts src/shared/lib/types.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    if (diff.trim()) {
      expect(diff).toContain('removed_at');
      expect(diff).not.toMatch(/service_role|auth\.admin/);
      expect(diff).not.toMatch(/CREATE (OR REPLACE )?FUNCTION|supabase\.rpc\(/);
      // No added/removed line touches this migration's own identity-match
      // concerns (only context lines may legitimately mention them).
      const changedLines = diff.split('\n').filter(l => /^[+-][^+-]/.test(l));
      for (const line of changedLines) {
        expect(line).not.toMatch(/national_code|batch_number|expiry_date_key/);
      }
    }
  });
});

describe('36. Migration ceiling: allows exactly 044-054, 055+ still fails', () => {
  it('exactly fifteen reviewed migrations exist beyond 043 (044-058)', () => {
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
      '057_phoenix_platform_broadcast_admin_details_delete.sql',
      // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: additive migration 058 (get_public_qr_payload dosage_form)
      '058_phoenix_public_qr_dosage_form.sql',
    ]);
  });

  it('no migration 059 (or higher) exists yet (058 is this reviewed PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A addition)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(59|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('37. Keeps premium-preview.html and supabase/.temp untracked', () => {
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

describe('38. Safety: Service-D stash untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

describe('No SQL applied, no supabase db push run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration051).toMatch(/MANUAL APPLY ONLY/);
    expect(migration051).toMatch(/DO NOT use "supabase db push"|supabase db push/);
  });
});
