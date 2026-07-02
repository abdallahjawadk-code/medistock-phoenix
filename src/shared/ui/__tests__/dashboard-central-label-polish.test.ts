/**
 * INTER-INSTITUTION-EXCHANGE-WORKFLOW-AUDIT-A
 * Run: npm test -- --run
 *
 * Static source-code test for the single Arabic label correction made in
 * this audit phase: the dashboard header key `d_central` changes from
 * "لوحة القيادة المركزية" to "اللوحة المركزية". No dashboard behavior,
 * data, or English label changed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const strings = readSrc('shared/i18n/strings.ts');
const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');

describe('Dashboard central label: "لوحة القيادة المركزية" → "اللوحة المركزية"', () => {
  it('old phrase no longer appears in strings.ts or DashboardScreen.tsx', () => {
    expect(strings).not.toContain('لوحة القيادة المركزية');
    expect(dashboard).not.toContain('لوحة القيادة المركزية');
  });

  it('d_central now holds the new phrase, English label unchanged', () => {
    const line = strings.split('\n').find(l => l.includes('d_central:'));
    expect(line).toContain('اللوحة المركزية');
    expect(line).toContain('Central Dashboard');
  });

  it('DashboardScreen still renders the header via the same d_central i18n key (no hardcoding)', () => {
    expect(dashboard).toContain("t('d_central', lang)");
  });
});
