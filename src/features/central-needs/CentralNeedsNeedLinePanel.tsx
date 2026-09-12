/**
 * CN-2B CONFORMANCE (M212) — the operational need-line mapping surface.
 *
 * This is where an imported row stops being evidence and becomes an operational
 * requirement: beneficiary institution, canonical material, canonical unit and
 * approved annual quantity, persisted relationally by
 * `phoenix_central_needs_set_need_line`.
 *
 * THREE RULES THIS COMPONENT EXISTS TO HONOUR
 *
 *  1. MAPPING IS HUMAN-AUTHORITATIVE. Nothing is inferred from workbook family,
 *     sheet name, header text, sheet index, filename or row position. The
 *     beneficiary is chosen by a person, every time.
 *  2. A BULK ACTION IS STILL AN EXPLICIT ACT. Applying one beneficiary to many
 *     selected rows is offered because it is the difference between a usable
 *     review and an impossible one — but it previews the exact affected count
 *     and requires a second, separate confirmation before anything is written.
 *  3. THE SERVER DECIDES. Every check here is for a fast answer, never the
 *     authority: the RPC re-validates beneficiary eligibility, warehouse
 *     ownership, unit vocabulary, conversion state, quantity sign, revision
 *     editability, source lineage and the reason. A disabled button is a
 *     courtesy, not a control.
 *
 * Quantity is handled as TEXT end to end so an exact `numeric(20,3)` never
 * passes through a JavaScript float, and blank stays distinct from zero.
 */
import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import { getWarehouses, type Warehouse } from '@/shared/supabase/services/warehouses.service';
import {
  NEED_LINE_UNITS, setNeedLine, searchCentralItems,
  type CentralItemOption, type NeedLine, type NeedLineUnit,
  type RecordDisposition, type NeedLineSourceLink,
} from './central-needs.service';
import { centralNeedsErrorText } from './central-needs.i18n';

interface Props {
  lang: 'ar' | 'en';
  planRevisionId: string;
  /** Mapping may only change while the revision is still editable. */
  editable: boolean;
  /** Dispositions of this revision; only 'mapped' rows can feed a need line. */
  dispositions: RecordDisposition[];
  needLines: NeedLine[];
  /** Which (session, entity) pairs a need line already claims. */
  claimedSources: NeedLineSourceLink[];
  onSaved: () => void;
}

const key = (l: NeedLineSourceLink) => `${l.importSessionId}::${l.targetEntity}`;

export function CentralNeedsNeedLinePanel({
  lang, planRevisionId, editable, dispositions, needLines, claimedSources, onSaved,
}: Props) {
  const [institutions, setInstitutions] = useState<OrgRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<CentralItemOption[]>([]);
  const [itemQuery, setItemQuery] = useState('');

  const [beneficiary, setBeneficiary] = useState('');
  const [centralItemId, setCentralItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<NeedLineUnit>('box');
  const [conversionRequired, setConversionRequired] = useState(false);
  const [sourceUnitText, setSourceUnitText] = useState('');
  const [targetWarehouseId, setTargetWarehouseId] = useState('');
  const [reason, setReason] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only a live care institution may be a beneficiary — the same rule the
  // server enforces, surfaced early so the list never offers an invalid choice.
  useEffect(() => {
    let alive = true;
    getOrganizations()
      .then((rows) => {
        if (!alive) return;
        setInstitutions(rows.filter((o) => o.organizationKind === 'care_institution' && o.status === 'active'));
      })
      .catch(() => { if (alive) setInstitutions([]); });
    return () => { alive = false; };
  }, []);

  // A target warehouse must belong to the chosen beneficiary, so the list is
  // scoped to it and cleared whenever the beneficiary changes.
  useEffect(() => {
    setTargetWarehouseId('');
    if (!beneficiary) { setWarehouses([]); return; }
    let alive = true;
    getWarehouses(beneficiary)
      .then((rows) => { if (alive) setWarehouses(rows); })
      .catch(() => { if (alive) setWarehouses([]); });
    return () => { alive = false; };
  }, [beneficiary]);

  useEffect(() => {
    if (itemQuery.trim().length < 2) { setItems([]); return; }
    let alive = true;
    searchCentralItems(itemQuery.trim())
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [itemQuery]);

  /** Mapped rows are the only candidates; 'not_applicable' is evidence only. */
  const mappedRows = useMemo(
    () => dispositions.filter((d) => d.decision === 'mapped'),
    [dispositions],
  );
  const claimed = useMemo(() => new Set(claimedSources.map(key)), [claimedSources]);
  const unclaimed = useMemo(
    () => mappedRows.filter((d) => !claimed.has(key({ importSessionId: d.importSessionId, targetEntity: d.targetEntity }))),
    [mappedRows, claimed],
  );
  const complete = mappedRows.length > 0 && unclaimed.length === 0;

  const quantityValid = /^\d+(\.\d{1,3})?$/.test(quantity.trim());
  const canSave = editable && Boolean(beneficiary) && Boolean(centralItemId)
    && quantityValid && reason.trim().length > 0;

  async function commit() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const sourceTargetEntities: NeedLineSourceLink[] = [...selected].map((k) => {
        // Split at the FIRST separator only. `target_entity` is server-side free
        // text (`sheet:<i>:row:<n>` as the parser emits it today), so a future
        // producer could legitimately contain '::' and must round-trip intact.
        const at = k.indexOf('::');
        return { importSessionId: k.slice(0, at), targetEntity: k.slice(at + 2) };
      });
      await setNeedLine({
        planRevisionId,
        beneficiaryOrganizationId: beneficiary,
        centralItemId,
        approvedQuantity: quantity.trim(),
        mappingReason: reason.trim(),
        approvedUnit: conversionRequired ? null : unit,
        unitConversionState: conversionRequired ? 'conversion_required' : 'canonical',
        targetWarehouseId: targetWarehouseId || null,
        sourceUnitText: sourceUnitText.trim() || null,
        sourceTargetEntities,
      });
      setNotice(t('cn2b_nl_saved', lang));
      setSelected(new Set());
      setPreviewing(false);
      setReason('');
      onSaved();
    } catch (e) {
      // A server refusal is shown by its stable code, translated where known —
      // never flattened into a generic failure.
      setError(centralNeedsErrorText(
        e instanceof Error && 'code' in e ? String((e as { code?: unknown }).code ?? e.message) : String(e),
        lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard className="cn2b cn2b-needlines">
      <header>
        <h3>{t('cn2b_nl_title', lang)}</h3>
        <p>{t('cn2b_nl_subtitle', lang)}</p>
        <p data-testid="cn2b-nl-completeness">
          {complete ? t('cn2b_nl_complete', lang) : t('cn2b_nl_incomplete', lang)}
          {' '}({mappedRows.length - unclaimed.length}/{mappedRows.length})
        </p>
      </header>

      {!editable && <p data-testid="cn2b-nl-readonly">{t('cn2b_nl_readonly', lang)}</p>}

      {editable && (
        <div className="cn2b-nl-form">
          <label>
            {t('cn2b_nl_beneficiary', lang)}
            <select
              aria-label={t('cn2b_nl_beneficiary', lang)}
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
            >
              <option value="">—</option>
              {institutions.map((o) => (
                <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
              ))}
            </select>
          </label>
          <p>{t('cn2b_nl_beneficiary_hint', lang)}</p>

          <PhoenixInput
            label={t('cn2b_nl_item_search', lang)}
            value={itemQuery}
            onChange={(e) => setItemQuery(e.target.value)}
          />
          <select
            aria-label={t('cn2b_nl_item', lang)}
            value={centralItemId}
            onChange={(e) => setCentralItemId(e.target.value)}
          >
            <option value="">—</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>

          <PhoenixInput
            label={t('cn2b_nl_quantity', lang)}
            value={quantity}
            inputMode="decimal"
            onChange={(e) => setQuantity(e.target.value)}
          />
          <p>{t('cn2b_nl_quantity_hint', lang)}</p>

          <label>
            <input
              type="checkbox"
              checked={conversionRequired}
              onChange={(e) => setConversionRequired(e.target.checked)}
            />
            {t('cn2b_nl_unit_conversion_required', lang)}
          </label>

          {!conversionRequired && (
            <label>
              {t('cn2b_nl_unit', lang)}
              <select
                aria-label={t('cn2b_nl_unit', lang)}
                value={unit}
                onChange={(e) => setUnit(e.target.value as NeedLineUnit)}
              >
                {NEED_LINE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
          )}

          <PhoenixInput
            label={t('cn2b_nl_source_unit', lang)}
            value={sourceUnitText}
            onChange={(e) => setSourceUnitText(e.target.value)}
          />

          <label>
            {t('cn2b_nl_warehouse', lang)}
            <select
              aria-label={t('cn2b_nl_warehouse', lang)}
              value={targetWarehouseId}
              onChange={(e) => setTargetWarehouseId(e.target.value)}
            >
              <option value="">{t('cn2b_nl_warehouse_none', lang)}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{lang === 'ar' ? w.name_ar : w.name}</option>
              ))}
            </select>
          </label>
          <p>{t('cn2b_nl_warehouse_hint', lang)}</p>

          <PhoenixInput
            label={t('cn2b_nl_reason', lang)}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={reason.trim() === '' ? t('cn2b_nl_reason_required', lang) : undefined}
          />

          <fieldset>
            <legend>{t('cn2b_nl_selected_rows', lang)} ({selected.size})</legend>
            {unclaimed.length === 0 && <p>{t('cn2b_nl_bulk_no_selection', lang)}</p>}
            {unclaimed.map((d) => {
              const k = key({ importSessionId: d.importSessionId, targetEntity: d.targetEntity });
              return (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={selected.has(k)}
                    onChange={(e) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(k); else next.delete(k);
                      return next;
                    })}
                  />
                  {d.targetEntity}
                </label>
              );
            })}
          </fieldset>

          {/* A bulk action previews its exact reach and then asks again. */}
          {!previewing && (
            <PhoenixButton
              type="button"
              disabled={!canSave || busy}
              onClick={() => setPreviewing(true)}
            >
              {selected.size > 1 ? t('cn2b_nl_bulk_preview', lang) : t('cn2b_nl_save', lang)}
            </PhoenixButton>
          )}

          {previewing && (
            <div data-testid="cn2b-nl-preview">
              <p>{t('cn2b_nl_bulk_title', lang)}</p>
              <p>
                {t('cn2b_nl_bulk_affected', lang)}: <strong data-testid="cn2b-nl-affected">{selected.size}</strong>
              </p>
              <PhoenixButton type="button" disabled={busy} loading={busy} onClick={commit}>
                {t('cn2b_nl_bulk_confirm', lang)}
              </PhoenixButton>
              <PhoenixButton
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setPreviewing(false)}
              >
                {t('cn2b_nl_bulk_cancel', lang)}
              </PhoenixButton>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" data-testid="cn2b-nl-error">{error}</p>}
      {notice && <p data-testid="cn2b-nl-notice">{notice}</p>}

      <ul data-testid="cn2b-nl-list">
        {needLines.length === 0 && <li>{t('cn2b_nl_none_yet', lang)}</li>}
        {needLines.map((n) => (
          <li key={n.id}>
            {n.approvedQuantity}{' '}
            {n.unitConversionState === 'conversion_required'
              ? t('cn2b_nl_unit_conversion_required', lang)
              : n.approvedUnit}
            {' — '}
            {n.targetWarehouseId ? n.targetWarehouseId : t('cn2b_nl_warehouse_none', lang)}
          </li>
        ))}
      </ul>
    </PhoenixCard>
  );
}
