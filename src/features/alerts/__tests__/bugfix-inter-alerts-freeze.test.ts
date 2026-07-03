/**
 * BUGFIX-INTER-ALERTS-FREEZE-A
 * Run: npm test -- --run
 *
 * Root cause: `allAlerts = result.data?.alerts ?? []` produced a brand-new
 * array reference on every render while the main alert fetch was still
 * loading (`result.data` was null). The old contact-lookup wiring derived an
 * *array* (`alertOrgIds`) from `allAlerts` and used that array as the
 * dependency of a second `useAsync` call — a new array reference every
 * render meant the effect re-fired every render, resolved a new promise on
 * the next microtask, called `setData` with a new array reference, and
 * triggered another render, forever. That tight microtask loop starved the
 * event loop and froze the tab while the primary alert list was loading.
 *
 * Fix: derive a content-stable *string* key (`contactOrgKey`) instead of an
 * array, and drive a manual cancellable effect off that string. Identical
 * organization sets always produce the identical string, so the effect only
 * re-runs when the actual set of organizations changes — not on every
 * render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const usersService = readSrc('shared/supabase/services/users.service.ts');

describe('1. Contact lookup uses a stable string dependency key, not a raw array dependency', () => {
  it('derives contactOrgKey as a joined/sorted string, not an array', () => {
    expect(alertsScreen).toContain('const contactOrgKey = useMemo(');
    expect(alertsScreen).toContain(".sort().join('|')");
  });

  it('the contact-fetch effect depends only on [contactOrgKey], never on a freshly-created array', () => {
    const block = alertsScreen.slice(
      alertsScreen.indexOf('useEffect(() => {\n    let cancelled = false;'),
      alertsScreen.indexOf('useEffect(() => {\n    let cancelled = false;') + 900,
    );
    expect(block).toContain('}, [contactOrgKey]);');
  });

  it('the old array-typed alertOrgIds dependency is gone', () => {
    expect(alertsScreen).not.toContain('alertOrgIds');
    expect(alertsScreen).not.toContain('contactsResult');
  });
});

describe('2/3. Contact lookup failure does not prevent alert rendering — optional/non-blocking', () => {
  it('the contact effect catches errors and falls back to an empty map instead of throwing/propagating', () => {
    const block = alertsScreen.slice(
      alertsScreen.indexOf('void getOrgStatusContactsForOrgs(ids)'),
      alertsScreen.indexOf('void getOrgStatusContactsForOrgs(ids)') + 500,
    );
    expect(block).toContain('.catch(() => {');
    expect(block).toContain('setContactsByOrg(new Map())');
  });

  it('the effect uses a cancellation flag to avoid setting state after unmount', () => {
    const block = alertsScreen.slice(
      alertsScreen.indexOf('useEffect(() => {\n    let cancelled = false;'),
      alertsScreen.indexOf('useEffect(() => {\n    let cancelled = false;') + 900,
    );
    expect(block).toContain('let cancelled = false;');
    expect(block).toContain('if (cancelled) return;');
    expect(block).toContain('cancelled = true;');
  });

  it('the main alert-rendering gate depends only on result.loading/result.error/ok/filtered — never on contactsByOrg or contact loading state', () => {
    expect(alertsScreen).toContain("!result.loading && !result.error && ok && filtered.length > 0");
    // No loading/error branch anywhere is gated on a contacts-specific loading/error flag.
    expect(alertsScreen).not.toMatch(/contactsByOrg\.(loading|error)/);
    expect(alertsScreen).not.toMatch(/contactsLoading|contactsError/);
  });
});

describe('4. No N+1 / no repeated per-render batched query', () => {
  it('getOrgStatusContactsForOrgs is called exactly once per effect run (batched ids), not inside a per-alert map/loop', () => {
    expect(alertsScreen).toContain('getOrgStatusContactsForOrgs(ids)');
    // AlertCard (the per-alert component) must never call the fetcher itself.
    const cardStart = alertsScreen.indexOf('function AlertCard(');
    const cardBlock = alertsScreen.slice(cardStart, cardStart + 4000);
    expect(cardBlock).not.toContain('getOrgStatusContactsForOrgs');
  });

  it('contactsByOrg is passed down as a prop (fetched once at screen level), not re-fetched per card', () => {
    expect(alertsScreen).toContain('contactsByOrg={contactsByOrg}');
  });
});

describe('5. Existing alert lifecycle handlers remain connected', () => {
  it('acknowledge/start-processing/resolve/dismiss/reopen/history buttons are all still wired to onAction/onHistory', () => {
    expect(alertsScreen).toContain("onClick={() => onAction('acknowledged')}");
    expect(alertsScreen).toContain("onClick={() => onAction('in_progress')}");
    expect(alertsScreen).toContain("onClick={() => onAction('resolved')}");
    expect(alertsScreen).toContain("onClick={() => onAction('dismissed')}");
    expect(alertsScreen).toContain("onClick={() => onAction('open')}");
    expect(alertsScreen).toContain('onClick={onHistory}');
  });
});

describe('6. Existing alert lifecycle permission gates remain unchanged', () => {
  it('TRANSITION_PERMISSION map and canTransition gating are untouched', () => {
    expect(alertsScreen).toContain("open:         'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("acknowledged: 'inter_institution_alerts.acknowledge'");
    expect(alertsScreen).toContain("in_progress:  'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("resolved:     'inter_institution_alerts.resolve'");
    expect(alertsScreen).toContain("dismissed:    'inter_institution_alerts.dismiss'");
    expect(alertsScreen).toContain('canTransition(');
  });
});

describe('7. No fake phone numbers added', () => {
  it('no hardcoded phone constant introduced by this fix', () => {
    expect(alertsScreen).not.toMatch(/['"`]\+?\d{8,15}['"`]/);
  });
});

describe('8/9. No WhatsApp API/tokens/automation, no automatic sending', () => {
  it('no API/Cloud API/token/Bearer references, no .click()/auto-open', () => {
    expect(alertsScreen).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
    expect(alertsScreen).not.toContain('Bearer ');
    expect(alertsScreen).not.toContain('.click()');
  });
});

describe('10. No raw UUIDs displayed in UI', () => {
  it('WhatsApp button phone/label still sourced from contactsByOrg map and resolved org name, not ids', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('<WhatsAppContactButton'), alertsScreen.indexOf('<WhatsAppContactButton') + 300);
    expect(block).toContain('contactsByOrg.get(target.orgId)?.phone');
  });
});

describe('11. No SQL/migrations/RPC/Edge Function added by this fix', () => {
  it('getOrgStatusContactsForOrgs is unchanged: still a plain PostgREST select', () => {
    const block = usersService.slice(usersService.indexOf('export async function getOrgStatusContactsForOrgs('));
    expect(block).not.toContain('.rpc(');
    expect(block).not.toContain('functions.invoke');
  });

  it('no migration/package/lockfile files changed', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock supabase/migrations/',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('12. Routes unchanged', () => {
  it('InterInstitutionAlertsScreen has no route/onNavigate changes', () => {
    expect(alertsScreen).not.toContain('onNavigate');
  });
});

describe('13. QR unchanged', () => {
  it('PublicQrScreen not touched by this fix', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/qr/PublicQrScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('14. Export/print unchanged', () => {
  it('InterInstitutionAlertsScreen still has no export/print logic', () => {
    expect(alertsScreen).not.toContain('exportCsv');
    expect(alertsScreen).not.toContain('printReport');
    expect(alertsScreen).not.toContain('window.print');
  });
});

describe('15. User-management lifecycle logic unchanged', () => {
  it('UserManagementScreen not touched by this fix', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('16. Service-D untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

describe('17. premium-preview.html untouched', () => {
  it('remains untracked only', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});

describe('18. supabase/.temp not staged', () => {
  it('no staged entry for supabase/.temp', () => {
    let staged = '';
    try {
      staged = execSync('git diff --cached --name-only -- supabase/.temp', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(staged.trim()).toBe('');
  });
});
