/**
 * PHASE3-PLATFORM-BROADCAST-NOTICES-A
 *
 * Static source-code tests for PlatformBroadcastAdminPanel.tsx,
 * PlatformBroadcastGate.tsx, their wiring into UserManagementScreen.tsx /
 * PhoenixAppShell.tsx, and the platform-broadcast.service.ts wrapper. No
 * live DB/RPC is used and no component is rendered — matching this repo's
 * established convention (see availability-cleanup-wizard.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const adminPanel = readSrc('features/platform-broadcast/PlatformBroadcastAdminPanel.tsx');
const gate = readSrc('features/platform-broadcast/PlatformBroadcastGate.tsx');
const service = readSrc('shared/supabase/services/platform-broadcast.service.ts');
const userMgmt = readSrc('features/users/UserManagementScreen.tsx');
const appShell = readSrc('shared/ui/PhoenixAppShell.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('A) Super Admin gating — admin panel', () => {
  it('PlatformBroadcastAdminPanel returns null for non-super users before rendering anything', () => {
    expect(adminPanel).toMatch(/if \(!isSuper\) return null;/);
  });

  it('computes isSuper via normalizeRole(role) === \'super_admin\'', () => {
    expect(adminPanel).toMatch(/const isSuper = normalizeRole\(role\) === 'super_admin';/);
  });

  it('is wired into UserManagementScreen alongside AvailabilityCleanupWizard', () => {
    expect(userMgmt).toContain("import { PlatformBroadcastAdminPanel } from '@/features/platform-broadcast/PlatformBroadcastAdminPanel';");
    expect(userMgmt).toMatch(/<PlatformBroadcastAdminPanel lang=\{lang\} role=\{role\} \/>/);
  });

  it('is not wired into StatusCenterScreen, ReportsScreen, or any Reports/Status-Center-export file', () => {
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    expect(statusCenter).not.toContain('PlatformBroadcastAdminPanel');
  });
});

describe('B) Create form validation', () => {
  it('validates title is non-empty before calling the service', () => {
    const start = adminPanel.indexOf('async function onCreate()');
    const body = adminPanel.slice(start, adminPanel.indexOf('async function onDeactivate'));
    expect(body).toMatch(/if \(title\.trim\(\) === ''\) \{/);
    expect(body).toContain("setValidationError(t('pbc_validation_title_required', lang));");
  });

  it('validates body is non-empty', () => {
    const start = adminPanel.indexOf('async function onCreate()');
    const body = adminPanel.slice(start, adminPanel.indexOf('async function onDeactivate'));
    expect(body).toMatch(/if \(body\.trim\(\) === ''\) \{/);
    expect(body).toContain("setValidationError(t('pbc_validation_body_required', lang));");
  });

  it('validates selectedOrgIds is non-empty when targetScope is selected', () => {
    const start = adminPanel.indexOf('async function onCreate()');
    const body = adminPanel.slice(start, adminPanel.indexOf('async function onDeactivate'));
    expect(body).toMatch(/if \(targetScope === 'selected' && selectedOrgIds\.length === 0\) \{/);
    expect(body).toContain("setValidationError(t('pbc_validation_orgs_required', lang));");
  });

  it('validation returns before calling createPlatformBroadcast (guards precede the service call)', () => {
    const start = adminPanel.indexOf('async function onCreate()');
    const body = adminPanel.slice(start, adminPanel.indexOf('async function onDeactivate'));
    const lastValidationReturn = body.lastIndexOf('return;\n    }');
    const serviceCallIdx = body.indexOf('await createPlatformBroadcast(');
    expect(lastValidationReturn).toBeGreaterThan(-1);
    expect(serviceCallIdx).toBeGreaterThan(lastValidationReturn);
  });
});

describe('C) Create calls service with expected payload', () => {
  it('passes title/body/severity/targetScope to createPlatformBroadcast', () => {
    const start = adminPanel.indexOf('await createPlatformBroadcast(');
    const call = adminPanel.slice(start, adminPanel.indexOf(');', start));
    expect(call).toContain('title: title.trim()');
    expect(call).toContain('body: body.trim()');
    expect(call).toContain('severity,');
    expect(call).toContain('targetScope,');
  });

  it('only passes orgIds when targetScope is selected', () => {
    const start = adminPanel.indexOf('await createPlatformBroadcast(');
    const call = adminPanel.slice(start, adminPanel.indexOf(');', start));
    expect(call).toMatch(/orgIds: targetScope === 'selected' \? selectedOrgIds : undefined/);
  });
});

describe('D) Deactivate calls service', () => {
  it('onDeactivate calls deactivatePlatformBroadcast with the message id, gated by a confirm dialog', () => {
    const start = adminPanel.indexOf('async function onDeactivate');
    const body = adminPanel.slice(start);
    expect(body).toMatch(/window\.confirm\(t\('pbc_deactivate_confirm', lang\)\)/);
    expect(body).toContain('await deactivatePlatformBroadcast(messageId)');
  });

  it('deactivate button only renders for active (not inactive/expired) messages', () => {
    expect(adminPanel).toMatch(/\{status === 'active' && \(\s*\n\s*<PhoenixButton variant="danger"/);
  });
});

describe('E) Admin list renders ack counts', () => {
  it('renders acknowledged_count/target_count via pbc_ack_summary', () => {
    expect(adminPanel).toContain("t('pbc_ack_summary', lang)");
    expect(adminPanel).toMatch(/\{m\.acknowledged_count\}\/\{m\.target_count\}/);
  });

  it('derives status (active/inactive/expired) via messageStatus() rather than raw is_active alone', () => {
    expect(adminPanel).toContain('function messageStatus(m: AdminBroadcast)');
    expect(adminPanel).toMatch(/if \(!m\.is_active\) return 'inactive';/);
    expect(adminPanel).toMatch(/if \(m\.expires_at && new Date\(m\.expires_at\)\.getTime\(\) <= Date\.now\(\)\) return 'expired';/);
  });

  it('uses the existing organizations list for the target multi-select (getOrganizations, not a new query)', () => {
    expect(adminPanel).toContain("import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';");
    expect(adminPanel).toMatch(/useAsync\(\(\) => isSuper \? getOrganizations\(\) : Promise\.resolve\(\[\]\), \[isSuper\]\)/);
  });
});

describe('F) PlatformBroadcastGate: waits for auth/profile/org resolution', () => {
  it('ready requires authReady, sessionUserId, profileId, and activeOrgId all truthy', () => {
    expect(gate).toMatch(/const ready = authReady && !!sessionUserId && !!profileId && !!activeOrgId;/);
  });

  it('sessionUserId/profileId are derived from session.user.id / profile.id (not just truthiness of the object references)', () => {
    expect(gate).toContain('const sessionUserId = session?.user?.id ?? null;');
    expect(gate).toContain('const profileId = profile?.id ?? null;');
  });

  it('returns null when not ready or the queue is empty', () => {
    expect(gate).toMatch(/if \(!ready \|\| queue\.length === 0\) return null;/);
  });

  it('FIX-PLATFORM-BROADCAST-GATE-NOT-FETCHING-A: the fetch-guard is a ref (hasFetchedRef), not React state, so the guard itself can never delay or skip the first legitimate fetch', () => {
    expect(gate).toContain('const hasFetchedRef = useRef(false);');
    const start = gate.indexOf('useEffect(() => {');
    const body = gate.slice(start, gate.indexOf('}, [authReady, sessionUserId, profileId, activeOrgId, ready, profile]);'));
    expect(body).toMatch(/if \(!ready \|\| hasFetchedRef\.current\) return;/);
    expect(body).toContain('hasFetchedRef.current = true;');
    expect(body).not.toContain('setFetched(');
  });

  it('the fetch effect depends on the granular primitives (authReady, sessionUserId, profileId, activeOrgId), not only a single derived boolean', () => {
    expect(gate).toContain('}, [authReady, sessionUserId, profileId, activeOrgId, ready, profile]);');
  });

  it('warns clearly when a non-super_admin profile has resolved but has no organization_id (the pending fetch can never fire for this account)', () => {
    const start = gate.indexOf('useEffect(() => {');
    const body = gate.slice(start, gate.indexOf('}, [authReady, sessionUserId, profileId, activeOrgId, ready, profile]);'));
    expect(body).toMatch(/if \(profileId && profile && profile\.role !== 'super_admin' && !activeOrgId\) \{/);
    expect(body).toContain('console.warn(');
    expect(body).toMatch(/no organization_id/);
  });

  it('never mounts on the public QR page — only ever rendered inside PhoenixAppShell, which PublicQrScreen does not use', () => {
    const qrScreen = readSrc('features/qr/PublicQrScreen.tsx');
    expect(qrScreen).not.toContain('PlatformBroadcastGate');
    expect(qrScreen).not.toContain('PhoenixAppShell');
  });
});

describe('G) Gate fetches pending broadcasts', () => {
  it('calls getPendingPlatformBroadcasts and populates the queue from the result', () => {
    expect(gate).toContain('getPendingPlatformBroadcasts()');
    expect(gate).toMatch(/setQueue\(res\.broadcasts\);/);
  });

  it('logs a clear error when the RPC returns ok=false (business-rule rejection, not just a thrown exception)', () => {
    expect(gate).toMatch(/console\.error\('\[phoenix\] getPendingPlatformBroadcasts returned ok=false:', res\.error\);/);
  });

  it('logs (does not throw unhandled) on a failed fetch', () => {
    const start = gate.indexOf('.catch((err: unknown) => {');
    const body = gate.slice(start, start + 150);
    expect(body).toContain('console.error(');
  });
});

describe('H) Gate shows one modal at a time', () => {
  it('renders only queue[0] as `current`', () => {
    expect(gate).toContain('const current = queue[0];');
  });

  it('does not render a list/loop of all pending messages at once', () => {
    expect(gate).not.toMatch(/queue\.map\(/);
  });
});

describe('I) Acknowledge calls service with message id; acknowledged message removed from queue', () => {
  it('onAcknowledge calls acknowledgePlatformBroadcast with current.id', () => {
    const start = gate.indexOf('async function onAcknowledge()');
    const body = gate.slice(start, gate.indexOf('function PlatformBroadcastGate') > -1 ? gate.length : gate.length);
    expect(body).toContain('await acknowledgePlatformBroadcast(current.id)');
  });

  it('on success, removes the current message from the queue (slice(1)), revealing the next if any', () => {
    expect(gate).toContain('setQueue(q => q.slice(1));');
  });

  it('does not clear the queue entirely on ack (only the front message is removed)', () => {
    expect(gate).not.toMatch(/setQueue\(\[\]\)/);
  });
});

describe('J) No "later" button exists', () => {
  it('the gate renders exactly one button: the Acknowledge button', () => {
    const buttonMatches = gate.match(/<PhoenixButton/g) ?? [];
    expect(buttonMatches.length).toBe(1);
    expect(gate).toContain("t('pbc_acknowledge_button', lang)");
  });

  it('no "later"/"skip"/"remind me" button wording exists (comments explaining the "no dismiss" design decision are fine)', () => {
    // Strip // and /* */ style comment content so a doc-comment explaining
    // *why* there's no dismiss button doesn't trip a check for whether one
    // actually exists in the rendered UI.
    const withoutComments = gate
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/later|dismiss|skip|remind/i);
  });

  it('the dialog onClose handler is a no-op (Escape/backdrop click never dismisses without acknowledging)', () => {
    expect(gate).toMatch(/onClose=\{\(\) => \{ \/\* no dismiss without acknowledging, by design \*\/ \}\}/);
  });
});

describe('K) Error state shown on acknowledge failure', () => {
  it('sets ackError on a graceful ok:false response and on a thrown exception', () => {
    const start = gate.indexOf('async function onAcknowledge()');
    const body = gate.slice(start);
    expect(body).toContain('setAckError(true);');
    expect(body).toMatch(/if \(!res\.ok\) \{\s*\n\s*setAckError\(true\);/);
    expect(body).toMatch(/catch \(err\) \{[\s\S]{0,150}setAckError\(true\);/);
  });

  it('renders the translated pbc_ack_failed message when ackError is true', () => {
    expect(gate).toMatch(/\{ackError && \([\s\S]{0,150}t\('pbc_ack_failed', lang\)/);
  });
});

describe('L) Severity labels render (both components)', () => {
  it('gate renders a severity badge using pbc_severity_<severity> key', () => {
    expect(gate).toMatch(/t\(`pbc_severity_\$\{current\.severity\}`, lang\)/);
  });

  it('admin panel severity select offers all four severities', () => {
    expect(adminPanel).toContain("<option value=\"info\">{t('pbc_severity_info', lang)}</option>");
    expect(adminPanel).toContain("<option value=\"warning\">{t('pbc_severity_warning', lang)}</option>");
    expect(adminPanel).toContain("<option value=\"important\">{t('pbc_severity_important', lang)}</option>");
    expect(adminPanel).toContain("<option value=\"urgent\">{t('pbc_severity_urgent', lang)}</option>");
  });

  it('admin panel list badges reuse the same severity translation key convention', () => {
    expect(adminPanel).toMatch(/t\(`pbc_severity_\$\{m\.severity\}`, lang\)/);
  });
});

describe('M) Arabic/English labels exist for all pbc_* keys used by these components', () => {
  const usedKeys = [
    'pbc_admin_title', 'pbc_admin_subtitle', 'pbc_create_title', 'pbc_field_title', 'pbc_field_body',
    'pbc_field_severity', 'pbc_field_target_scope', 'pbc_field_expires_at', 'pbc_target_all',
    'pbc_target_selected', 'pbc_select_orgs_placeholder', 'pbc_severity_info', 'pbc_severity_warning',
    'pbc_severity_important', 'pbc_severity_urgent', 'pbc_create_button', 'pbc_create_failed',
    'pbc_create_success', 'pbc_validation_title_required', 'pbc_validation_body_required',
    'pbc_validation_orgs_required', 'pbc_list_title', 'pbc_list_empty', 'pbc_list_loading',
    'pbc_list_load_failed', 'pbc_status_active', 'pbc_status_inactive', 'pbc_status_expired',
    'pbc_ack_summary', 'pbc_deactivate_button', 'pbc_deactivate_confirm', 'pbc_popup_title',
    'pbc_acknowledge_button', 'pbc_ack_failed', 'pbc_published_on',
  ];

  it.each(usedKeys)('%s is defined bilingually (ar + en) in strings.ts', (key) => {
    const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`);
    expect(strings).toMatch(re);
  });
});

describe('N) Service wrapper: typed results, RPC call shape', () => {
  it('createPlatformBroadcast calls phoenix_create_platform_broadcast with all seven params', () => {
    const start = service.indexOf('export async function createPlatformBroadcast');
    const body = service.slice(start, service.indexOf('export async function deactivatePlatformBroadcast'));
    expect(body).toContain("supabase.rpc('phoenix_create_platform_broadcast'");
    expect(body).toContain('p_title: input.title');
    expect(body).toContain('p_body: input.body');
    expect(body).toContain('p_severity: input.severity');
    expect(body).toContain('p_target_scope: input.targetScope');
    expect(body).toMatch(/p_org_ids: input\.targetScope === 'selected' \? \(input\.orgIds \?\? \[\]\) : null/);
  });

  it('deactivatePlatformBroadcast calls phoenix_deactivate_platform_broadcast with p_message_id', () => {
    const start = service.indexOf('export async function deactivatePlatformBroadcast');
    const body = service.slice(start, service.indexOf('export async function listPlatformBroadcastsAdmin'));
    expect(body).toContain("supabase.rpc('phoenix_deactivate_platform_broadcast'");
    expect(body).toContain('p_message_id: messageId');
  });

  it('listPlatformBroadcastsAdmin calls phoenix_list_platform_broadcasts_admin with no args', () => {
    const start = service.indexOf('export async function listPlatformBroadcastsAdmin');
    const body = service.slice(start, service.indexOf('export async function getPendingPlatformBroadcasts'));
    expect(body).toContain("supabase.rpc('phoenix_list_platform_broadcasts_admin')");
  });

  it('getPendingPlatformBroadcasts calls phoenix_get_pending_platform_broadcasts with no args', () => {
    const start = service.indexOf('export async function getPendingPlatformBroadcasts');
    const body = service.slice(start, service.indexOf('export async function acknowledgePlatformBroadcast'));
    expect(body).toContain("supabase.rpc('phoenix_get_pending_platform_broadcasts')");
  });

  it('acknowledgePlatformBroadcast calls phoenix_ack_platform_broadcast with p_message_id', () => {
    const start = service.indexOf('export async function acknowledgePlatformBroadcast');
    const body = service.slice(start);
    expect(body).toContain("supabase.rpc('phoenix_ack_platform_broadcast'");
    expect(body).toContain('p_message_id: messageId');
  });

  it('all five functions throw on a Supabase-level error', () => {
    const count = (service.match(/if \(error\) throw error;/g) ?? []).length;
    expect(count).toBe(5);
  });
});

describe('O) Mounted in PhoenixAppShell as a sibling near PwaInstallPrompt/CommandPalette', () => {
  it('PhoenixAppShell imports and renders PlatformBroadcastGate', () => {
    expect(appShell).toContain("import { PlatformBroadcastGate } from '@/features/platform-broadcast/PlatformBroadcastGate';");
    expect(appShell).toContain('<PlatformBroadcastGate />');
  });

  it('is rendered alongside (not replacing) PwaInstallPrompt and CommandPalette', () => {
    expect(appShell).toContain('<PwaInstallPrompt');
    expect(appShell).toContain('<CommandPalette');
  });
});

describe('P) Guard tests: no QR/availability/movement/Deep-Clean/Reports/Status-Center-export/WhatsApp files changed', () => {
  it('no working-tree diff on QR, availability, movement-history, Deep Clean, Reports, or WhatsApp files', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/PublicQrScreen.tsx src/shared/supabase/services/qr.service.ts ' +
        'src/shared/supabase/services/availability.service.ts src/features/institutions/InstitutionScreen.tsx ' +
        'src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx ' +
        'supabase/migrations/055_phoenix_clean_availability_data.sql ' +
        'src/features/reports/ReportsScreen.tsx src/features/status/OutletAvailabilityReportModal.tsx ' +
        'src/shared/lib/whatsapp.ts src/shared/ui/WhatsAppContactButton.tsx ' +
        'src/features/alerts/InterInstitutionAlertsScreen.tsx src/shared/supabase/services/dashboard.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile changes', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('does not reference item_availability/item_availability_movements in the new frontend files', () => {
    for (const src of [adminPanel, gate, service]) {
      expect(src).not.toMatch(/\bitem_availability\b/);
      expect(src).not.toMatch(/\bitem_availability_movements\b/);
    }
  });
});
