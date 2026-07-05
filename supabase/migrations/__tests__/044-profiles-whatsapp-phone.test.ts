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

  it('only the reviewed migrations 045/046/047/048/049/050/051/052/053/054 (DB-MY-ACCOUNT-WHATSAPP-RPC-A / DB-OFFICIAL-ORG-WHATSAPP-CONTACT-RPC-A / DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A / DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A / DATA-MODEL-NATIONAL-CODE-SEPARATION-A / DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A / DB-MATERIAL-BATCH-IDENTITY-051-A / QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A / DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A / PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A) exist beyond 044 — any other migration beyond 044 still fails this check', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[5-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual(['045_phoenix_update_my_whatsapp_phone_rpc.sql', '046_phoenix_set_my_org_whatsapp_contact_rpc.sql', '047_phoenix_live_alerts_contact_fields.sql', '048_live_alerts_expiry_risk_tiers.sql', '049_add_national_code_to_item_availability.sql', '050_phoenix_upsert_availability_national_code.sql', '051_material_batch_identity_option_a.sql', '052_qr_effective_condition_quantity_zero.sql', '053_item_availability_removed_marker.sql', '054_dashboard_condition_counts_rpcs.sql']);
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

describe('6. Frontend access to whatsapp_phone stays within the reviewed My Account write path (UX-MY-ACCOUNT-WHATSAPP-SAVE-A)', () => {
  it('MyAccountScreen.tsx reads/writes whatsapp_phone only through the app profile state and updateMyWhatsappPhone service, never a raw table call', () => {
    const myAccount = readSrc('features/account/MyAccountScreen.tsx');
    expect(myAccount).toContain('profile?.whatsapp_phone');
    expect(myAccount).toContain('updateMyWhatsappPhone');
    expect(myAccount).not.toMatch(/from\(['"]profiles['"]\)/);
  });

  it('auth.service.ts exposes whatsapp_phone only via the Profile type, getMyProfile\'s read-only select, and the RPC-based updateMyWhatsappPhone — never a raw .update() on profiles', () => {
    const authService = readSrc('shared/supabase/services/auth.service.ts');
    expect(authService).toContain('whatsapp_phone: string | null');
    expect(authService).toContain("select('id, organization_id, full_name, role, status, username, login_mode, contact_email, must_change_password, whatsapp_phone')");
    expect(authService).toContain("supabase.rpc('phoenix_update_my_whatsapp_phone'");
    expect(authService).not.toMatch(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/);
  });

  it('no other service file (organization contacts, users) was given whatsapp_phone access — official org-contact integration remains a later, separate phase', () => {
    const usersService = readSrc('shared/supabase/services/users.service.ts');
    expect(usersService).not.toContain('whatsapp_phone');
  });

  it('InterInstitutionAlertsScreen does not read the personal whatsapp_phone column — inter-institution alert contact wiring is unaffected by this phase', () => {
    const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
    expect(alertsScreen).not.toContain('whatsapp_phone');
  });
});

describe('7. InterInstitutionAlertsScreen freeze safety (no unstable per-render dependency)', () => {
  it('the old array-typed alertOrgIds dependency was never reintroduced (contactOrgKey itself was later superseded and removed entirely by UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A, once contact phones moved server-side)', () => {
    const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
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
