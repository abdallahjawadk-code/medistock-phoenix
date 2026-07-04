import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { upsertAvailability, classifyAvailabilitySaveError, getAvailabilityByPoint } from '@/shared/supabase/services/availability.service';
import { getOrganizations, getOrganization } from '@/shared/supabase/services/organizations.service';
import type { AvailabilityCondition } from '@/shared/lib/types';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface PointRow { id: string; name: string; name_ar: string; }

/**
 * Material status options.
 * 'expired' is intentionally NOT offered as a manual editor option in this
 * phase — it may be derived from expiry_date, and full canonicalization is
 * deferred to STATUS-LOGIC-CANONICALIZATION-A. Historical 'expired' rows are
 * unaffected and still display correctly in status/QR/filter views.
 * 'near_expiry' is also intentionally NOT offered here (STATUS-EDITOR-CLEANUP-A):
 * it is now derived automatically from expiry_date via the 9/6/3-month expiry
 * risk tiers (see src/shared/lib/expiry-risk.ts), so it is no longer a
 * manually chosen condition. The value remains a valid AvailabilityCondition
 * for legacy rows, DB/RPC compatibility, filters, and display — only manual
 * selection in this dropdown is removed.
 */
const CONDITION_OPTIONS: { value: AvailabilityCondition; labelKey: string }[] = [
  { value: 'available',   labelKey: 'cond_available' },
  { value: 'low_stock',   labelKey: 'cond_low_stock' },
  { value: 'missing',     labelKey: 'cond_missing' },
  { value: 'surplus',     labelKey: 'cond_surplus' },
];

export function EditorScreen() {
  const { lang, role, activeOrgId, setActiveOrgId, myPermissions } = useApp();
  const isSuper = role === 'super_admin';

  // Permission-matrix gating (AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A).
  // UX-only: the real security boundary is the DB (RLS + phoenix_upsert_availability RPC,
  // migration 032), which independently enforces availability.create/availability.update.
  const canViewAvailability   = myPermissions.has('availability.view');
  const canCreateAvailability = myPermissions.has('availability.create');
  const canUpdateAvailability = myPermissions.has('availability.update');
  const canAttemptSave        = canCreateAvailability || canUpdateAvailability;

  const points = useAsync<PointRow[]>(() => activeOrgId ? getPointsByOrg(activeOrgId) : Promise.resolve([]), [activeOrgId]);
  // Institution field data: super_admin gets the full org list (for the
  // dropdown they're allowed to switch between); everyone else only needs
  // their own org's name to render the locked display.
  const orgs  = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);
  const myOrg = useAsync(() => (!isSuper && activeOrgId) ? getOrganization(activeOrgId) : Promise.resolve(null), [isSuper, activeOrgId]);

  const [pointId, setPointId]   = useState('');
  const [scientificName, setScientificName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [dosageForm, setDosageForm] = useState('');
  const [concentrationVal, setConcentrationVal] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty]           = useState(0);
  const [condition, setCondition] = useState<AvailabilityCondition>('available');
  const [batch, setBatch]       = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [expiry, setExpiry]     = useState('');
  const [notes, setNotes]       = useState('');
  const [supplyType, setSupplyType] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [toast, setToast]       = useState<string | null>(null);

  // Rows already saved for the selected point — used only to detect whether
  // the in-progress entry matches an existing row (EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A).
  const pointAvailability = useAsync(() => pointId ? getAvailabilityByPoint(pointId) : Promise.resolve([]), [pointId]);

  // Detect whether the in-progress entry matches an already-saved row for this
  // point (EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A). Mirrors the exact 4-column
  // match key of the DB partial unique index (migration 029) and the RPC's
  // UPDATE-then-INSERT lookup (migration 030): distribution_point_id + scientific_name
  // (exact) + COALESCE(concentration,'') + COALESCE(dosage_form,'') — so this
  // never disagrees with what the server will actually do.
  const normKey = (v: string) => v.trim();
  const existingRow = useMemo(() => {
    const name = scientificName.trim();
    if (!name) return null;
    return (pointAvailability.data ?? []).find(r =>
      (r.scientific_name ?? '') === name &&
      normKey(r.concentration ?? '') === normKey(concentrationVal) &&
      normKey(r.dosage_form ?? '') === normKey(dosageForm)
    ) ?? null;
  }, [pointAvailability.data, scientificName, dosageForm, concentrationVal]);
  const isEditMode = !!existingRow;

  // AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A: populate the national code
  // field from the matched row when a match is first detected, so the user
  // can see/edit the value already stored server-side. Keyed on the matched
  // row's id (not the whole existingRow object) so this does not clobber
  // in-progress typing on every unrelated re-render (e.g. a background
  // pointAvailability reload) — it only re-syncs when the matched row itself
  // changes to a different id.
  useEffect(() => {
    if (existingRow) {
      setNationalCode(existingRow.national_code ?? '');
    }
  }, [existingRow?.id]);

  // AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A safety guard: the DB matching
  // key (distribution_point_id + scientific_name + concentration + dosage_form)
  // still does not include national_code, so a matched row's national_code
  // could otherwise be silently overwritten by whatever the user types here.
  // Blank submitted values never conflict (they simply omit p_national_code
  // and preserve the existing value via migration 050's RPC behavior) —
  // only a genuinely different non-empty value blocks the save.
  const normalizedSubmittedNationalCode = nationalCode.trim();
  const normalizedExistingNationalCode = (existingRow?.national_code ?? '').trim();
  const nationalCodeConflict = isEditMode
    && normalizedSubmittedNationalCode !== ''
    && normalizedExistingNationalCode !== ''
    && normalizedSubmittedNationalCode !== normalizedExistingNationalCode;

  const qtyInvalid = !isEditMode && qty < 0;
  const noPorts = !points.loading && (points.data ?? []).length === 0;
  // Attempt is allowed with either create or update — the RPC (migration 032)
  // determines whether the row is new (needs availability.create) or existing
  // (needs availability.update) and denies accordingly; see doApply's catch.
  const canSubmit = canAttemptSave && !!activeOrgId && !!pointId && !!scientificName.trim() && !qtyInvalid && !nationalCodeConflict;

  async function doApply() {
    if (!activeOrgId) return;
    // AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A safety guard, re-checked here
    // (defense in depth alongside the canSubmit/button-disable check above):
    // never call the RPC when a matched existing row has a different,
    // non-empty national_code already stored.
    if (nationalCodeConflict) {
      setShowConfirm(false);
      setToast(t('avail_national_code_conflict', lang));
      setTimeout(() => setToast(null), 4000);
      return;
    }
    setBusy(true);
    try {
      await upsertAvailability({
        scientificName: scientificName.trim(),
        tradeName: tradeName.trim() || undefined,
        dosageForm: dosageForm.trim() || undefined,
        concentrationValue: concentrationVal.trim() || undefined,
        price: price ? Number(price) : undefined,
        distributionPointId: pointId,
        organizationId: activeOrgId,
        // For an existing row, always resend its current DB quantity — never
        // the (disabled, unreachable) local qty state — so this save can never
        // silently overwrite stock. Quantity changes must go through the
        // Status Center's quantity-movement action instead.
        quantity: isEditMode ? existingRow!.quantity : qty,
        condition,
        batchNumber: batch || undefined,
        expiryDate: expiry || undefined,
        notes: notes || undefined,
        supplyType: supplyType || undefined,
        // Blank/whitespace-only never clears an existing national_code — see
        // upsertAvailability(), which omits p_national_code entirely in that
        // case.
        nationalCode: normalizedSubmittedNationalCode || undefined,
      });
      setShowConfirm(false);
      setToast(t('apply_success', lang));
      setTimeout(() => setToast(null), 3000);
      setBatch(''); setNotes(''); setNationalCode('');
      // Refresh the point's saved rows so a just-added material is picked up
      // as an existing row (isEditMode/existingRow) on the very next submit —
      // without this, a second Apply for the same material would still look
      // like a brand-new row locally and could resend a stale quantity.
      // useAsync.reload() isolates its own failure internally (logs to
      // console, sets its own error state) — it never throws back here, so a
      // reload hiccup can't overwrite this success toast with a false error.
      pointAvailability.reload();
    } catch (e) {
      console.error('[phoenix] availability upsert failed:', e);
      setShowConfirm(false);
      setToast(t(classifyAvailabilitySaveError(e), lang));
      setTimeout(() => setToast(null), 3000);
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;
  const lockedFieldStyle = { ...fieldStyle, background: 'var(--s2)', color: 'var(--t2)', cursor: 'default' } as const;

  const myOrgName = myOrg.data ? (lang === 'ar' ? myOrg.data.name_ar : myOrg.data.name) : '';

  return (
    <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_editor', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('editor_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {!activeOrgId && <PhoenixEmptyState icon="🏥" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />}

      {activeOrgId && !canViewAvailability && (
        <PhoenixEmptyState icon="🔒" title={t('avail_no_edit_permission', lang)} description={t('avail_no_edit_permission', lang)} />
      )}

      {activeOrgId && canViewAvailability && (
        <>
          <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
              {/* Institution — locked display for institution-scoped users,
                  dropdown only for super_admin */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-inst" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_inst_label', lang)} *</label>
                {isSuper ? (
                  <select id="ed-inst" value={activeOrgId ?? ''} onChange={e => setActiveOrgId(e.target.value || null)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                    <option value="">— {t('select_inst', lang)} —</option>
                    {(orgs.data ?? []).map(o => <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>)}
                  </select>
                ) : (
                  <>
                    <div id="ed-inst" style={lockedFieldStyle} dir="auto">
                      {myOrg.loading ? t('loading', lang) : (myOrgName || '—')}
                    </div>
                    <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
                      {t('avail_inst_locked_note', lang)}
                    </p>
                  </>
                )}
              </div>

              {/* Distribution point / port dropdown */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-point" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_point_select', lang)} *</label>
                <select id="ed-point" value={pointId} onChange={e => setPointId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }} disabled={noPorts}>
                  <option value="">— {points.loading ? t('loading', lang) : t('avail_point_select', lang)} —</option>
                  {(points.data ?? []).map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
                </select>
                {noPorts && (
                  <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }} dir="auto">
                    {t('avail_no_ports', lang)}
                  </p>
                )}
              </div>

              {/* Scientific name (required) */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-sciname" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_scientific_name', lang)} *</label>
                <input id="ed-sciname" type="text" dir="auto" value={scientificName} onChange={e => setScientificName(e.target.value)}
                  placeholder={t('avail_scientific_ph', lang)} style={fieldStyle} />
              </div>

              {/* Trade name (optional) */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-tradename" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_trade_name', lang)}</label>
                <input id="ed-tradename" type="text" dir="auto" value={tradeName} onChange={e => setTradeName(e.target.value)}
                  placeholder={t('avail_trade_ph', lang)} style={fieldStyle} />
              </div>

              {/* Dosage form (half width) */}
              <div>
                <label htmlFor="ed-dosage" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_dosage_form', lang)}</label>
                <input id="ed-dosage" type="text" dir="auto" value={dosageForm} onChange={e => setDosageForm(e.target.value)}
                  placeholder={t('avail_dosage_ph', lang)} style={fieldStyle} />
              </div>

              {/* Concentration (half width) */}
              <div>
                <label htmlFor="ed-concentration" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_concentration', lang)}</label>
                <input id="ed-concentration" type="text" dir="auto" value={concentrationVal} onChange={e => setConcentrationVal(e.target.value)}
                  placeholder={t('avail_concentration_ph', lang)} style={fieldStyle} />
              </div>

              {/* Price (half width) */}
              <div>
                <label htmlFor="ed-price" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_price', lang)}</label>
                <input id="ed-price" type="number" min={0} step="any" value={price} onChange={e => setPrice(e.target.value)}
                  placeholder={t('avail_price_ph', lang)} style={fieldStyle} />
              </div>

              {/* Quantity (half width) — read-only for existing rows; see
                  EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A. Quantity changes for an
                  existing row must go through Status Center → Adjust Quantity. */}
              <div>
                <label htmlFor="ed-qty" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('qty', lang)} *</label>
                <input
                  id="ed-qty"
                  type="number"
                  min={0}
                  value={isEditMode ? existingRow!.quantity : qty}
                  onChange={e => setQty(Number(e.target.value))}
                  disabled={isEditMode}
                  readOnly={isEditMode}
                  style={{
                    ...fieldStyle,
                    border: `1px solid ${qtyInvalid ? 'var(--err)' : 'var(--brd)'}`,
                    background: isEditMode ? 'var(--s2)' : (qtyInvalid ? 'var(--err2)' : 'var(--s)'),
                    color: isEditMode ? 'var(--t2)' : 'var(--t)',
                    cursor: isEditMode ? 'default' : 'text',
                  }}
                />
                {qtyInvalid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>⚠ {t('qty_err', lang)}</p>}
                {isEditMode && (
                  <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
                    {t('avail_qty_locked_note', lang)}
                  </p>
                )}
              </div>

              {/* Material status (localized) */}
              <div>
                <label htmlFor="ed-cond" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_material_status', lang)}</label>
                <select id="ed-cond" value={condition} onChange={e => setCondition(e.target.value as AvailabilityCondition)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  {CONDITION_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{t(opt.labelKey, lang)}</option>)}
                </select>
                <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
                  {t('avail_near_expiry_auto_note', lang)}
                </p>
              </div>

              {/* National code (AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A: a real,
                  independent field backed by item_availability.national_code —
                  migration 049 added the column, migration 050 taught
                  phoenix_upsert_availability to save it. Separate from the
                  Batch No. field below; never reuses batch_number storage. */}
              <div>
                <label htmlFor="ed-national-code" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_national_code', lang)}</label>
                <input
                  id="ed-national-code"
                  type="text"
                  dir="ltr"
                  value={nationalCode}
                  onChange={e => setNationalCode(e.target.value)}
                  placeholder={t('avail_national_code_ph', lang)}
                  style={{
                    ...fieldStyle,
                    fontFamily: 'monospace',
                    border: `1px solid ${nationalCodeConflict ? 'var(--err)' : 'var(--brd)'}`,
                    background: nationalCodeConflict ? 'var(--err2)' : 'var(--s)',
                  }}
                />
                {nationalCodeConflict && (
                  <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }} dir="auto">
                    ⚠ {t('avail_national_code_conflict', lang)}
                  </p>
                )}
                <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
                  {t('avail_national_code_now_separate_note', lang)}
                </p>
              </div>

              {/* Batch number — the batch_number column, kept fully separate from
                  national_code above (DATA-MODEL-NATIONAL-CODE-SEPARATION-A /
                  AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A). */}
              <div>
                <label htmlFor="ed-batch" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('batch_no', lang)}</label>
                <input id="ed-batch" type="text" dir="ltr" value={batch} onChange={e => setBatch(e.target.value)} placeholder={t('avail_batch_no_ph', lang)} style={{ ...fieldStyle, fontFamily: 'monospace' }} />
              </div>

              {/* Expiry */}
              <div>
                <label htmlFor="ed-exp" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('expiry', lang)}</label>
                <input id="ed-exp" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={fieldStyle} />
              </div>

              {/* Supply type — institution-private */}
              <div>
                <label htmlFor="ed-supply" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('avail_supply_type', lang)}</label>
                <input id="ed-supply" type="text" dir="auto" value={supplyType} onChange={e => setSupplyType(e.target.value)}
                  placeholder={t('avail_supply_type_ph', lang)} style={fieldStyle} />
              </div>

              {/* Notes */}
              <div style={{ gridColumn: '1/-1' }}>
                <label htmlFor="ed-notes" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('notes', lang)}</label>
                <textarea id="ed-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('notes_ph', lang)} style={{ ...fieldStyle, resize: 'vertical' }} />
              </div>
            </div>
          </PhoenixCard>

          {canAttemptSave ? (
            <>
              <PhoenixButton variant="primary" size="lg" fullWidth disabled={!canSubmit} onClick={() => setShowConfirm(true)}>
                {t('apply', lang)}
              </PhoenixButton>
              <p style={{ textAlign: 'center', fontSize: '11px', color: 'var(--t3)', marginTop: '8px' }}>{t('apply_note', lang)}</p>
            </>
          ) : (
            <p style={{ textAlign: 'center', fontSize: '12.5px', color: 'var(--err)', marginTop: '8px' }} dir="auto">
              {t('avail_no_edit_permission', lang)}
            </p>
          )}
        </>
      )}

      {/* Confirm dialog */}
      <PhoenixDialog open={showConfirm} onClose={() => setShowConfirm(false)} title={t('confirm_apply', lang)}>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <p style={{ fontSize: '13px', color: 'var(--t2)', lineHeight: 1.65 }}>{t('confirm_msg', lang)}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setShowConfirm(false)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} onClick={doApply}>{t('confirm_btn', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}
