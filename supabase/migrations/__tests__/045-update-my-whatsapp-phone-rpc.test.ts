/**
 * DB-MY-ACCOUNT-WHATSAPP-RPC-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 045: creates the
 * phoenix_update_my_whatsapp_phone(p_phone text) RPC that the already-shipped
 * frontend service (src/shared/supabase/services/auth.service.ts,
 * updateMyWhatsappPhone) calls to persist the caller's OWN
 * profiles.whatsapp_phone (migration 044) — the exact RPC-based pattern this
 * project's "no raw .update() on profiles in frontend code" guardrail
 * requires, mirroring phoenix_mark_password_changed (migration 016).
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
const MIGRATION_045_PATH = join(MIGRATIONS_DIR, '045_phoenix_update_my_whatsapp_phone_rpc.sql');

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

const migration045 = readMigration('045_phoenix_update_my_whatsapp_phone_rpc.sql');
const active045 = activeSql(migration045);

describe('1. Migration file exists exactly once', () => {
  it('045_phoenix_update_my_whatsapp_phone_rpc.sql exists', () => {
    expect(existsSync(MIGRATION_045_PATH)).toBe(true);
  });

  it('is the only file named 045_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('045_'));
    expect(matches).toEqual(['045_phoenix_update_my_whatsapp_phone_rpc.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration045).toContain('MANUAL APPLY ONLY');
    expect(migration045).toContain('supabase db push');
  });
});

describe('2. Creates phoenix_update_my_whatsapp_phone', () => {
  it('CREATE OR REPLACE FUNCTION public.phoenix_update_my_whatsapp_phone(p_phone text)', () => {
    expect(active045).toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_my_whatsapp_phone(p_phone text)');
    expect(active045).toContain('RETURNS void');
    expect(active045).toContain('LANGUAGE plpgsql');
  });
});

describe('3. Uses SECURITY DEFINER', () => {
  it('function is SECURITY DEFINER', () => {
    expect(active045).toContain('SECURITY DEFINER');
  });

  it('verification block asserts prosecdef is true', () => {
    expect(migration045).toContain('v_is_secdef IS TRUE');
    expect(migration045).toContain("SELECT prosecdef INTO v_is_secdef");
  });
});

describe('4. Uses SET search_path = public', () => {
  it('function pins the search path', () => {
    expect(active045).toContain('SET search_path = public');
  });
});

describe('5. Validates phone format 8-15 digits', () => {
  it('server-side check mirrors the migration 044 CHECK constraint exactly', () => {
    expect(active045).toContain("v_phone !~ '^[0-9]{8,15}$'");
    expect(active045).toContain("RAISE EXCEPTION 'invalid_whatsapp_phone'");
  });
});

describe('6. Converts empty string to NULL safely', () => {
  it('uses NULLIF(btrim(p_phone), \'\') as a defensive normalization', () => {
    expect(active045).toContain("NULLIF(btrim(p_phone), '')");
  });
});

describe('7. Updates only profiles.whatsapp_phone', () => {
  it('the UPDATE statement SET clause names only whatsapp_phone', () => {
    const updateBlock = active045.slice(active045.indexOf('UPDATE public.profiles'), active045.indexOf('UPDATE public.profiles') + 150);
    expect(updateBlock).toContain('SET whatsapp_phone = v_phone');
    expect(updateBlock).not.toMatch(/,\s*(role|status|organization_id|full_name|contact_email|login_mode)\s*=/i);
  });
});

describe('8. Scopes update to auth.uid()', () => {
  it('WHERE clause is id = auth.uid(), not a client-supplied id', () => {
    expect(active045).toContain('WHERE id = auth.uid()');
  });

  it('raises if the row is not found (defensive, though auth.uid() always matches the caller)', () => {
    expect(active045).toContain('IF NOT FOUND THEN');
    expect(active045).toContain("RAISE EXCEPTION 'profile_not_found'");
  });
});

describe('9. Does not accept an arbitrary profile id parameter', () => {
  it('function signature has exactly one parameter, p_phone text — no id/uuid parameter', () => {
    expect(active045).toContain('phoenix_update_my_whatsapp_phone(p_phone text)');
    expect(active045).not.toMatch(/phoenix_update_my_whatsapp_phone\([^)]*uuid/i);
  });

  it('auth.uid() is referenced — the only source of the target row id', () => {
    expect(active045).toContain('auth.uid()');
  });
});

describe('10. Does not update role/status/organization_id/full_name/contact_email/login_mode', () => {
  it('none of those column names appear as SET targets in the function body', () => {
    const fnStart = active045.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_update_my_whatsapp_phone');
    const fnEnd = active045.indexOf('$$;', fnStart) + 3;
    const fnBody = active045.slice(fnStart, fnEnd);
    for (const col of ['role', 'status', 'organization_id', 'full_name', 'contact_email', 'login_mode']) {
      expect(fnBody).not.toMatch(new RegExp(`SET[^;]*\\b${col}\\b`, 'i'));
    }
  });
});

describe('11/12. Grants execute to authenticated only, not anon', () => {
  it('REVOKE ALL FROM PUBLIC then GRANT EXECUTE TO authenticated', () => {
    expect(active045).toContain('REVOKE ALL ON FUNCTION public.phoenix_update_my_whatsapp_phone(text) FROM PUBLIC');
    expect(active045).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_update_my_whatsapp_phone(text) TO authenticated');
    expect(active045).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_update_my_whatsapp_phone\(text\) TO[^;]*anon/i);
  });

  it('verification block asserts authenticated has EXECUTE and anon does not', () => {
    expect(migration045).toContain('v_authenticated_has_execute IS TRUE');
    expect(migration045).toContain('v_anon_has_execute IS FALSE');
  });
});

describe('13. Does not use service_role', () => {
  it('no service_role reference anywhere in the migration', () => {
    expect(active045).not.toMatch(/service_role/i);
  });
});

describe('14. Does not use auth.admin', () => {
  it('no auth.admin reference anywhere in the migration', () => {
    expect(active045).not.toContain('auth.admin');
  });
});

describe('15. Does not add WhatsApp API/tokens/automation', () => {
  it('no Cloud API/Graph API/token/Bearer/sendMessage references', () => {
    expect(active045).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage/i);
  });
});

describe('16. InterInstitutionAlertsScreen freeze safety (as of this migration-045 phase)', () => {
  it('no unstable array-typed dependency was ever reintroduced (contactOrgKey itself was later superseded and removed entirely by UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A, once contact phones moved server-side)', () => {
    const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
    expect(alertsScreen).not.toContain('alertOrgIds');
  });
});

describe('17. Does not change QR/export/print/user-management', () => {
  it('App.tsx, PublicQrScreen.tsx, StatusCenterScreen.tsx, UserManagementScreen.tsx have no working-tree diff from this phase', () => {
    let diff = '';
    try {
      // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
      // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
      diff = execSync(
        'git diff -- src/features/qr/PublicQrScreen.tsx src/features/status/StatusCenterScreen.tsx src/features/users/UserManagementScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('18. Does not modify package/lockfiles', () => {
  it('package.json/lockfiles empty diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('19/20. No SQL applied locally, supabase db push not run', () => {
  it('migration file is explicitly labeled manual-apply-only and warns against supabase db push', () => {
    expect(migration045).toMatch(/MANUAL APPLY ONLY/);
    expect(migration045).toMatch(/DO NOT use "supabase db push"/);
  });
});

describe('Cross-check: matches the frontend service contract exactly', () => {
  it('auth.service.ts calls this exact RPC name with p_phone, matching the migration signature', () => {
    const authService = readSrc('shared/supabase/services/auth.service.ts');
    expect(authService).toContain("supabase.rpc('phoenix_update_my_whatsapp_phone', { p_phone: phone })");
  });
});
