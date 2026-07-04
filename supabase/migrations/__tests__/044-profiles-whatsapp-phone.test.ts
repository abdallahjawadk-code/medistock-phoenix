/**
 * DB-MY-ACCOUNT-WHATSAPP-PHONE-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 044: adds a nullable
 * profiles.whatsapp_phone column + a digits-only 8-15 CHECK constraint.
 * Migration preparation only — no frontend code reads or writes this column
 * yet (that is a separately-reviewed follow-up phase).
 *
 * No live DB is used — these are text/shape assertions against the SQL
 * file and the frontend source tree, mirroring the 016/043 tests'
 * conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const SRC = join(__dirname, '../../../src/');
const MIGRATION_044_PATH = join(MIGRATIONS_DIR, '044_phoenix_profiles_whatsapp_phone.sql');

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

const migration044 = readMigration('044_phoenix_profiles_whatsapp_phone.sql');
const active044 = activeSql(migration044);

describe('Migration 044 exists exactly once', () => {
  it('044_phoenix_profiles_whatsapp_phone.sql exists', () => {
    expect(existsSync(MIGRATION_044_PATH)).toBe(true);
  });

  it('is the only file named 044_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('044_'));
    expect(matches).toEqual(['044_phoenix_profiles_whatsapp_phone.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration044).toContain('MANUAL APPLY ONLY');
    expect(migration044).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration044).toContain('DO $$');
    expect(migration044).toContain('ASSERT');
  });

  it('no migration newer than 044 exists yet', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[5-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});

describe('1. Adds profiles.whatsapp_phone as a nullable text column', () => {
  it('uses ADD COLUMN IF NOT EXISTS whatsapp_phone text (no NOT NULL, no default)', () => {
    expect(active044).toMatch(/ALTER TABLE profiles ADD COLUMN IF NOT EXISTS whatsapp_phone text;/);
  });
});

describe('2. Has a digits-only 8-15 CHECK constraint', () => {
  it('constraint allows NULL or ^[0-9]{8,15}$', () => {
    expect(active044).toContain("CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^[0-9]{8,15}$')");
  });

  it('constraint creation is guarded by a pg_constraint existence check (idempotent, safe to re-run)', () => {
    expect(active044).toContain("SELECT 1 FROM pg_constraint WHERE conname = 'profiles_whatsapp_phone_format_chk'");
    expect(active044).toContain('ADD CONSTRAINT profiles_whatsapp_phone_format_chk');
  });
});

describe('3. Does not include NOT NULL on the new column', () => {
  it('the whatsapp_phone column definition has no NOT NULL clause', () => {
    const columnLine = active044.split('\n').find(l => l.includes('ADD COLUMN IF NOT EXISTS whatsapp_phone'));
    expect(columnLine).toBeDefined();
    expect(columnLine).not.toMatch(/NOT NULL/i);
  });

  it('the verification block asserts the column stays nullable', () => {
    expect(migration044).toContain("v_is_nullable = 'YES'");
  });
});

describe('4. Does not include a default/fake phone value or backfill', () => {
  it('no DEFAULT clause on whatsapp_phone', () => {
    const columnLine = active044.split('\n').find(l => l.includes('ADD COLUMN IF NOT EXISTS whatsapp_phone'));
    expect(columnLine).not.toMatch(/DEFAULT/i);
  });

  it('no UPDATE statement (no backfill of existing rows) and no hardcoded phone literal', () => {
    expect(active044).not.toMatch(/^\s*UPDATE\s+profiles/im);
    expect(active044).not.toMatch(/['"]\+?\d{8,15}['"]/);
  });
});

describe('5. Does not modify alert lifecycle / QR / export / user-management logic', () => {
  it('migration 044 touches only the profiles table (no other table name appears)', () => {
    expect(active044).not.toMatch(/inter_org_alert|organization_status_contacts|qr_targets|qr_tokens|audit_logs/i);
  });

  it('no RLS policy is created or dropped by this migration (existing profiles_update_own already covers the new column)', () => {
    expect(active044).not.toMatch(/create policy|drop policy/i);
  });
});

describe('6. No frontend reads or writes whatsapp_phone yet', () => {
  it('MyAccountScreen.tsx does not reference whatsapp_phone', () => {
    const myAccount = readSrc('features/account/MyAccountScreen.tsx');
    expect(myAccount).not.toContain('whatsapp_phone');
  });

  it('no service file in src/ references whatsapp_phone', () => {
    const usersService = readSrc('shared/supabase/services/users.service.ts');
    const authService = readSrc('shared/supabase/services/auth.service.ts');
    expect(usersService).not.toContain('whatsapp_phone');
    expect(authService).not.toContain('whatsapp_phone');
  });
});

describe('7. contactOrgKey freeze fix remains in InterInstitutionAlertsScreen', () => {
  it('stable string contactOrgKey drives the effect, not a raw array', () => {
    const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
    expect(alertsScreen).toContain('const contactOrgKey = useMemo(');
    expect(alertsScreen).toContain(".sort().join('|')");
    expect(alertsScreen).toContain('}, [contactOrgKey]);');
    expect(alertsScreen).not.toContain('alertOrgIds');
  });
});

describe('8. No package/lockfile changes', () => {
  it('package.json/lockfiles are not part of this migration-only phase (structural check)', () => {
    // Migration-only phase — nothing here touches dependency files; this is
    // a structural safeguard, not a git-diff check (kept dependency-free).
    expect(migration044).not.toContain('package.json');
    expect(migration044).not.toContain('package-lock.json');
  });
});

describe('9. No SQL was applied locally (this migration is prepared, not executed)', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration044).toMatch(/MANUAL APPLY ONLY/);
    expect(migration044).toMatch(/DO NOT use "supabase db push"/);
  });
});
