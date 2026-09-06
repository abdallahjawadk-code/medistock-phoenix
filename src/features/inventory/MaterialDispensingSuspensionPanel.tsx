import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixMaterialResolver } from '@/shared/materials/PhoenixMaterialResolver';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import {
  getMaterialDispensingSuspensions, suspendMaterialDispensing, liftMaterialDispensingSuspension,
  materialDispensingSuspensionReasonLabel,
  type MaterialDispensingSuspensionRow, type SuspensionReasonCode,
} from './material-dispensing-suspension.service';
import {
  useMaterialDispensingSuspensionPermission, suspensionPermissionScopeKey,
} from './useMaterialDispensingSuspensionPermission';
import { useInventoryScopes, type InventoryScopeOption } from './useInventoryScopes';
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';
import {
  useGuideExampleRow, useGuidePresence, useScopedGuideCapabilities,
} from '@/features/guide/guide.surface';

const newRequestId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const REASON_CODES: SuspensionReasonCode[] = [
  'regulatory_hold', 'recall_investigation', 'clinical_safety_concern',
  'quality_investigation', 'license_or_permit_issue', 'supply_integrity_concern', 'other',
];

interface Props {
  organizationId: string;
}

/**
 * MATERIAL-DISPENSING-SUSPENSION panel — views every موقوف الصرف record for
 * an organization and suspends/lifts via migration 203's RPCs.
 *
 * Deliberately a SEPARATE panel from QuarantinePanel, not a mode of it — the
 * two domains never share a row, a badge, or a translated string.
 *
 * SCOPE: both org-wide AND outlet-scoped suspensions are exposed here, per
 * 187's `phoenix_profile_has_scoped_permission` — an org-wide claim
 * (NULL,NULL) is restricted to `institution_admin` (its own
 * `v_org_wide_roles`), but a point-scoped claim additionally passes for any
 * role holding `material_dispensing_suspension.create` (203 seeds
 * central_warehouse_manager too) WITH a point assignment at that exact
 * outlet — a genuinely different, wider set of actors than the org-wide
 * gate alone would ever let through. `useInventoryScopes` supplies the
 * outlet candidate list, narrowed to the caller's own effective scope
 * exactly like every other outlet-scoped write surface in this codebase;
 * the per-scope RPC re-check inside SuspendForm is what actually decides,
 * this list is only ever a candidate set.
 */
export function MaterialDispensingSuspensionPanel({ organizationId }: Props) {
  const { lang, dir } = useApp();
  const perm = useMaterialDispensingSuspensionPermission(organizationId, null);
  const [rows, setRows] = useState<MaterialDispensingSuspensionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  // The org-wide canSuspend answer doubles as this hook's own
  // "sees every outlet" signal (its documented contract: an exact
  // organization-level grant for the SAME permission this catalog is being
  // asked about legitimately covers every scope). When it is false the
  // catalog still resolves — narrowed to whatever outlets this profile is
  // actually assigned to — which is exactly the set a non-org-wide
  // central_warehouse_manager may act on.
  const scopes = useInventoryScopes(organizationId, perm.data?.canSuspend ?? false);
  const manageableOutlets: InventoryScopeOption[] = scopes.data?.manageableOutlets ?? [];
  const resolveOutletName = (id: string): string | null => {
    const opt = scopes.data?.resolve('outlet', id);
    if (!opt) return null;
    return lang === 'ar' ? (opt.nameAr || opt.name) : (opt.name || opt.nameAr);
  };

  const reload = useCallback(async () => {
    if (!organizationId) { setRows([]); return; }
    setLoading(true);
    setError(null);
    try {
      setRows(await getMaterialDispensingSuspensions(organizationId));
    } catch {
      setError(t('err_generic', lang));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId, lang]);

  useEffect(() => { void reload(); }, [reload]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const canViewDetail = perm.data?.canViewDetail ?? false;
  // canSuspendAnywhere: org-wide OR at least one outlet this profile can
  // actually reach — the button/form only need to be REACHABLE here; the
  // exact scope (and therefore the exact permission) is re-decided inside
  // SuspendForm once a scope is chosen, and re-checked again server-side.
  const canSuspendOrgWide = perm.data?.canSuspend ?? false;
  const canSuspendAnywhere = canSuspendOrgWide || manageableOutlets.length > 0;
  const canLift = perm.data?.canLift ?? false;

  /**
   * INTERACTIVE-GUIDE-IG2 — publish the DECISIONS this panel computed.
   *
   * TWO DIFFERENT QUESTIONS, PUBLISHED SEPARATELY. Conflating them is exactly
   * the mistake this module's own doc comment warns about, and the earlier
   * version made it:
   *
   *   • `…suspension.create` — may this operator REACH the create surface at
   *     all? That is `canSuspendAnywhere`, and it is what governs whether the
   *     button renders. It is deliberately NOT a scope authorization: it is
   *     true partly because `manageableOutlets` is non-empty, and a candidate
   *     outlet is a candidate, not a grant.
   *   • `…suspension.create.orgwide` — the one PROVEN scoped answer at this
   *     level, the org-wide (NULL,NULL) claim migration 187 decides. Nothing
   *     derived from the candidate list can ever set it.
   *
   * So the guide may say "this is where a suspension is created" without ever
   * implying the operator may create one at a particular outlet. `SuspendForm`
   * re-asks the scoped hook once a scope is chosen, and the RPC re-checks it
   * server-side; reaching the form authorizes nothing.
   *
   * THE STATE COVERS BOTH READS. `canSuspendAnywhere` depends on the outlet
   * catalog as well as on the permission, so publishing only `perm`'s state
   * would have declared a confident `ready` while `manageableOutlets` was
   * still empty because the catalog had not arrived — or, worse, had FAILED.
   * An empty candidate list from a failed read is not a decision, and is not
   * published as one.
   */
  const scopedState: 'loading' | 'error' | 'ready' =
    (perm.loading || scopes.loading) ? 'loading'
      : (perm.error || scopes.error) ? 'error'
        : 'ready';
  useScopedGuideCapabilities(
    'inventory.suspension',
    {
      'inventory.suspension.view': canViewDetail,
      'inventory.suspension.create': canSuspendAnywhere,
      'inventory.suspension.create.orgwide': canSuspendOrgWide,
      'inventory.suspension.lift': canLift,
    },
    scopedState,
    suspensionPermissionScopeKey(organizationId, null),
    // The catalog half of `canSuspendAnywhere` needs no separate tag:
    // useInventoryScopes already refuses a catalog belonging to another
    // organization and reports `loading` until its own has arrived.
    perm.dataScopeKey,
  );

  const active = useMemo(() => (rows ?? []).filter(r => !r.liftedAt), [rows]);
  const history = useMemo(() => (rows ?? []).filter(r => r.liftedAt), [rows]);

  /**
   * IG-2 — ONE declared example row, frozen by identity for as long as it is
   * still in the list. See useGuideExampleRow: "whichever is first right now"
   * would let the highlight move to a different suspension mid-explanation
   * after a lift reorders the list.
   */
  const activeIds = useMemo(() => active.map(r => r.id), [active]);
  const exampleRowId = useGuideExampleRow(activeIds);

  // Which branch will render, decided ONCE so the presence declaration and the
  // JSX beneath it cannot drift apart.
  const showForbidden = !canViewDetail && !perm.loading;
  const showLoading = !showForbidden && loading && rows === null;
  const showError = !showForbidden && !showLoading && error !== null;
  const showBody = !showForbidden && !showLoading && !showError;

  /**
   * IG-2 — element presence: neither a permission nor a data state.
   *
   * "Only lifted records and no active suspension" is a real, reachable state
   * of this panel: the region and the history exist, but there is no active
   * row, so the steps about a row's scope and badge are REMOVED rather than
   * falling back to a centred card describing something not on screen.
   */
  useGuidePresence('inventory.suspension', {
    'inventory.suspension.region': showBody,
    'inventory.suspension.row': showBody && exampleRowId !== null,
    'inventory.suspension.rowActions': showBody && exampleRowId !== null && canLift,
    'inventory.suspension.history': showBody && history.length > 0,
    'inventory.suspension.createArea': showBody && canSuspendAnywhere,
  });

  if (showForbidden) {
    return <PhoenixEmptyState icon="🚫" title={t('e_forbidden_material_dispensing_suspension_view_badge', lang)} description="" />;
  }
  if (showLoading) return <PhoenixLoadingState />;
  if (showError) return <PhoenixErrorState title={t('err_generic', lang)} message={error ?? ''} onRetry={reload} />;

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}

      {(canSuspendAnywhere || composing) && (
        /* IG-2 — the create AREA, present whether the button or the composer
           the operator opened from it is showing. The precise button-wrapper
           anchor inside disappears once the composer is open, and the create
           step must not silently degrade to a centred card then: it keeps the
           button wrapper as its first anchor and this region as its declared
           fallback. */
        <div {...guideAnchor(GUIDE_ANCHORS.suspensionCreateArea)}>
          {canSuspendAnywhere && !composing && (
            <div {...guideAnchor(GUIDE_ANCHORS.suspensionSuspendAction)}>
              {/* The anchor is the wrapper, never the button: the guide explains
                  this control, it never opens the composer. */}
              <PhoenixButton onClick={() => setComposing(true)}>{t('mds_suspend_action', lang)}</PhoenixButton>
            </div>
          )}

          {composing && (
            <SuspendForm
              lang={lang}
              organizationId={organizationId}
              canSuspendOrgWide={canSuspendOrgWide}
              manageableOutlets={manageableOutlets}
              onCancel={() => setComposing(false)}
              onDone={(msg) => { setComposing(false); showToast(msg); void reload(); }}
              onError={showToast}
            />
          )}
        </div>
      )}

      {active.length === 0 && history.length === 0 ? (
        /* The empty state IS the list region: same anchor, so the step naming
           it keeps a real, correctly-placed target. */
        <div {...guideAnchor(GUIDE_ANCHORS.suspensionList)}>
          <PhoenixEmptyState icon="⛔" title={t('mds_history_empty', lang)} description="" />
        </div>
      ) : (
        <div {...guideAnchor(GUIDE_ANCHORS.suspensionList)} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {active.map(row => (
            <SuspensionRow
              key={row.id} row={row} lang={lang} canLift={canLift}
              /* IG-2: exactly one active row carries the row-level anchors, and
                 it is the frozen example above — never "whichever is first". */
              guideAnchored={row.id === exampleRowId}
              resolveOutletName={resolveOutletName}
              busy={busyId === row.id}
              onBusy={busy => setBusyId(busy ? row.id : null)}
              onDone={(msg) => { showToast(msg); void reload(); }}
              onError={showToast}
            />
          ))}
          {history.length > 0 && (
            <details {...guideAnchor(GUIDE_ANCHORS.suspensionHistory)}>
              <summary style={{ fontSize: '12px', color: 'var(--t2)', cursor: 'pointer' }}>{t('mds_history_title', lang)}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {history.map(row => (
                  <SuspensionRow key={row.id} row={row} lang={lang} canLift={false}
                    guideAnchored={false}
                    resolveOutletName={resolveOutletName}
                    busy={false} onBusy={() => {}} onDone={() => {}} onError={() => {}} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

const reasonLabel = materialDispensingSuspensionReasonLabel;

interface SuspendFormProps {
  lang: 'ar' | 'en';
  organizationId: string;
  /** Whether this profile can make the pure org-wide (NULL,NULL) claim. */
  canSuspendOrgWide: boolean;
  /** This profile's candidate outlets — a candidate set only; the live
   *  per-scope RPC check below is the actual gate. */
  manageableOutlets: InventoryScopeOption[];
  onCancel: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function SuspendForm({
  lang, organizationId, canSuspendOrgWide, manageableOutlets, onCancel, onDone, onError,
}: SuspendFormProps) {
  const [material, setMaterial] = useState<ResolvedMaterial | null>(null);
  const [reasonCode, setReasonCode] = useState<SuspensionReasonCode>('regulatory_hold');
  const [reasonDetail, setReasonDetail] = useState('');
  const [referenceDocument, setReferenceDocument] = useState('');
  const [busy, setBusy] = useState(false);
  // Default to org-wide only when this profile can actually make that claim;
  // otherwise the only reachable scope is a specific outlet (a
  // central_warehouse_manager who is not institution_admin — see the panel's
  // own doc comment on why that is a REAL, intended actor here).
  const [scopeType, setScopeType] = useState<'org_wide' | 'outlet'>(canSuspendOrgWide ? 'org_wide' : 'outlet');
  const [outletId, setOutletId] = useState('');

  // The scope choice is offered only when there is a genuine choice; a
  // profile with exactly one reachable scope shape skips the selector and
  // goes straight to it (org-wide unchanged from before this feature;
  // outlet-only is the newly-reachable case).
  const offerScopeChoice = canSuspendOrgWide && manageableOutlets.length > 0;
  const effectiveDistributionPointId = scopeType === 'outlet' ? (outletId || null) : null;

  // LIVE, PER-SCOPE authorization — re-asks the exact same hook the panel
  // used for its org-wide-only preflight, now with whichever scope is
  // currently selected. This is what makes an outlet-scoped
  // central_warehouse_manager's OWN outlet submittable and a different,
  // out-of-scope outlet correctly refused before they ever reach the RPC —
  // never hardcoded, never re-derived from role name.
  const scopedPerm = useMaterialDispensingSuspensionPermission(
    organizationId,
    scopeType === 'outlet' ? (outletId || null) : null,
  );
  const scopedCanSuspend = scopeType === 'outlet'
    ? (outletId !== '' && (scopedPerm.data?.canSuspend ?? false))
    : canSuspendOrgWide;

  const detailRequired = reasonCode === 'other';
  const valid = !!material?.centralItemId && scopedCanSuspend &&
    (!detailRequired || reasonDetail.trim() !== '');

  const submit = async () => {
    if (busy || !valid || !material?.centralItemId) return;
    setBusy(true);
    const result = await suspendMaterialDispensing({
      requestId: newRequestId(),
      centralItemId: material.centralItemId,
      organizationId,
      reasonCode,
      distributionPointId: effectiveDistributionPointId,
      reasonDetail: reasonDetail.trim() || null,
      referenceDocument: referenceDocument.trim() || null,
    });
    setBusy(false);
    if (result.ok) onDone(t('mds_suspend_success', lang));
    else onError(t(`e_${result.error}`, lang));
  };

  return (
    <PhoenixCard>
      <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>{t('mds_suspend_confirm_title', lang)}</div>
      <div style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '10px' }}>{t('mds_suspend_confirm_body', lang)}</div>
      <div style={{ display: 'grid', gap: '8px' }}>
        {material ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
            <span style={{ fontWeight: 700 }}>{material.scientificName}</span>
            <PhoenixButton variant="ghost" onClick={() => setMaterial(null)}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        ) : (
          <PhoenixMaterialResolver lang={lang} onSelect={setMaterial} label={t('mds_suspend_action', lang)} />
        )}

        {offerScopeChoice && (
          <PhoenixSelect
            label={t('mds_scope_selector_label', lang)}
            value={scopeType}
            onChange={e => { setScopeType(e.target.value as 'org_wide' | 'outlet'); setOutletId(''); }}
            options={[
              { value: 'org_wide', label: t('mds_scope_org_wide', lang) },
              { value: 'outlet', label: t('mds_scope_point', lang) },
            ]}
          />
        )}

        {scopeType === 'outlet' && (
          manageableOutlets.length === 0 ? (
            <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>{t('mds_scope_no_outlets', lang)}</div>
          ) : (
            <PhoenixSelect
              label={t('mds_scope_outlet_select_label', lang)}
              value={outletId}
              onChange={e => setOutletId(e.target.value)}
              options={[
                { value: '', label: t('mv_outlet', lang) },
                ...manageableOutlets.map(o => ({ value: o.id, label: lang === 'ar' ? (o.nameAr || o.name) : (o.name || o.nameAr) })),
              ]}
            />
          )
        )}

        {scopeType === 'outlet' && outletId && !scopedPerm.loading && !scopedCanSuspend && (
          <div style={{ fontSize: '11.5px', color: 'var(--err)' }}>{t('e_forbidden_material_dispensing_suspension_create', lang)}</div>
        )}

        <PhoenixSelect
          label={t('mds_reason_label', lang)}
          value={reasonCode}
          onChange={e => setReasonCode(e.target.value as SuspensionReasonCode)}
          options={REASON_CODES.map(code => ({ value: code, label: reasonLabel(code, lang) }))}
        />
        <PhoenixInput
          label={t('mds_reason_detail_label', lang)}
          value={reasonDetail}
          onChange={e => setReasonDetail(e.target.value)}
          disabled={busy}
        />
        {detailRequired && reasonDetail.trim() === '' && (
          <div style={{ fontSize: '11.5px', color: 'var(--danger)' }}>{t('mds_reason_detail_required', lang)}</div>
        )}
        <PhoenixInput
          label={t('mds_reference_document_label', lang)}
          value={referenceDocument}
          onChange={e => setReferenceDocument(e.target.value)}
          disabled={busy}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <PhoenixButton disabled={busy || !valid} onClick={() => void submit()}>{t('mds_suspend_action', lang)}</PhoenixButton>
          <PhoenixButton variant="ghost" disabled={busy} onClick={onCancel}>{t('mv_cancel', lang)}</PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

interface RowProps {
  row: MaterialDispensingSuspensionRow;
  lang: 'ar' | 'en';
  canLift: boolean;
  /** IG-2 — carry the guide's row-level anchors; the first active row only. */
  guideAnchored: boolean;
  /** Best-effort outlet-name lookup for a point-scoped row — null when the
   *  outlet catalog has not resolved yet or the point is outside this
   *  viewer's own readable catalog; the generic mds_scope_point label is
   *  always shown regardless, this only adds the name alongside it. */
  resolveOutletName: (id: string) => string | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function SuspensionRow({ row, lang, canLift, guideAnchored, resolveOutletName, busy, onBusy, onDone, onError }: RowProps) {
  const [lifting, setLifting] = useState(false);
  const [liftReason, setLiftReason] = useState('');
  const isActive = !row.liftedAt;
  const materialName = lang === 'ar' ? (row.materialNameAr || row.materialName) : (row.materialName || row.materialNameAr);

  const submitLift = async () => {
    if (busy || liftReason.trim() === '') return;
    onBusy(true);
    const result = await liftMaterialDispensingSuspension({
      requestId: newRequestId(), suspensionId: row.id, liftReason: liftReason.trim(),
    });
    onBusy(false);
    if (result.ok) { onDone(t('mds_lift_success', lang)); setLifting(false); }
    else onError(t(`e_${result.error}`, lang));
  };

  return (
    <PhoenixCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 700 }}>{materialName || '—'}</span>
            <span {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.suspensionRowBadge) : {})} style={{ display: 'inline-flex' }}>
              <PhoenixStatusBadge variant={isActive ? 'err' : 'neutral'} label={isActive ? t('mds_badge', lang) : t('mds_status_lifted', lang)} />
            </span>
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
            {reasonLabel(row.reasonCode, lang)}
          </div>
          <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.suspensionRowScope) : {})} style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {row.distributionPointId
              ? `${t('mds_scope_point', lang)}${resolveOutletName(row.distributionPointId) ? ` — ${resolveOutletName(row.distributionPointId)}` : ''}`
              : t('mds_scope_org_wide', lang)}
            {row.referenceDocument ? ` · ${row.referenceDocument}` : ''}
          </div>
          {row.reasonDetail && (
            <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>{row.reasonDetail}</div>
          )}
        </div>
      </div>

      {isActive && (canLift || lifting) && (
        /* IG-2 — the lift AREA, present whether the button or the reason form
           the operator opened from it is showing; the lift step falls back
           here rather than to a centred card. */
        <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.suspensionRowActions) : {})}>
          {canLift && !lifting && (
            <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.suspensionLiftAction) : {})} style={{ marginTop: '10px' }}>
              <PhoenixButton variant="secondary" onClick={() => setLifting(true)}>{t('mds_lift_action', lang)}</PhoenixButton>
            </div>
          )}

          {lifting && (
            <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
              <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('mds_lift_confirm_body', lang)}</div>
              <PhoenixInput label={t('mds_lift_reason_label', lang)} value={liftReason} disabled={busy}
                onChange={e => setLiftReason(e.target.value)} />
              <div style={{ display: 'flex', gap: '8px' }}>
                <PhoenixButton disabled={busy || liftReason.trim() === ''} onClick={() => void submitLift()}>
                  {t('mds_lift_action', lang)}
                </PhoenixButton>
                <PhoenixButton variant="ghost" disabled={busy} onClick={() => setLifting(false)}>{t('mv_cancel', lang)}</PhoenixButton>
              </div>
            </div>
          )}
        </div>
      )}
    </PhoenixCard>
  );
}
