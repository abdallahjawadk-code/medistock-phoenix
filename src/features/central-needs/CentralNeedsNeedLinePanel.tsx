/**
 * CN-2B CONFORMANCE (M212) — the operational need-line mapping surface.
 *
 * This is where an imported row stops being evidence and becomes an operational
 * requirement: beneficiary institution, canonical material, canonical unit and
 * approved annual quantity, persisted relationally by
 * `phoenix_central_needs_set_need_line`.
 *
 * FOUR RULES THIS COMPONENT EXISTS TO HONOUR
 *
 *  1. MAPPING IS HUMAN-AUTHORITATIVE. Nothing is inferred from workbook family,
 *     sheet name, header text, sheet index, filename or row position. The
 *     beneficiary is chosen by a person, every time.
 *  2. THE APPROVED QUANTITY IS ITS OWN PROVENANCE. A need line is built by
 *     designating the exact imported source records it comes from and what each
 *     contributes; the approved total is their sum, computed here in EXACT
 *     decimal arithmetic (never a JavaScript float) and re-derived server-side.
 *     There is no way to save a line with no source: the action is disabled, and
 *     the RPC refuses it regardless.
 *  3. A BULK ACTION IS STILL AN EXPLICIT ACT. Designating records across several
 *     canonical materials creates one need line per material — previewed with
 *     the exact counts, and written only after a second, separate confirmation.
 *  4. THE SERVER DECIDES. Every check here is for a fast answer, never the
 *     authority: the RPC re-validates beneficiary eligibility, warehouse
 *     ownership, unit vocabulary, conversion state, quantity finiteness, source
 *     lineage, material agreement and the provenance sum. A disabled button is a
 *     courtesy, not a control.
 *
 * The canonical material is never chosen here. It is READ from each row's
 * existing `central_needs_record_mappings` decision, so this surface cannot
 * become a competing source of material truth (v7.3 section 14) — and a source
 * reviewed as material A can never feed a line for material B.
 */
import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import { getWarehouses, type Warehouse } from '@/shared/supabase/services/warehouses.service';
import {
  NEED_LINE_UNITS, setNeedLine,
  type FieldOverride, type NeedLine, type NeedLineQuantitySource, type NeedLineSourceLink,
  type NeedLineUnit, type RecordDisposition, type SourceRecord,
} from './central-needs.service';
import { centralNeedsErrorText } from './central-needs.i18n';

interface Props {
  lang: 'ar' | 'en';
  planRevisionId: string;
  /** Mapping may only change while the revision is still editable. */
  editable: boolean;
  /** Dispositions of the active session; only 'mapped' rows can feed a line. */
  dispositions: RecordDisposition[];
  /** Source records of the active session — the designatable evidence. */
  records: SourceRecord[];
  /** Field overrides of this revision, so a normalized value can be pinned. */
  overrides: FieldOverride[];
  needLines: NeedLine[];
  /** Which source records a need line already claims. */
  claimedSources: NeedLineSourceLink[];
  onSaved: () => void;
}

/** A plain non-negative decimal. No exponent, no sign, no thousands separator. */
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Exact decimal addition.
 *
 * The approved quantity must equal the sum of the designated contributions, and
 * the server compares them as PostgreSQL `numeric`. Summing with `Number` would
 * make 0.1 + 0.2 disagree with the database and reject a correct mapping, so the
 * values are scaled to integers and added as BigInt.
 */
export function sumExactDecimals(values: readonly string[]): string {
  const parts = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (parts.length === 0) return '0';
  if (!parts.every((v) => DECIMAL.test(v))) return '';
  const scale = parts.reduce((m, v) => Math.max(m, (v.split('.')[1] ?? '').length), 0);
  const scaled = parts.map((v) => {
    const [whole, frac = ''] = v.split('.');
    return BigInt(whole + frac.padEnd(scale, '0'));
  });
  const total = scaled.reduce((a, b) => a + b, 0n).toString().padStart(scale + 1, '0');
  if (scale === 0) return total;
  return `${total.slice(0, total.length - scale)}.${total.slice(total.length - scale)}`;
}

/** The raw imported value of one record, as text, when it is a plain decimal. */
function rawDecimal(record: SourceRecord): string | null {
  const v = (record.sourceValues as { value?: unknown }).value;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && DECIMAL.test(v.trim())) return v.trim();
  return null;
}

/** A field override's final value as text, when it is a plain decimal. */
function overrideDecimal(o: FieldOverride): string | null {
  const v = o.finalValue;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && DECIMAL.test(v.trim())) return v.trim();
  return null;
}

interface Designation {
  /** The reviewer's contribution for this record — a suggestion until edited. */
  quantity: string;
  /** Set when the reviewer based it on a recorded override. */
  overrideId: string | null;
}

export function CentralNeedsNeedLinePanel({
  lang, planRevisionId, editable, dispositions, records, overrides, needLines, claimedSources, onSaved,
}: Props) {
  const [institutions, setInstitutions] = useState<OrgRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [beneficiary, setBeneficiary] = useState('');
  const [unit, setUnit] = useState<NeedLineUnit>('box');
  const [conversionRequired, setConversionRequired] = useState(false);
  const [sourceUnitText, setSourceUnitText] = useState('');
  const [targetWarehouseId, setTargetWarehouseId] = useState('');
  const [reason, setReason] = useState('');

  const [designated, setDesignated] = useState<Record<string, Designation>>({});
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

  /** Which row is mapped to which canonical material — read, never decided here. */
  const mappedItemByEntity = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dispositions) {
      if (d.decision === 'mapped' && d.centralItemId) m.set(d.targetEntity, d.centralItemId);
    }
    return m;
  }, [dispositions]);

  const claimedRecordIds = useMemo(
    () => new Set(claimedSources.map((s) => s.sourceRecordId)),
    [claimedSources],
  );

  const overrideByRecord = useMemo(() => {
    const m = new Map<string, FieldOverride>();
    // Overrides are an append-only chain; the latest one for a (row, field) is
    // the authoritative normalization.
    for (const o of [...overrides].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      m.set(`${o.targetEntity}::${o.fieldName}`, o);
    }
    return m;
  }, [overrides]);

  /**
   * Designatable evidence: a source record of a row a human already mapped to a
   * canonical material, that no other need line has claimed.
   */
  const candidates = useMemo(
    () => records
      .filter((r) => mappedItemByEntity.has(r.targetEntity) && !claimedRecordIds.has(r.id))
      .sort((a, b) => a.recordOrdinal - b.recordOrdinal),
    [records, mappedItemByEntity, claimedRecordIds],
  );

  const selectedIds = useMemo(() => Object.keys(designated), [designated]);

  /** One need line per distinct canonical material among the designations. */
  const groups = useMemo(() => {
    const byItem = new Map<string, { recordIds: string[]; total: string }>();
    for (const id of selectedIds) {
      const record = records.find((r) => r.id === id);
      const item = record ? mappedItemByEntity.get(record.targetEntity) : undefined;
      if (!record || !item) continue;
      const g = byItem.get(item) ?? { recordIds: [], total: '0' };
      g.recordIds.push(id);
      byItem.set(item, g);
    }
    for (const [item, g] of byItem) {
      byItem.set(item, { ...g, total: sumExactDecimals(g.recordIds.map((id) => designated[id]?.quantity ?? '')) });
    }
    return byItem;
  }, [selectedIds, designated, records, mappedItemByEntity]);

  const everyQuantityValid = selectedIds.length > 0
    && selectedIds.every((id) => DECIMAL.test((designated[id]?.quantity ?? '').trim()));
  const canSave = editable && Boolean(beneficiary) && selectedIds.length > 0
    && everyQuantityValid && reason.trim().length > 0 && groups.size > 0;

  /** Mapping completeness, mirroring M212's own review blocker. */
  const mappedRows = useMemo(
    () => dispositions.filter((d) => d.decision === 'mapped'),
    [dispositions],
  );
  const claimedEntities = useMemo(() => {
    const byId = new Map(records.map((r) => [r.id, r.targetEntity]));
    return new Set(claimedSources.map((s) => byId.get(s.sourceRecordId)).filter(Boolean) as string[]);
  }, [records, claimedSources]);
  const complete = mappedRows.length > 0
    && mappedRows.every((d) => claimedEntities.has(d.targetEntity));

  function toggle(record: SourceRecord, on: boolean) {
    setDesignated((prev) => {
      const next = { ...prev };
      if (!on) { delete next[record.id]; return next; }
      // The prefill is a SUGGESTION drawn from the record's own imported value —
      // never an approval. The reviewer edits or replaces it.
      next[record.id] = { quantity: rawDecimal(record) ?? '', overrideId: null };
      return next;
    });
    setPreviewing(false);
  }

  function setQuantity(recordId: string, quantity: string) {
    setDesignated((prev) => ({ ...prev, [recordId]: { ...(prev[recordId] ?? { overrideId: null }), quantity } }));
    setPreviewing(false);
  }

  function useOverride(record: SourceRecord, o: FieldOverride, on: boolean) {
    setDesignated((prev) => {
      const current = prev[record.id];
      if (!current) return prev;
      return {
        ...prev,
        [record.id]: on
          ? { quantity: overrideDecimal(o) ?? current.quantity, overrideId: o.id }
          : { quantity: current.quantity, overrideId: null },
      };
    });
    setPreviewing(false);
  }

  async function commit() {
    setBusy(true); setError(null); setNotice(null);
    try {
      // One RPC call per canonical material, each independently audited.
      for (const [centralItemId, group] of groups) {
        const quantitySources: NeedLineQuantitySource[] = group.recordIds.map((id) => ({
          sourceRecordId: id,
          designatedQuantity: (designated[id]?.quantity ?? '').trim(),
          appliedOverrideId: designated[id]?.overrideId ?? null,
        }));
        await setNeedLine({
          planRevisionId,
          beneficiaryOrganizationId: beneficiary,
          centralItemId,
          approvedQuantity: group.total,
          mappingReason: reason.trim(),
          quantitySources,
          approvedUnit: conversionRequired ? null : unit,
          unitConversionState: conversionRequired ? 'conversion_required' : 'canonical',
          targetWarehouseId: targetWarehouseId || null,
          sourceUnitText: sourceUnitText.trim() || null,
        });
      }
      setNotice(t('cn2b_nl_saved', lang));
      setDesignated({});
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
        {/* Scoped to the session the screen has selected, like every other
            per-session surface here. The revision-wide answer is the readiness
            panel's, which reads the server's own blockers. */}
        <p data-testid="cn2b-nl-completeness">
          {complete ? t('cn2b_nl_complete', lang) : t('cn2b_nl_incomplete', lang)}
          {' '}({claimedEntities.size}/{mappedRows.length}){' '}
          {t('cn2b_nl_session_scope', lang)}
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

          {/* The designated provenance. Without at least one row here there is
              nothing to save — and nothing the server would accept. */}
          <fieldset data-testid="cn2b-nl-candidates">
            <legend>{t('cn2b_nl_candidates', lang)} ({selectedIds.length}/{candidates.length})</legend>
            <p>{t('cn2b_nl_candidates_hint', lang)}</p>
            {candidates.length === 0 && <p data-testid="cn2b-nl-no-candidates">{t('cn2b_nl_no_candidates', lang)}</p>}
            {candidates.map((r) => {
              const picked = designated[r.id];
              const o = overrideByRecord.get(`${r.targetEntity}::${r.fieldName}`);
              const raw = rawDecimal(r);
              return (
                <div key={r.id} className="cn2b-nl-candidate">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(picked)}
                      onChange={(e) => toggle(r, e.target.checked)}
                    />
                    {r.targetEntity} · {r.fieldName}
                    {raw !== null && <> · {t('cn2b_nl_suggested', lang)} {raw}</>}
                  </label>
                  {picked && (
                    <>
                      <PhoenixInput
                        label={`${t('cn2b_nl_contribution', lang)} — ${r.fieldName}`}
                        value={picked.quantity}
                        inputMode="decimal"
                        onChange={(e) => setQuantity(r.id, e.target.value)}
                        error={DECIMAL.test(picked.quantity.trim()) ? undefined : t('cn2b_nl_contribution_invalid', lang)}
                      />
                      {o && (
                        <label>
                          <input
                            type="checkbox"
                            checked={picked.overrideId === o.id}
                            onChange={(e) => useOverride(r, o, e.target.checked)}
                          />
                          {t('cn2b_nl_use_override', lang)}
                        </label>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>

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

          {/* The approved total is never typed: it IS the designated sum. */}
          <p data-testid="cn2b-nl-total">
            {t('cn2b_nl_total', lang)}:{' '}
            {[...groups.entries()].map(([item, g]) => `${item}=${g.total}`).join(' · ') || '—'}
          </p>

          {!previewing && (
            <PhoenixButton
              type="button"
              disabled={!canSave || busy}
              onClick={() => setPreviewing(true)}
            >
              {groups.size > 1 ? t('cn2b_nl_bulk_preview', lang) : t('cn2b_nl_save', lang)}
            </PhoenixButton>
          )}

          {previewing && (
            <div data-testid="cn2b-nl-preview">
              <p>{t('cn2b_nl_bulk_title', lang)}</p>
              <p>
                {t('cn2b_nl_bulk_affected', lang)}:{' '}
                <strong data-testid="cn2b-nl-affected">{selectedIds.length}</strong>
                {' · '}
                {t('cn2b_nl_lines_to_create', lang)}:{' '}
                <strong data-testid="cn2b-nl-lines">{groups.size}</strong>
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
        {needLines.map((n) => {
          const sources = claimedSources.filter((s) => s.needLineId === n.id);
          return (
            <li key={n.id}>
              {n.approvedQuantity}{' '}
              {n.unitConversionState === 'conversion_required'
                ? t('cn2b_nl_unit_conversion_required', lang)
                : n.approvedUnit}
              {' — '}
              {n.targetWarehouseId ? n.targetWarehouseId : t('cn2b_nl_warehouse_none', lang)}
              {' — '}
              {t('cn2b_nl_from_sources', lang)}: {sources.length}
            </li>
          );
        })}
      </ul>
    </PhoenixCard>
  );
}
