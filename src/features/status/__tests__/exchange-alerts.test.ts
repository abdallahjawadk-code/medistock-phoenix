import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { generateExchangeAlerts } from '../exchange-alerts';
import type { StatusReport } from '@/shared/supabase/services/status-reports.service';

const SRC = join(__dirname, '../../..');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function makeReport(overrides: Partial<StatusReport> & { organization_id: string; status_type: string }): StatusReport {
  return {
    id: Math.random().toString(36).slice(2),
    item_id: null,
    item_name: 'Paracetamol',
    item_name_ar: 'باراسيتامول',
    quantity: null,
    unit: null,
    expiry_date: null,
    notes: null,
    submitted_by: null,
    submitted_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    is_active: true,
    created_at: new Date().toISOString(),
    organizations: { name: 'Org A', name_ar: 'مؤسسة أ' },
    ...overrides,
  } as StatusReport;
}

describe('generateExchangeAlerts: matching rules', () => {
  it('surplus + missing creates alert', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 100, organizations: { name: 'Org A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', organizations: { name: 'Org B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
    expect(alerts[0].sourceOrgId).toBe('org-a');
    expect(alerts[0].targetOrgId).toBe('org-b');
  });

  it('surplus + scarce creates alert', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 50, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'scarce', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
    expect(alerts[0].priority).toBe('medium');
  });

  it('near_expiry + missing creates high priority', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'near_expiry', expiry_date: '2026-08-01', organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
    expect(alerts[0].priority).toBe('high');
  });

  it('near_expiry + scarce creates medium priority', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'near_expiry', organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'scarce', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
    expect(alerts[0].priority).toBe('medium');
  });

  it('surplus + missing with quantity creates high priority', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 200, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts[0].priority).toBe('high');
  });

  it('surplus + missing without quantity creates low priority', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: null, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts[0].priority).toBe('low');
  });
});

describe('generateExchangeAlerts: exclusion rules', () => {
  it('same organization creates no alert', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 100 }),
      makeReport({ organization_id: 'org-a', status_type: 'missing' }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(0);
  });

  it('inactive/resolved reports are ignored', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 100, is_active: false }),
      makeReport({ organization_id: 'org-b', status_type: 'missing' }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(0);
  });

  it('missing/scarce source does not create alert', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'missing' }),
      makeReport({ organization_id: 'org-b', status_type: 'scarce' }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(0);
  });

  it('surplus target does not create alert', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 100 }),
      makeReport({ organization_id: 'org-b', status_type: 'surplus', quantity: 50 }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(0);
  });

  it('unrelated items do not match', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', item_name: 'Amoxicillin', item_name_ar: 'أموكسيسيلين', quantity: 100 }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', item_name: 'Paracetamol', item_name_ar: 'باراسيتامول' }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(0);
  });
});

describe('generateExchangeAlerts: matching by item_id and text', () => {
  it('item_id match preferred', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', item_id: 'item-1', item_name: 'X', quantity: 10, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', item_id: 'item-1', item_name: 'Y', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
  });

  it('Arabic text match works', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', item_name: null, item_name_ar: 'أنسولين', quantity: 10, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', item_name: null, item_name_ar: 'أنسولين', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.length).toBe(1);
  });

  it('manualActionRequired is always true', () => {
    const reports = [
      makeReport({ organization_id: 'org-a', status_type: 'surplus', quantity: 10, organizations: { name: 'A', name_ar: 'أ' } }),
      makeReport({ organization_id: 'org-b', status_type: 'missing', organizations: { name: 'B', name_ar: 'ب' } }),
    ];
    const alerts = generateExchangeAlerts(reports);
    expect(alerts.every(a => a.manualActionRequired === true)).toBe(true);
  });
});

describe('Exchange alerts: safety and labels', () => {
  const strings = readSrc('shared/i18n/strings.ts');
  const screen = readSrc('features/status/StatusCenterScreen.tsx');
  const engine = readSrc('features/status/exchange-alerts.ts');

  it('priority labels exist in AR/EN', () => {
    expect(strings).toContain('ea_priority_high');
    expect(strings).toContain('ea_priority_medium');
    expect(strings).toContain('ea_priority_low');
  });

  it('manual action label exists', () => {
    expect(strings).toContain('ea_manual');
  });

  it('empty state label exists', () => {
    expect(strings).toContain('ea_empty');
  });

  it('no auto-transfer in engine', () => {
    expect(engine).not.toContain('autoTransfer');
    expect(engine).not.toContain('createTransfer');
    expect(engine).not.toContain('approveTransfer');
  });

  it('no approve action in screen', () => {
    expect(screen).not.toContain('approveTransfer');
    expect(screen).not.toContain('autoApprove');
  });

  it('no service_role in engine', () => {
    expect(engine).not.toContain('service_role');
  });

  it('screen shows manual action required', () => {
    expect(screen).toContain('ea_manual');
  });

  it('screen uses dir="auto" for item names', () => {
    expect(screen).toContain('dir="auto"');
  });

  it('screen uses dir="ltr" for dates', () => {
    expect(screen).toContain('dir="ltr"');
  });
});
