/**
 * DB-OFFICIAL-ORG-WHATSAPP-CONTACT-RPC-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 046: creates the
 * phoenix_set_my_org_whatsapp_contact(p_enabled boolean) RPC that lets an
 * eligible organization user publish their OWN already-saved
 * profiles.whatsapp_phone (migration 044) as their organization's official
 * contact number in organization_status_contacts (migration 008), or
 * withdraw it again. No frontend UI calls this RPC yet — this phase is
 * migration preparation only.
 *
 * No live DB is used — these are text/shape assertions against the SQL file
 * and the frontend source tree.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MIGRATIONS_DIR = join(__dirname, '../');
const SRC = join(__dirname, '../../../src/');
const ROOT = join(__dirname, '../../../../');
const MIGRATION_046_PATH = join(MIGRATIONS_DIR, '046_phoenix_set_my_org_whatsapp_contact_rpc.sql');

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

const migration046 = readMigration('046_phoenix_set_my_org_whatsapp_contact_rpc.sql');
const active046 = activeSql(migration046);

describe('1. Migration file exists exactly once', () => {
  it('046_phoenix_set_my_org_whatsapp_contact_rpc.sql exists', () => {
    expect(existsSync(MIGRATION_046_PATH)).toBe(true);
  });

  it('is the only file named 046_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('046_'));
    expect(matches).toEqual(['046_phoenix_set_my_org_whatsapp_contact_rpc.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration046).toContain('MANUAL APPLY ONLY');
    expect(migration046).toContain('supabase db push');
  });
});

describe('2. Creates phoenix_set_my_org_whatsapp_contact', () => {
  it('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact(p_enabled boolean DEFAULT true)', () => {
    expect(active046).toContain('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact(p_enabled boolean DEFAULT true)');
    expect(active046).toContain('LANGUAGE plpgsql');
  });
});

describe('3. Uses SECURITY DEFINER', () => {
  it('function is SECURITY DEFINER', () => {
    expect(active046).toContain('SECURITY DEFINER');
  });

  it('verification block asserts prosecdef is true', () => {
    expect(migration046).toContain('v_is_secdef IS TRUE');
    expect(migration046).toContain('SELECT prosecdef INTO v_is_secdef');
  });
});

describe('4. Uses SET search_path = public', () => {
  it('function pins the search path', () => {
    expect(active046).toContain('SET search_path = public');
  });
});

describe('5. Uses auth.uid()', () => {
  it('authentication check and profile lookup both key off auth.uid()', () => {
    expect(active046).toContain("IF auth.uid() IS NULL THEN");
    expect(active046).toContain('RAISE EXCEPTION \'not_authenticated\'');
    expect(active046).toContain('WHERE id = auth.uid()');
  });
});

describe('6. Reads current user\'s own profiles.whatsapp_phone', () => {
  it('phone source is v_profile.whatsapp_phone, never a parameter', () => {
    expect(active046).toContain('v_profile.whatsapp_phone');
  });
});

describe('7. Does not accept a phone parameter', () => {
  it('function signature has exactly one parameter, p_enabled boolean — no phone/text parameter', () => {
    expect(active046).toContain('phoenix_set_my_org_whatsapp_contact(p_enabled boolean DEFAULT true)');
    expect(active046).not.toMatch(/phoenix_set_my_org_whatsapp_contact\([^)]*p_phone/i);
  });
});

describe('8. Does not accept an arbitrary profile/user/org id parameter', () => {
  it('no uuid parameter in the function signature', () => {
    const sigMatch = active046.match(/phoenix_set_my_org_whatsapp_contact\(([^)]*)\)/);
    expect(sigMatch).not.toBeNull();
    expect(sigMatch![1]).not.toMatch(/uuid/i);
  });
});

describe('9. Requires organization_id not null', () => {
  it('raises organization_required when organization_id is NULL', () => {
    expect(active046).toContain('v_profile.organization_id IS NULL');
    expect(active046).toContain("RAISE EXCEPTION 'organization_required'");
  });
});

describe('10. Requires active profile', () => {
  it('raises profile_not_active when status is not active', () => {
    expect(active046).toContain("v_profile.status IS DISTINCT FROM 'active'");
    expect(active046).toContain("RAISE EXCEPTION 'profile_not_active'");
  });

  it('raises profile_not_found when no profile row exists', () => {
    expect(active046).toContain("RAISE EXCEPTION 'profile_not_found'");
  });
});

describe('11. Restricts eligible roles', () => {
  it('only institution_admin, hospital_admin, monthly_status_officer pass the role check', () => {
    expect(active046).toContain("v_profile.role NOT IN ('institution_admin', 'hospital_admin', 'monthly_status_officer')");
    expect(active046).toContain("RAISE EXCEPTION 'insufficient_role'");
  });

  it('does not special-case super_admin as an eligible role in this self-service RPC', () => {
    expect(active046).not.toContain("'super_admin'");
  });
});

describe('12. Updates/inserts organization_status_contacts only', () => {
  it('references only public.organization_status_contacts for writes', () => {
    expect(active046).toContain('UPDATE public.organization_status_contacts');
    expect(active046).toContain('INSERT INTO public.organization_status_contacts');
  });

  it('does not write to public.profiles anywhere in the function body', () => {
    const fnStart = active046.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact');
    const fnEnd = active046.indexOf('$$;', fnStart) + 3;
    const fnBody = active046.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(fnBody).not.toMatch(/INSERT INTO\s+public\.profiles/i);
  });
});

describe('13. Does not update profile role/status/organization_id/full_name/contact_email/login_mode', () => {
  it('the function body never issues UPDATE/INSERT against public.profiles at all', () => {
    const fnStart = active046.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact');
    const fnEnd = active046.indexOf('$$;', fnStart) + 3;
    const fnBody = active046.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(fnBody).not.toMatch(/INSERT INTO\s+public\.profiles/i);
  });

  it('none of those column names appear as a SET target within an organization_status_contacts UPDATE statement', () => {
    const fnStart = active046.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact');
    const fnEnd = active046.indexOf('$$;', fnStart) + 3;
    const fnBody = active046.slice(fnStart, fnEnd);
    const setClauses = [...fnBody.matchAll(/SET\s+([\s\S]*?)\s+WHERE/gi)].map(m => m[1]);
    for (const col of ['role', 'status', 'full_name', 'contact_email', 'login_mode']) {
      for (const clause of setClauses) {
        expect(clause).not.toMatch(new RegExp(`\\b${col}\\b\\s*=`, 'i'));
      }
    }
    // organization_id is allowed to appear as a SET target's value (e.g. `organization_id = v_profile.organization_id`
    // in a WHERE clause is not a SET target) but must never be assigned to.
    for (const clause of setClauses) {
      expect(clause).not.toMatch(/^\s*organization_id\s*=|,\s*organization_id\s*=/i);
    }
  });
});

describe('14. Validates phone format 8-15 digits', () => {
  it('server-side check mirrors the migration 044 CHECK constraint exactly', () => {
    expect(active046).toContain("v_profile.whatsapp_phone !~ '^[0-9]{8,15}$'");
    expect(active046).toContain("RAISE EXCEPTION 'invalid_whatsapp_phone'");
  });

  it('raises whatsapp_phone_required when the caller has no saved number and p_enabled is true', () => {
    expect(active046).toContain("RAISE EXCEPTION 'whatsapp_phone_required'");
  });
});

describe('15. Supports disable/deactivate via p_enabled false', () => {
  it('sets is_active = false, never deletes, when p_enabled is false', () => {
    expect(active046).toContain('IF NOT p_enabled THEN');
    expect(active046).toContain('SET is_active = false');
  });
});

describe('16. Does not delete contact rows', () => {
  it('no DELETE statement anywhere in the migration', () => {
    expect(active046).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('17/18. Does not disable or change RLS', () => {
  it('no ALTER TABLE ... ROW LEVEL SECURITY / DROP POLICY / CREATE POLICY statements', () => {
    expect(active046).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(active046).not.toMatch(/DROP POLICY/i);
    expect(active046).not.toMatch(/CREATE POLICY/i);
  });
});

describe('19/20. Grants execute to authenticated only, not anon', () => {
  it('REVOKE ALL FROM PUBLIC then GRANT EXECUTE TO authenticated', () => {
    expect(active046).toContain('REVOKE ALL ON FUNCTION public.phoenix_set_my_org_whatsapp_contact(boolean) FROM PUBLIC');
    expect(active046).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_set_my_org_whatsapp_contact(boolean) TO authenticated');
    expect(active046).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_set_my_org_whatsapp_contact\(boolean\) TO[^;]*anon/i);
  });

  it('verification block asserts authenticated has EXECUTE and anon does not', () => {
    expect(migration046).toContain('v_authenticated_has_execute IS TRUE');
    expect(migration046).toContain('v_anon_has_execute IS FALSE');
  });

  it('does not grant any table privilege on organization_status_contacts or profiles', () => {
    expect(active046).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+(TABLE\s+)?(public\.)?(organization_status_contacts|profiles)/i);
  });
});

describe('21. Does not use service_role/auth.admin', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active046).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference anywhere in the migration', () => {
    expect(active046).not.toContain('auth.admin');
  });
});

describe('22. Does not add WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active046).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('23. InterInstitutionAlertsScreen freeze safety (as of this migration-046 phase)', () => {
  it('no unstable array-typed dependency was ever reintroduced (contactOrgKey itself was later superseded and removed entirely by UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A, once contact phones moved server-side)', () => {
    const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
    expect(alertsScreen).not.toContain('alertOrgIds');
  });
});

describe('24. Does not change QR/export/print/user-management', () => {
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

  it('MyAccountScreen.tsx has no working-tree diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/account/MyAccountScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('25. Does not modify package/lockfiles', () => {
  it('package.json/lockfiles empty diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('26/27. No SQL applied locally, supabase db push not run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration046).toMatch(/MANUAL APPLY ONLY/);
    expect(migration046).toMatch(/DO NOT use "supabase db push"/);
  });
});

describe('28/29. Migration ceiling allows exactly 044/045/046/047/048, future 049+ still fails', () => {
  it('exactly five reviewed migrations exist beyond 043', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual([
      '044_phoenix_profiles_whatsapp_phone.sql',
      '045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '047_phoenix_live_alerts_contact_fields.sql',
      '048_live_alerts_expiry_risk_tiers.sql',
    ]);
  });

  it('no 049_* (or higher) migration file exists yet', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });
});
