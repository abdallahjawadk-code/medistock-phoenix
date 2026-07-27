/**
 * AuditLogSection — read-only, self-contained safety properties.
 *
 * Extracted from the now-retired nav-reports-hide.test.ts (which coupled
 * these assertions to a since-superseded scoped-nav-restoration phase).
 * AuditLogSection itself is unaffected by REPORTING-UNIFICATION: it is
 * still the exact same component, now rendered from the unified shell's
 * Audit & Sensitive Actions tab (DecisionIntelligenceReportsScreen.tsx)
 * instead of ReportsScreen.tsx / StatusCenterScreen.tsx. These properties
 * — read-only, no elevated fields exposed — remain load-bearing regardless
 * of which screen mounts it, so they're preserved here as their own test.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const auditLogSection = readSrc('features/reports/AuditLogSection.tsx');

describe('AuditLogSection: reused, self-contained, read-only extraction', () => {
  it('fetches via the existing getAuditLog service call only — no new query/RPC', () => {
    expect(auditLogSection).toContain("import { getAuditLog } from '@/shared/supabase/services/audit.service'");
    expect(auditLogSection).toContain('getAuditLog(activeOrgId)');
    expect(auditLogSection).not.toMatch(/writeAuditLog\(|supabase\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
  });

  it('renders only id/created_at/action/entity_type/actor_role — never actor_id, entity_id, or the raw payload column', () => {
    expect(auditLogSection).toContain('row.action');
    expect(auditLogSection).toContain('row.entity_type');
    expect(auditLogSection).toContain('row.actor_role');
    expect(auditLogSection).toContain('row.created_at');
    expect(auditLogSection).not.toMatch(/row\.actor_id|row\.entity_id|row\.payload/);
  });

  it('is a plain function component with no mutating action/button beyond the empty/loading/error states', () => {
    expect(auditLogSection).not.toMatch(/onClick=\{.*(delete|remove|archive|reactivate)/i);
  });

  it('handles the no-org-scope case internally (so callers do not need to duplicate that check)', () => {
    expect(auditLogSection).toContain('if (!activeOrgId)');
    expect(auditLogSection).toContain("t('no_org_scope', lang)");
  });

  it('never renders a raw UUID pattern', () => {
    expect(auditLogSection).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('never references removed_by or any other unrelated sensitive lifecycle field', () => {
    expect(auditLogSection).not.toMatch(/removed_by|service_role|auth\.admin/);
  });
});
