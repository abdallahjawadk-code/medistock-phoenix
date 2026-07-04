/**
 * EXPIRY-RISK-TIERS-A
 *
 * Tests for the shared 9/6/3-month expiry risk classification helper
 * (src/shared/lib/expiry-risk.ts). This is a UI-only classification layer —
 * it reuses (never duplicates) the date math already tested in
 * src/shared/lib/status/canonical.ts, and does not touch backend alert
 * generation, the live inter-institution alert RPC, or the stored
 * `condition` value.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getExpiryRiskTier,
  getExpiryRiskLabel,
  getExpiryRiskTone,
  getExpiryRiskMonthsRemaining,
  isExpiryRiskCritical,
  type ExpiryRiskTier,
} from '@/shared/lib/expiry-risk';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const moduleSrc = read('shared/lib/expiry-risk.ts');

const NOW = new Date('2026-07-04T12:00:00');
const iso = (d: string) => d; // documents that plain 'YYYY-MM-DD' strings are the expected input shape

describe('getExpiryRiskTier: expired', () => {
  it('returns expired for any date before today', () => {
    expect(getExpiryRiskTier(iso('2026-07-03'), NOW)).toBe('expired');
    expect(getExpiryRiskTier(iso('2020-01-01'), NOW)).toBe('expired');
  });
});

describe('getExpiryRiskTier: critical_3m (today through 3 months)', () => {
  it('returns critical_3m for today', () => {
    expect(getExpiryRiskTier(iso('2026-07-04'), NOW)).toBe('critical_3m');
  });

  it('returns critical_3m for 1 month out', () => {
    expect(getExpiryRiskTier(iso('2026-08-04'), NOW)).toBe('critical_3m');
  });

  it('returns critical_3m for exactly 3 months out', () => {
    expect(getExpiryRiskTier(iso('2026-10-04'), NOW)).toBe('critical_3m');
  });
});

describe('getExpiryRiskTier: warning_6m (>3 and <=6 months)', () => {
  it('returns warning_6m for just past the 3-month boundary', () => {
    expect(getExpiryRiskTier(iso('2026-10-05'), NOW)).toBe('warning_6m');
  });

  it('returns warning_6m for exactly 6 months out', () => {
    expect(getExpiryRiskTier(iso('2027-01-04'), NOW)).toBe('warning_6m');
  });
});

describe('getExpiryRiskTier: watch_9m (>6 and <=9 months)', () => {
  it('returns watch_9m for just past the 6-month boundary', () => {
    expect(getExpiryRiskTier(iso('2027-01-05'), NOW)).toBe('watch_9m');
  });

  it('returns watch_9m for exactly 9 months out', () => {
    expect(getExpiryRiskTier(iso('2027-04-04'), NOW)).toBe('watch_9m');
  });
});

describe('getExpiryRiskTier: normal (>9 months)', () => {
  it('returns normal for just past the 9-month boundary', () => {
    expect(getExpiryRiskTier(iso('2027-04-05'), NOW)).toBe('normal');
  });

  it('returns normal for a date years away', () => {
    expect(getExpiryRiskTier(iso('2030-01-01'), NOW)).toBe('normal');
  });
});

describe('getExpiryRiskTier: unknown (null/undefined/invalid) — never throws', () => {
  it('returns unknown for null/undefined', () => {
    expect(getExpiryRiskTier(null, NOW)).toBe('unknown');
    expect(getExpiryRiskTier(undefined, NOW)).toBe('unknown');
  });

  it('returns unknown for an unparseable string, without throwing', () => {
    expect(() => getExpiryRiskTier('not-a-real-date', NOW)).not.toThrow();
    expect(getExpiryRiskTier('not-a-real-date', NOW)).toBe('unknown');
  });

  it('returns unknown for an empty string', () => {
    expect(getExpiryRiskTier('', NOW)).toBe('unknown');
  });

  it('is distinct from "normal" — unknown means unparseable, normal means beyond the 9-month horizon', () => {
    expect(getExpiryRiskTier('garbage', NOW)).not.toBe(getExpiryRiskTier('2030-01-01', NOW));
  });
});

describe('getExpiryRiskTier: accepts ISO strings and Date objects identically', () => {
  it('a plain YYYY-MM-DD string and an equivalent Date object produce the same tier', () => {
    const fromString = getExpiryRiskTier('2026-08-01', NOW);
    const fromDate = getExpiryRiskTier(new Date('2026-08-01T00:00:00'), NOW);
    expect(fromString).toBe(fromDate);
    expect(fromString).toBe('critical_3m');
  });

  it('accepts a full ISO datetime string (time component ignored for date-only comparison)', () => {
    expect(getExpiryRiskTier('2026-08-01T23:59:59.000Z', NOW)).toBe('critical_3m');
  });
});

describe('getExpiryRiskTier: never throws for any input shape', () => {
  it.each([null, undefined, '', 'garbage', new Date('invalid'), 0 as unknown as string, {} as unknown as string])(
    'does not throw for %p',
    v => {
      expect(() => getExpiryRiskTier(v, NOW)).not.toThrow();
    },
  );
});

describe('getExpiryRiskLabel: bilingual labels for every tier', () => {
  const tiers: ExpiryRiskTier[] = ['expired', 'critical_3m', 'warning_6m', 'watch_9m', 'normal', 'unknown'];

  it.each(tiers)('%s has a non-empty Arabic and English label', tier => {
    const ar = getExpiryRiskLabel(tier, 'ar');
    const en = getExpiryRiskLabel(tier, 'en');
    expect(ar.length).toBeGreaterThan(0);
    expect(en.length).toBeGreaterThan(0);
    expect(ar).not.toBe(en);
  });

  it('the three risk tiers (critical/warning/watch) each have a visually distinguishable label from one another', () => {
    const labels = ['critical_3m', 'warning_6m', 'watch_9m'].map(t => getExpiryRiskLabel(t as ExpiryRiskTier, 'en'));
    expect(new Set(labels).size).toBe(3);
    const labelsAr = ['critical_3m', 'warning_6m', 'watch_9m'].map(t => getExpiryRiskLabel(t as ExpiryRiskTier, 'ar'));
    expect(new Set(labelsAr).size).toBe(3);
  });
});

describe('getExpiryRiskTone: distinct tones for 9/6/3-month tiers', () => {
  it('critical_3m and expired use the err (red/danger) tone', () => {
    expect(getExpiryRiskTone('critical_3m')).toBe('err');
    expect(getExpiryRiskTone('expired')).toBe('err');
  });

  it('warning_6m uses a distinct tone from critical_3m', () => {
    expect(getExpiryRiskTone('warning_6m')).not.toBe(getExpiryRiskTone('critical_3m'));
    expect(getExpiryRiskTone('warning_6m')).toBe('warn');
  });

  it('watch_9m uses a distinct tone from both warning_6m and critical_3m', () => {
    const t9 = getExpiryRiskTone('watch_9m');
    expect(t9).not.toBe(getExpiryRiskTone('warning_6m'));
    expect(t9).not.toBe(getExpiryRiskTone('critical_3m'));
  });

  it('normal and unknown are muted/neutral, distinct from all risk tones', () => {
    expect(getExpiryRiskTone('normal')).toBe('ok');
    expect(getExpiryRiskTone('unknown')).toBe('neutral');
  });
});

describe('isExpiryRiskCritical: the 3-month tier (and expired) shows a clear alert/warning state', () => {
  it('is true for expired and critical_3m', () => {
    expect(isExpiryRiskCritical('expired')).toBe(true);
    expect(isExpiryRiskCritical('critical_3m')).toBe(true);
  });

  it('is false for the softer/normal/unknown tiers', () => {
    expect(isExpiryRiskCritical('warning_6m')).toBe(false);
    expect(isExpiryRiskCritical('watch_9m')).toBe(false);
    expect(isExpiryRiskCritical('normal')).toBe(false);
    expect(isExpiryRiskCritical('unknown')).toBe(false);
  });
});

describe('getExpiryRiskMonthsRemaining: display-only approximation, never throws', () => {
  it('returns null for unparseable/missing dates', () => {
    expect(getExpiryRiskMonthsRemaining(null, NOW)).toBeNull();
    expect(getExpiryRiskMonthsRemaining('garbage', NOW)).toBeNull();
  });

  it('returns a positive number for a future date and a negative number for a past date', () => {
    expect(getExpiryRiskMonthsRemaining('2027-04-04', NOW)).toBeGreaterThan(0);
    expect(getExpiryRiskMonthsRemaining('2020-01-01', NOW)).toBeLessThan(0);
  });

  it('never throws for any input', () => {
    expect(() => getExpiryRiskMonthsRemaining(undefined, NOW)).not.toThrow();
  });
});

describe('reuses existing canonical date math instead of duplicating it', () => {
  it('imports parseExpiryDate/addMonthsClamped from status/canonical.ts', () => {
    expect(moduleSrc).toContain("from './status/canonical'");
    expect(moduleSrc).toContain('parseExpiryDate');
    expect(moduleSrc).toContain('addMonthsClamped');
  });
});

describe('Scope guards: no backend/alert-lifecycle/RPC/QR/WhatsApp changes in this module', () => {
  it('does not reference alert lifecycle RPCs, Supabase, or WhatsApp', () => {
    expect(moduleSrc).not.toMatch(/supabase\.from\(|\.rpc\(|updateInterOrgAlertState|reopenInterOrgAlert/);
    expect(moduleSrc).not.toMatch(/whatsapp|wa\.me/i);
  });

  it('is not a Service-D / inter-org-exchange module and does not reference service_role', () => {
    expect(moduleSrc).not.toContain('inter_org_exchange');
    expect(moduleSrc).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
  });
});

describe('Safety: no package/lockfile/migration changes, untracked files, Service-D stash', () => {
  it('no package/lockfile diff', async () => {
    const { execSync } = await import('child_process');
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('no migration SQL touched other than the already-approved 051 immutable-expiry-date fix', async () => {
    const { execSync } = await import('child_process');
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html and supabase/.temp/ remain untracked', async () => {
    const { execSync } = await import('child_process');
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) expect(status.trim().startsWith('??')).toBe(true);

    const full = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = full.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) expect(tempLine.trim().startsWith('??')).toBe(true);
  });

  it('stash@{0} (paused Service-D work) was not popped or applied', async () => {
    const { execSync } = await import('child_process');
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
