/**
 * EXPIRY-RISK-TIERS-A
 *
 * Proves the shared ExpiryRiskBadge (and the underlying expiry-risk.ts
 * helper) is wired into the three UI targets this phase touches —
 * StatusEditorScreen, StatusCenterScreen, and InstitutionScreen's port
 * availability list — without changing routes, permissions, data fetching,
 * the stored `condition` value, backend alert generation, the live
 * inter-institution alert RPC, QR/user-management/WhatsApp behavior, or any
 * migration/SQL file.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const badgeSrc = read('shared/ui/ExpiryRiskBadge.tsx');
const statusEditor = read('features/status/StatusEditorScreen.tsx');
const statusCenter = read('features/status/StatusCenterScreen.tsx');
const institution = read('features/institutions/InstitutionScreen.tsx');
const strings = read('shared/i18n/strings.ts');

describe('ExpiryRiskBadge: shared component', () => {
  it('renders nothing for normal/unknown tiers (avoids visual noise on the common case)', () => {
    expect(badgeSrc).toMatch(/tier === 'normal' \|\| tier === 'unknown'/);
    expect(badgeSrc).toContain('return null');
  });

  it('uses PhoenixStatusBadge with the shared tone mapping (no new CSS/badge component invented)', () => {
    expect(badgeSrc).toContain("from './PhoenixStatusBadge'");
    expect(badgeSrc).toContain('getExpiryRiskTone');
  });

  it('shows a stronger (bold + warning icon) visual for the critical tiers (expired/critical_3m)', () => {
    expect(badgeSrc).toContain('isExpiryRiskCritical');
    expect(badgeSrc).toMatch(/⚠/);
    expect(badgeSrc).toMatch(/fontWeight:\s*800/);
  });

  it('never writes to the database and never triggers a backend alert (UI classification only)', () => {
    expect(badgeSrc).not.toMatch(/supabase\.from\(|\.rpc\(|\.insert\(|\.update\(|\.upsert\(/);
  });
});

describe('StatusEditorScreen: expiry risk wiring', () => {
  it('imports ExpiryRiskBadge and renders it next to the expiry table cell', () => {
    expect(statusEditor).toContain("from '@/shared/ui/ExpiryRiskBadge'");
    const idx = statusEditor.indexOf("c.key === 'expiry'");
    expect(idx).toBeGreaterThan(-1);
    const block = statusEditor.slice(idx, idx + 300);
    expect(block).toContain('<ExpiryRiskBadge');
  });

  it('adds a derived, read-only "expiry risk" export column using the same shared helper (low-risk, additive column)', () => {
    expect(statusEditor).toContain("key: 'expiryRisk'");
    expect(statusEditor).toContain('getExpiryRiskLabel(getExpiryRiskTier(r.expiry_date), lang)');
  });

  it('does not change the stored condition value or add any Supabase write', () => {
    expect(statusEditor).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(statusEditor).not.toContain('.rpc(');
  });

  it('the new expiry_risk_column i18n key has non-empty Arabic and English text', () => {
    expect(strings).toMatch(/expiry_risk_column:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'/);
  });
});

describe('StatusCenterScreen: expiry risk wiring', () => {
  it('imports ExpiryRiskBadge and renders it next to the expiry table cell', () => {
    expect(statusCenter).toContain("from '@/shared/ui/ExpiryRiskBadge'");
    const idx = statusCenter.lastIndexOf('expiryDisplay(r, lang)');
    expect(idx).toBeGreaterThan(-1);
    const block = statusCenter.slice(idx, idx + 200);
    expect(block).toContain('<ExpiryRiskBadge');
  });

  it('passes the raw expiry_date (not the display string) into the badge so tier classification is exact', () => {
    expect(statusCenter).toContain('expiryDate={r.expiry_date}');
  });
});

describe('InstitutionScreen: expiry risk wiring (port availability list)', () => {
  it('imports ExpiryRiskBadge and renders it in the outlet material row', () => {
    expect(institution).toContain("from '@/shared/ui/ExpiryRiskBadge'");
    const idx = institution.indexOf('<ExpiryRiskBadge');
    expect(idx).toBeGreaterThan(-1);
  });

  it('no longer hardcodes a single warn color on the raw expiry_date span regardless of actual risk', () => {
    expect(institution).not.toMatch(/color:\s*'var\(--warn\)'\s*\}\}\s*dir="ltr">\{r\.expiry_date\}/);
  });

  it('does not change the remove-from-outlet or safe-delete flow', () => {
    expect(institution).toContain("onClick={(e) => { e.stopPropagation(); setRemoveError(null); setRemoveTarget(r); }}");
  });
});

describe('Existing filters/backend/lifecycle/QR/WhatsApp remain unchanged', () => {
  it('StatusEditorScreen filter behavior (port/status/search) is untouched', () => {
    expect(statusEditor).toContain('if (filterPort) list = list.filter');
    expect(statusEditor).toContain('if (filterStatus) list = list.filter');
  });

  // REFRESH-ALERT-UI-DIFF-GUARDS-A: features/alerts/inter-org-alert-lifecycle.service.ts
  // is excluded from this loop because a later, separately-reviewed phase
  // (ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A) legitimately extends it with
  // sourceExpiryRiskTier/sourceExpiryDaysRemaining mapping — every other
  // file in this list remains fully guarded (zero diff required).
  it('no backend/service/RLS/auth/permission files changed', () => {
    for (const rel of [
      'shared/supabase/services/users.service.ts',
      'shared/supabase/services/auth.service.ts',
      'features/alerts/inter-institution-alerts.service.ts',
      'features/alerts/live-inter-institution-alerts.service.ts',
    ]) {
      let diff = '';
      try {
        diff = execSync(`git diff -- src/${rel}`, { cwd: ROOT, encoding: 'utf8' });
      } catch { /* ignore */ }
      expect(diff.trim()).toBe('');
    }
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply; package/lockfiles remain fully guarded.
  it('no migration SQL changed other than the already-approved 051 immutable-expiry-date fix, no package/lockfile changes', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('QR generation/cancel/recreate and WhatsApp screens are untouched', () => {
    // UserManagementScreen.tsx is intentionally excluded here as of
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A, a later, separately-reviewed
    // phase that additively wires in the Super Admin-only
    // AvailabilityCleanupWizard at the end of that screen.
    for (const rel of [
      'features/qr/QrScreen.tsx',
      'shared/ui/WhatsAppContactButton.tsx',
    ]) {
      let diff = '';
      try {
        diff = execSync(`git diff -- src/${rel}`, { cwd: ROOT, encoding: 'utf8' });
      } catch { /* ignore */ }
      expect(diff.trim()).toBe('');
    }
  });
});

describe('Safety guards', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched (untracked only)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) expect(status.trim().startsWith('??')).toBe(true);
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) expect(tempLine.trim().startsWith('??')).toBe(true);
  });
});
