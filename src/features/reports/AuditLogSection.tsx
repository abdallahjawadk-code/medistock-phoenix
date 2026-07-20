import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { useAsync } from '@/shared/lib/useAsync';
import { getAuditLog } from '@/shared/supabase/services/audit.service';
import { useShadowObservation } from '@/shared/authz/useAuthorization';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

/**
 * PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A
 *
 * Extracted from ReportsScreen.tsx's inline "Audit" tab (previously lines
 * 190-212 there) into a self-contained, reusable, read-only component — same
 * data source (getAuditLog), same fields rendered, same empty/loading/error
 * states, zero behavior change. Now used by BOTH ReportsScreen.tsx (its own
 * Audit tab, unchanged for users who still reach /reports) and
 * StatusCenterScreen.tsx's new Audit Log tab, so there is exactly one copy of
 * the audit-fetching/rendering logic — no risky duplication.
 *
 * Read-only: only ever calls getAuditLog (a plain SELECT) — never
 * writeAuditLog, never any mutation. Renders only id/created_at/action/
 * entity_type/actor_role — deliberately never actor_id, entity_id, or the
 * raw payload column that getAuditLog's query also fetches (same restraint
 * as the original ReportsScreen block; no new fields are exposed here).
 */
export function AuditLogSection() {
  const { lang, activeOrgId, authz } = useApp();

  // PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE: observe audit.view against
  // migration 062. Read-only and non-gating — the fetch below is unchanged and
  // still protected by the audit_logs RLS policy, which stays authoritative.
  useShadowObservation(authz, 'audit.view', { organizationId: activeOrgId });

  const audit = useAsync(() => activeOrgId ? getAuditLog(activeOrgId) : Promise.resolve([]), [activeOrgId]);

  if (!activeOrgId) {
    return <PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />;
  }

  return (
    <>
      {audit.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!audit.loading && audit.error && <PhoenixErrorState title={t('load_error', lang)} message={audit.error} onRetry={audit.reload} />}
      {!audit.loading && !audit.error && (audit.data?.length ?? 0) === 0 && <PhoenixEmptyState icon="file" title={t('empty_audit', lang)} />}
      {!audit.loading && !audit.error && (audit.data?.length ?? 0) > 0 && (
        <PhoenixCard padding="16px" style={{ animation: 'fs .25s ease' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {(audit.data ?? []).map((row, i, arr) => (
              <div key={row.id} style={{ display: 'flex', gap: '12px', padding: '12px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--brd)' : undefined }}>
                <div style={{ fontSize: '10px', color: 'var(--t3)', whiteSpace: 'nowrap', fontFamily: 'monospace', marginTop: '2px' }} dir="ltr">{new Date(row.created_at).toLocaleString(lang === 'ar' ? 'ar' : 'en')}</div>
                <div>
                  <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{row.action} · {row.entity_type}</div>
                  <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{row.actor_role ?? '—'}</div>
                </div>
              </div>
            ))}
          </div>
        </PhoenixCard>
      )}
    </>
  );
}
