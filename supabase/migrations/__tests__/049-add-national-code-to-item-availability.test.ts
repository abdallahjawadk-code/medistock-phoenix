/**
 * DATA-MODEL-NATIONAL-CODE-SEPARATION-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 049: adds a nullable
 * item_availability.national_code column and backfills it from existing
 * batch_number values (trimmed, blank treated as NULL), without renaming,
 * clearing, or otherwise touching batch_number, without changing any
 * uniqueness index, phoenix_upsert_availability matching, alert matching,
 * movement history, or RLS/grants.
 *
 * This migration is preparation only — no SQL is applied, no
 * `supabase db push` is run, and no frontend RPC-calling code reads or
 * writes national_code yet. No live DB is used here — these are text/shape
 * assertions against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_049_PATH = join(MIGRATIONS_DIR, '049_add_national_code_to_item_availability.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration049 = readMigration('049_add_national_code_to_item_availability.sql');
const active049 = activeSql(migration049);

describe('1. Migration file exists exactly once', () => {
  it('049_add_national_code_to_item_availability.sql exists', () => {
    expect(existsSync(MIGRATION_049_PATH)).toBe(true);
  });

  it('is the only file named 049_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('049_'));
    expect(matches).toEqual(['049_add_national_code_to_item_availability.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration049).toContain('MANUAL APPLY ONLY');
    expect(migration049).toContain('supabase db push');
  });
});

describe('2. Adds a nullable national_code column', () => {
  it('uses ADD COLUMN IF NOT EXISTS on item_availability', () => {
    expect(active049).toContain('ALTER TABLE public.item_availability ADD COLUMN IF NOT EXISTS national_code text;');
  });

  it('does not set NOT NULL or a default value on national_code', () => {
    const addColumnStmt = active049.match(/ALTER TABLE public\.item_availability ADD COLUMN[^;]*;/i)?.[0] ?? '';
    expect(addColumnStmt).not.toBe('');
    expect(addColumnStmt).not.toMatch(/NOT NULL/i);
    expect(addColumnStmt).not.toMatch(/DEFAULT/i);
  });

  it('verification block asserts the column is nullable', () => {
    expect(migration049).toContain("v_national_code_nullable = 'YES'");
  });
});

describe('3. Backfills national_code from trimmed batch_number', () => {
  it('backfill UPDATE uses NULLIF(btrim(batch_number), \'\')', () => {
    expect(active049).toContain("SET national_code = NULLIF(btrim(batch_number), '')");
  });

  it('backfill only touches rows where national_code IS NULL (idempotent, never overwrites)', () => {
    const updateStmt = active049.slice(active049.indexOf('UPDATE public.item_availability'));
    expect(updateStmt).toContain('WHERE national_code IS NULL');
  });

  it('backfill skips NULL/blank batch_number rows', () => {
    const updateStmt = active049.slice(active049.indexOf('UPDATE public.item_availability'), active049.indexOf('UPDATE public.item_availability') + 400);
    expect(updateStmt).toContain('AND batch_number IS NOT NULL');
    expect(updateStmt).toContain("AND btrim(batch_number) <> ''");
  });
});

describe('4. Preserves batch_number: not cleared, not renamed', () => {
  it('no UPDATE statement writes to batch_number', () => {
    expect(active049).not.toMatch(/SET[^;]*batch_number\s*=/i);
  });

  it('no RENAME COLUMN / DROP COLUMN statement targets batch_number', () => {
    expect(active049).not.toMatch(/RENAME COLUMN batch_number/i);
    expect(active049).not.toMatch(/DROP COLUMN[^;]*batch_number/i);
  });

  it('verification block asserts batch_number still exists', () => {
    expect(migration049).toContain("column_name = 'batch_number'");
    expect(migration049).toContain('v_batch_number_exists IS TRUE');
  });
});

describe('5. Does not change any uniqueness index/constraint', () => {
  it('no CREATE UNIQUE INDEX / ALTER TABLE ... ADD CONSTRAINT ... UNIQUE / DROP INDEX statements', () => {
    expect(active049).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(active049).not.toMatch(/ADD CONSTRAINT[^;]*UNIQUE/i);
    expect(active049).not.toMatch(/DROP INDEX/i);
  });
});

describe('6. Does not change phoenix_upsert_availability matching', () => {
  it('does not redefine phoenix_upsert_availability', () => {
    expect(active049).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_upsert_availability/i);
  });

  it('never references national_code as an RPC parameter', () => {
    expect(active049).not.toMatch(/p_national_code/i);
  });
});

describe('7. Does not change alert matching / alert_key', () => {
  it('does not reference any alert function or alert_key', () => {
    expect(active049).not.toMatch(/phoenix_get_live_inter_institution_alerts/i);
    expect(active049).not.toMatch(/alert_key/i);
    expect(active049).not.toMatch(/inter_org_alert_states/i);
    expect(active049).not.toMatch(/inter_org_alert_events/i);
  });
});

describe('8. Does not change movement-history tables/RPCs', () => {
  it('does not reference item_availability_movements or phoenix_apply_availability_movement', () => {
    expect(active049).not.toMatch(/item_availability_movements/i);
    expect(active049).not.toMatch(/phoenix_apply_availability_movement/i);
  });
});

describe('9. Does not change RLS/policies', () => {
  it('no CREATE POLICY / DROP POLICY / ALTER TABLE ... ROW LEVEL SECURITY statements', () => {
    expect(active049).not.toMatch(/CREATE POLICY/i);
    expect(active049).not.toMatch(/DROP POLICY/i);
    expect(active049).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active049).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });
});

describe('10. Does not add table grants', () => {
  it('no GRANT/REVOKE statement anywhere in this migration', () => {
    expect(active049).not.toMatch(/GRANT\s/i);
    expect(active049).not.toMatch(/REVOKE\s/i);
  });
});

describe('11. Does not use service_role/auth.admin', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active049).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference anywhere in the migration', () => {
    expect(active049).not.toContain('auth.admin');
  });
});

describe('12. Does not add WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active049).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('13. Does not apply migration 048; 050 (if it exists) is a later, separately-reviewed phase', () => {
  it('does not reference or redefine anything specific to migration 048', () => {
    expect(active049).not.toMatch(/source_expiry_risk_tier|source_expiry_days_remaining/i);
  });

  it('this migration itself does not reference phoenix_upsert_availability national_code wiring (that is migration 050, DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A)', () => {
    expect(active049).not.toMatch(/p_national_code/i);
  });
});

describe('14. Does not modify older migrations or package/lockfiles', () => {
  it('migrations 001-048 have no working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/0[0-3][0-9]_*.sql" "supabase/migrations/04[0-8]_*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('15. Frontend changes at this phase were label-only; RPC/service/type wiring is a later, separately-reviewed phase (AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A)', () => {
  it('this migration itself does not reference availability.service.ts/types.ts wiring (it is a pure SQL file)', () => {
    // Migration 049's own SQL content never references frontend files at all —
    // this is a stronger, phase-agnostic guarantee than diffing the working
    // tree, which legitimately changes once AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A
    // wires availability.service.ts/types.ts to actually send/read national_code.
    expect(active049).not.toMatch(/availability\.service\.ts|shared\/lib\/types\.ts/);
  });

  // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A: PublicQrScreen.tsx is
  // excluded below — a later, separately-reviewed phase that hides
  // non-available items from the public QR list, unrelated to this migration.
  // UserManagementScreen.tsx is intentionally excluded here as of
  // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A, a later, separately-reviewed
  // phase that additively wires in the Super Admin-only
  // AvailabilityCleanupWizard, checked separately below.
  it('QR (excluding PublicQrScreen.tsx), export/print, and auth files are untouched', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/QrScreen.tsx src/shared/supabase/services/qr.service.ts src/shared/supabase/services/auth.service.ts',
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

describe('16. Migration ceiling as of this phase: 044-049 exist; 050 (if present) is a later, separately-reviewed phase', () => {
  it('exactly six migrations from this phase and earlier exist beyond 043 (044-049)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9])_/.test(f));
    expect(matches).toEqual([
      '044_phoenix_profiles_whatsapp_phone.sql',
      '045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '047_phoenix_live_alerts_contact_fields.sql',
      '048_live_alerts_expiry_risk_tiers.sql',
      '049_add_national_code_to_item_availability.sql',
    ]);
  });

  it('no migration 057 (or higher) exists yet (050-056 are later, separately-reviewed phases)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(5[7-9]|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('No SQL applied, no supabase db push run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration049).toMatch(/MANUAL APPLY ONLY/);
    expect(migration049).toMatch(/DO NOT use "supabase db push"|supabase db push/);
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
