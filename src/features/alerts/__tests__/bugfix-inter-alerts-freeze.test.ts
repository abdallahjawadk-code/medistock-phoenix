/**
 * BUGFIX-INTER-ALERTS-FREEZE-A (superseded by UX-ALERTS-LIVE-WHATSAPP-
 * CONTACT-WIRING-A's simpler fix — see below)
 * Run: npm test -- --run
 *
 * Original root cause: `allAlerts = result.data?.alerts ?? []` produced a
 * brand-new array reference on every render while the main alert fetch was
 * still loading (`result.data` was null). The old contact-lookup wiring
 * derived an *array* (`alertOrgIds`) from `allAlerts` and used that array as
 * the dependency of a second `useAsync` call — a new array reference every
 * render meant the effect re-fired every render, resolved a new promise on
 * the next microtask, called `setData` with a new array reference, and
 * triggered another render, forever. That tight microtask loop starved the
 * event loop and froze the tab while the primary alert list was loading.
 *
 * First fix (this file's original intent): derive a content-stable *string*
 * key (`contactOrgKey`) instead of an array, and drive a manual cancellable
 * effect off that string.
 *
 * UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A then found a better fix for the
 * underlying problem this contact lookup existed to solve: migration 047
 * now resolves source_contact_phone/target_contact_phone SERVER-SIDE inside
 * the same RPC that already computes the alert list, bypassing
 * organization_status_contacts' RLS entirely. That means the SEPARATE
 * contact-fetch effect — and therefore contactOrgKey, contactsByOrg, and any
 * possibility of the original freeze recurring — is no longer needed at
 * all, not just fixed. This file's tests now prove that entire lookup path
 * is gone, rather than that its dependency array was stable.
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

describe('1. The unstable-dependency freeze mechanism no longer exists at all', () => {
  it('contactOrgKey (the stable-string-key fix) is gone — there is no separate contact-lookup memo/effect left to have an unstable dependency', () => {
    expect(alertsScreen).not.toContain('contactOrgKey');
  });

  it('contactsByOrg (the fetched-contact-map state) is gone — phone now comes directly off each alert row', () => {
    expect(alertsScreen).not.toContain('contactsByOrg');
  });

  it('the old array-typed alertOrgIds dependency remains gone (never reintroduced)', () => {
    expect(alertsScreen).not.toContain('alertOrgIds');
    expect(alertsScreen).not.toContain('contactsResult');
  });

  it('there is no second useEffect deriving/depending on any per-render-recomputed array or object from allAlerts', () => {
    // allAlerts itself may still be read (for filters/summaries), but no
    // effect anywhere keys off of it or off a value derived from it.
    expect(alertsScreen).not.toMatch(/useEffect\([^)]*allAlerts/);
  });
});

describe('2/3/4. No separate contact-fetch effect remains — nothing to gate rendering on, nothing to batch, nothing to fail', () => {
  it('useEffect is no longer imported by this screen — there is no effect left that fetches contacts', () => {
    expect(alertsScreen).not.toMatch(/import \{[^}]*useEffect[^}]*\} from 'react'/);
  });

  it('the main alert-rendering gate depends only on result.loading/result.error/ok/filtered — never on any contacts-specific loading/error state', () => {
    expect(alertsScreen).toContain("!result.loading && !result.error && ok && filtered.length > 0");
    expect(alertsScreen).not.toMatch(/contactsByOrg\.(loading|error)/);
    expect(alertsScreen).not.toMatch(/contactsLoading|contactsError/);
  });

  it('AlertCard (the per-alert component) never calls a contact fetcher — phone is a plain field read off its own alert prop', () => {
    const cardStart = alertsScreen.indexOf('function AlertCard(');
    const cardBlock = alertsScreen.slice(cardStart, cardStart + 9000);
    expect(cardBlock).not.toContain('getOrgStatusContactsForOrgs');
    expect(cardBlock).toContain('a.sourceContactPhone');
    expect(cardBlock).toContain('a.targetContactPhone');
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
  it('WhatsApp button phone is sourced from the alert row\'s contact fields and its label from the resolved org name, never an id', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('<WhatsAppContactButton'), alertsScreen.indexOf('<WhatsAppContactButton') + 300);
    expect(block).toContain("phone={target.key === 'source' ? a.sourceContactPhone : a.targetContactPhone}");
    expect(block).not.toContain('target.orgId');
  });
});

describe('11. No SQL/migrations/RPC/Edge Function added by this fix', () => {
  it('getOrgStatusContactsForOrgs is unchanged: still a plain PostgREST select', () => {
    const block = usersService.slice(usersService.indexOf('export async function getOrgStatusContactsForOrgs('));
    expect(block).not.toContain('.rpc(');
    expect(block).not.toContain('functions.invoke');
  });

  it('no migration SQL/package/lockfile files changed (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change)', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock "supabase/migrations/*.sql"',
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
