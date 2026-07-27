/**
 * REPORTING-UNIFICATION — mission requirement: prove role permissions and
 * organization isolation for Materials & Batches (the migrated Status
 * Center live-operations view) hold in its new home. StatusCenterScreen.tsx
 * (unrouted, retained on disk) has its own dedicated RBAC tests against the
 * original file; this proves the SAME gates survived the move verbatim into
 * DecisionIntelligenceReportsScreen.tsx, not just that the old file still
 * has them.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const dirc = readSrc('features/reports/DecisionIntelligenceReportsScreen.tsx');

function materialsTabBody(): string {
  const start = dirc.indexOf('function MaterialsAndBatchesTab(');
  const end = dirc.indexOf('\nfunction ', start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return dirc.slice(start, end);
}

describe('Materials & Batches tab: role/permission gating survived the move', () => {
  it('receives role and myPermissions as props (server-checked identity, not re-derived locally)', () => {
    const body = materialsTabBody();
    expect(body).toContain('role: string | null');
    expect(body).toContain('myPermissions: Set<string>');
  });

  it('stock-correction visibility is any-of STOCK_CORRECTION_VISIBILITY_KEYS (unchanged gate shape)', () => {
    const body = materialsTabBody();
    expect(body).toContain('const canCorrectStock = STOCK_CORRECTION_VISIBILITY_KEYS.some(key => myPermissions.has(key));');
  });

  it('reactivate visibility is every-of REACTIVATE_PERMISSION_KEYS (unchanged gate shape — stricter than correction)', () => {
    const body = materialsTabBody();
    expect(body).toContain('const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));');
  });

  it('movement history visibility requires the dedicated availability.movements.view permission', () => {
    const body = materialsTabBody();
    expect(body).toContain("const canViewMovementHistory = myPermissions.has('availability.movements.view');");
  });

  it('the actions column and each row action are gated behind their respective flags, not rendered unconditionally', () => {
    const body = materialsTabBody();
    expect(body).toMatch(/\{\(canCorrectStock \|\| canReactivate \|\| canViewMovementHistory\) && <th/);
    expect(body).toMatch(/canReactivate &&\s*\(/);
    expect(body).toMatch(/canCorrectStock &&\s*\(/);
    expect(body).toMatch(/\{canViewMovementHistory && \(/);
  });

  it('permission keys themselves are imported from the same shared modal components as before (no locally-hardcoded permission strings)', () => {
    expect(dirc).toContain("import { ReactivateMaterialModal, REACTIVATE_PERMISSION_KEYS, type ReactivateRow } from '@/features/status/ReactivateMaterialModal';");
  });
});

describe('Materials & Batches tab: organization isolation survived the move', () => {
  it('the live availability read is scoped to the orgId prop — never a global/unscoped call', () => {
    const body = materialsTabBody();
    expect(body).toContain('const live = useAsync(() => getAvailabilityByOrg(orgId), [orgId]);');
    // No bare call without an org argument anywhere in this tab's body.
    expect(body).not.toMatch(/getAvailabilityByOrg\(\)/);
  });

  it('the tab never reads a second, unscoped organization list to bypass the active scope', () => {
    const body = materialsTabBody();
    // getOrganizations() here is only used to resolve the active org's own
    // display name — never to pick a different org to read from.
    const orgsCall = body.indexOf('orgs.data');
    expect(orgsCall).toBeGreaterThan(-1);
    expect(body.slice(orgsCall, orgsCall + 80)).toContain('x.id === orgId');
  });

  it('DIRC passes the same shared, single activeOrgId (from useApp/PhoenixOrgScope) to every tab, including Materials & Batches — one unified org selector, not a per-tab one', () => {
    expect(dirc).toContain('<MaterialsAndBatchesTab');
    const callSite = dirc.indexOf('<MaterialsAndBatchesTab');
    expect(dirc.slice(callSite, callSite + 200)).toContain('orgId={activeOrgId}');
    expect(dirc).toContain('const { lang, dir, activeOrgId, role, myPermissions } = useApp();');
  });
});
