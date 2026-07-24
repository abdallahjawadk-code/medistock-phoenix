/**
 * DECISION-INTELLIGENCE-REPORTS-119 — frontend contract.
 *
 * Static source scans, matching this repo's convention (no runtime
 * Supabase mock exists) — see inventory-center-invariants.test.ts for the
 * same pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const FEAT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(FEAT, rel), 'utf8');

const service = read('decision-intelligence.service.ts');
const screen = read('DecisionIntelligenceReportsScreen.tsx');

describe('119 frontend — service layer', () => {
  it('never computes classification or supply totals itself — both come straight from the RPC response', () => {
    expect(service).not.toMatch(/reorder_point|target_max|scarce|surplus.*=.*available/);
    expect(service).toContain("supabase.rpc('phoenix_executive_overview'");
    expect(service).toContain("supabase.rpc('phoenix_create_report_snapshot'");
  });

  it('snapshot creation carries a caller-generated idempotency key, minted fresh per attempt', () => {
    expect(service).toContain('export function newRequestId(): string {');
    expect(service).toContain('return crypto.randomUUID();');
  });

  it('the report library reads are organization-scoped', () => {
    expect(service).toContain(".eq('organization_id', organizationId)");
  });

  it('120: the supply-source drill-down never re-derives a bucket total client-side — it only lists lots', () => {
    expect(service).toContain("supabase.rpc('phoenix_supply_sources_detail'");
    expect(service).not.toMatch(/reduce\(.*on_hand_quantity/s);
  });
});

describe('differences & corrections — service layer', () => {
  const correctionsService = readFileSync(join(FEAT, 'differences-corrections.service.ts'), 'utf8');

  it('reads the SAME tables the second-person-approval workflow already writes — no new table, no new RPC', () => {
    expect(correctionsService).toContain("from('phoenix_warehouse_correction_requests')");
    expect(correctionsService).toContain("from('phoenix_stock_correction_requests')");
    expect(correctionsService).not.toMatch(/\.rpc\(/);
  });

  it('reads ALL statuses, not just pending — a report is a history, not an approval queue', () => {
    expect(correctionsService).not.toMatch(/\.eq\('status',\s*'pending'\)/);
  });
});

describe('custody chain — service layer', () => {
  const custodyService = readFileSync(join(FEAT, 'custody-chain.service.ts'), 'utf8');

  it('reuses the EXACT header list functions the operational screens already call — no new list surface', () => {
    expect(custodyService).toContain("from '@/features/outlet/dispatch.service'");
    expect(custodyService).toContain("from '@/features/outlet/outlet-return.service'");
    expect(custodyService).toContain('getWarehouseDispatches()');
    expect(custodyService).toContain('getOutletReturnRequests()');
    expect(custodyService).toContain('getOutletReturnShipments()');
  });

  it('per-document drill-down reuses phoenix_movement_timeline verbatim — no reimplemented timeline logic', () => {
    expect(custodyService).toContain("supabase.rpc('phoenix_movement_timeline'");
  });

  it('never overstates completeness — the RPC own completeness signal is passed through, not discarded', () => {
    expect(custodyService).toContain('MovementTimelineResult');
    expect(custodyService).not.toMatch(/complete:\s*true/);
  });
});

describe('119 frontend — screen', () => {
  it('mints a fresh request id after every snapshot attempt (a retry never silently reuses a stale key across edits)', () => {
    expect(screen).toContain('setRequestId(newRequestId());');
  });

  it('the executive overview XLSX/print exports reuse the shared professional-export primitives, not a bespoke exporter', () => {
    expect(screen).toContain("from '@/shared/lib/professional-export'");
    expect(screen).toContain('exportProfessionalXlsx(exportConfig())');
    expect(screen).toContain('triggerProfessionalPrint(exportConfig())');
  });

  it('mobile print routes through the existing in-app fallback modal, never a raw window.open', () => {
    expect(screen).toContain("from '@/shared/ui/MobilePrintFallbackModal'");
    expect(screen).toContain('mobileHtml !== undefined');
  });

  it('renders all eight tabs', () => {
    for (const id of ['overview', 'institutions', 'materials', 'movements', 'custody', 'corrections', 'audit', 'library']) {
      expect(screen).toContain(`id: '${id}'`);
    }
  });

  it('custody chain never hardcodes complete:true and surfaces the RPC completeness note as-is', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'));
    expect(custody).toContain('completeness_note');
    expect(custody).not.toMatch(/'complete':\s*true|complete:\s*true/);
  });

  it('institution status is a PURE reuse of the existing getInstitutionOverviews — no new RPC, no reimplemented counting', () => {
    expect(screen).toContain("from '@/shared/supabase/services/dashboard.service'");
    expect(screen).toContain('getInstitutionOverviews()');
    expect(screen).not.toMatch(/supabase\.rpc\('phoenix_get_institution/);
  });

  it('materials & batches reuses getAvailabilityByOrg and expiry-risk.ts — no classification math inline', () => {
    expect(screen).toContain("from '@/shared/supabase/services/availability.service'");
    expect(screen).toContain("from '@/shared/lib/expiry-risk'");
    expect(screen).not.toMatch(/reorder_point|target_max/);
  });

  it('stock movements and audit-sensitive actions are PURE embeds of existing self-contained components', () => {
    expect(screen).toContain("from '@/features/status/MovementReportSection'");
    expect(screen).toContain("from './AuditLogSection'");
    expect(screen).toContain('<MovementReportSection />');
    expect(screen).toContain('<AuditLogSection />');
  });

  it('an org-less profile sees the shared empty-scope state, not a broken query', () => {
    expect(screen).toContain('if (!activeOrgId)');
    expect(screen).toContain("t('no_org_scope', lang)");
  });

  it('120: the drill-down only fetches once expanded, and drills into the SAME bucket key the overview card shows', () => {
    expect(screen).toContain("open ? getSupplySourcesDetail(orgId, bucket.key)");
    expect(screen).toContain('function SupplySourceDrilldown(');
  });

  it('120: the drill-down XLSX export reuses the shared professional-export primitive, not a bespoke exporter', () => {
    const drilldown = screen.slice(screen.indexOf('function SupplySourceDrilldown'));
    expect(drilldown).toContain('exportProfessionalXlsx(exportConfig())');
  });
});
