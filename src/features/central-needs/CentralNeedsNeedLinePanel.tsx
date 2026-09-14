/**
 * CN-2B CONFORMANCE (M212, corrected by 213) — the operational need-line
 * mapping surface.
 *
 * This is where an imported cell stops being evidence and becomes part of an
 * operational requirement: beneficiary institution, canonical material,
 * canonical unit and approved annual quantity, persisted relationally by
 * `phoenix_central_needs_set_need_line`.
 *
 * SEVEN RULES THIS COMPONENT EXISTS TO HONOUR
 *
 *  1. MAPPING IS HUMAN-AUTHORITATIVE. Nothing is inferred from workbook family,
 *     sheet name, header text, sheet index, filename or row position. The
 *     beneficiary is chosen by a person, every time — including for each
 *     institution column of a multi-institution row.
 *  2. (213) A CELL'S BENEFICIARY COMES FROM ITS CONFIRMED COLUMN MAPPING, NEVER
 *     FROM ONE GLOBAL CHOICE. There is no single "beneficiary" selector that
 *     applies to every designated cell. Each candidate's beneficiary is
 *     resolved from `phoenix_central_needs_set_beneficiary_columns`
 *     (`CentralNeedsBeneficiaryColumnPanel`, rendered above this one), keyed on
 *     (importSessionId, sheetIndex, columnIndex) — never on header text, which
 *     the corpus is proven to duplicate. A cell whose column has no confirmed
 *     mapping cannot be designated here; it must be mapped first.
 *  3. THE APPROVED QUANTITY IS ITS OWN PROVENANCE. A need line is built by
 *     designating the exact imported cells it comes from and what each
 *     contributes; the approved total is their sum, computed here in EXACT
 *     decimal arithmetic (never a JavaScript float) and re-derived server-side.
 *     There is no way to save a line with no source: the action is disabled, and
 *     the RPC refuses it regardless.
 *  4. PROVENANCE IS REVISION-WIDE. A line may already hold cells from other
 *     import sessions. The panel shows that lineage, and saving into a scope
 *     that already has a line ADDS to it — sending the lineage it saw, so a
 *     stale view is refused by the server instead of erasing anything.
 *  5. REMOVAL IS AN EXPLICIT CORRECTION. The only way to take provenance off a
 *     line is to delete the line, after a confirmation, with a reason. Saving
 *     never removes a link.
 *  6. (213) A BULK ACTION MAY SPAN SEVERAL BENEFICIARIES. Designating records
 *     across several (beneficiary, canonical material, target warehouse)
 *     scopes creates or extends one need line PER SCOPE — previewed grouped by
 *     beneficiary with the exact counts, and written only after a second,
 *     separate confirmation. A single confirmed action can turn one
 *     multi-institution row into independent requirements for each institution
 *     it names.
 *  7. THE SERVER DECIDES. Every check here is for a fast answer, never the
 *     authority. A disabled button is a courtesy, not a control.
 *
 * The canonical material is never chosen here. It is READ from each row's
 * existing `central_needs_record_mappings` decision, so this surface cannot
 * become a competing source of material truth (v7.3 section 14) — and a source
 * reviewed as material A can never feed a line for material B.
 *
 * WAREHOUSE SCOPING (213): a target warehouse is optional, manual, explicit
 * context — never inferred from workbook text — and it is offered only when
 * every currently designated cell resolves to the SAME beneficiary (a
 * warehouse belongs to one organization, so it cannot meaningfully scope a
 * bulk action spanning several). Selecting cells across more than one
 * beneficiary keeps every resulting line institution-level (NULL warehouse);
 * an operator who needs a warehouse-scoped split narrows the selection to one
 * beneficiary at a time.
 */
import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import { getWarehouses, type Warehouse } from '@/shared/supabase/services/warehouses.service';
import {
  NEED_LINE_UNITS, deleteNeedLine, setNeedLine,
  type BeneficiaryColumnSummary, type FieldOverride, type NeedLine, type NeedLineQuantitySource,
  type NeedLineSourceLink, type NeedLineUnit, type RecordDisposition, type SourceRecord,
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
  /** Every need line of the REVISION, not just of the active session. */
  needLines: NeedLine[];
  /** Every source link of the REVISION, each with its own cell identity. */
  claimedSources: NeedLineSourceLink[];
  /**
   * (213) Every confirmed/candidate physical column of the REVISION — the
   * single source this panel resolves a candidate's beneficiary from. Never
   * this panel's own state, never header text.
   */
  beneficiaryColumns: BeneficiaryColumnSummary[];
  /** Reload the revision after anything changed, or after a stale refusal. */
  onChanged: () => void;
}

/** A plain non-negative decimal. No exponent, no sign, no thousands separator. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** The server refusals after which the panel's view is known to be out of date. */
const RELOAD_ON = new Set(['need_line_lineage_stale', 'need_line_scope_conflict', 'need_line_not_found']);

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

/** The server's stable refusal code, whichever shape the error arrived in. */
function refusalCode(e: unknown): string {
  if (e instanceof Error && 'code' in e) return String((e as { code?: unknown }).code ?? e.message);
  return e instanceof Error ? e.message : String(e);
}

/** A need line's accounting scope, exactly as M212's scope key defines it. */
const scopeKey = (beneficiaryId: string, itemId: string, warehouseId: string | null) =>
  `${beneficiaryId}|${itemId}|${warehouseId ?? ''}`;

interface Designation {
  /** The reviewer's contribution for this record — a suggestion until edited. */
  quantity: string;
  /** Set when the reviewer based it on a recorded override. */
  overrideId: string | null;
}

interface Group {
  beneficiaryId: string;
  itemId: string;
  warehouseId: string | null;
  recordIds: string[];
  /** Exact sum of the contributions designated now. */
  added: string;
  /** The line's total after saving: the existing line's quantity plus `added`. */
  total: string;
  /** The line this scope already has, when there is one. */
  existing: NeedLine | undefined;
  /** What that line holds right now — the lineage this save asserts it saw. */
  expectedIds: string[];
}

/** (213) A record's own physical-column identity, read from its persisted provenance. */
function columnIdentity(record: SourceRecord): { sheetIndex: number; columnIndex: number } | null {
  const p = record.sourceProvenance as { sheetIndex?: unknown; coordinate?: { col?: unknown } } | null;
  const sheetIndex = p?.sheetIndex;
  const columnIndex = p?.coordinate?.col;
  if (typeof sheetIndex !== 'number' || typeof columnIndex !== 'number') return null;
  return { sheetIndex, columnIndex };
}

export function CentralNeedsNeedLinePanel({
  lang, planRevisionId, editable, dispositions, records, overrides, needLines, claimedSources,
  beneficiaryColumns, onChanged,
}: Props) {
  const [institutions, setInstitutions] = useState<OrgRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

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

  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

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

  /**
   * (213) A cell's beneficiary is resolved from its column's explicit
   * BENEFICIARY decision — never typed or chosen in this panel. A cell with no
   * entry cannot be designated: its column is either UNRESOLVED (decide it in
   * `CentralNeedsBeneficiaryColumnPanel` first) or was explicitly reviewed as
   * NOT a beneficiary column (independent review finding 1), in which case it
   * is labelled so and is never a need-line source.
   */
  const { beneficiaryByRecordId, nonBeneficiaryRecordIds } = useMemo(() => {
    const byColumn = new Map<string, string>();
    const nonBeneficiaryColumns = new Set<string>();
    for (const c of beneficiaryColumns) {
      const key = `${c.importSessionId}:${c.sheetIndex}:${c.columnIndex}`;
      if (c.decision === 'beneficiary' && c.beneficiaryOrganizationId) byColumn.set(key, c.beneficiaryOrganizationId);
      else if (c.decision === 'non_beneficiary') nonBeneficiaryColumns.add(key);
    }
    const byRecord = new Map<string, string>();
    const nonBeneficiary = new Set<string>();
    for (const r of records) {
      const col = columnIdentity(r);
      if (!col) continue;
      const key = `${r.importSessionId}:${col.sheetIndex}:${col.columnIndex}`;
      const beneficiaryId = byColumn.get(key);
      if (beneficiaryId) byRecord.set(r.id, beneficiaryId);
      else if (nonBeneficiaryColumns.has(key)) nonBeneficiary.add(r.id);
    }
    return { beneficiaryByRecordId: byRecord, nonBeneficiaryRecordIds: nonBeneficiary };
  }, [records, beneficiaryColumns]);

  /** Distinct beneficiaries among the currently designated cells. */
  const selectedBeneficiaryIds = useMemo(
    () => new Set(Object.keys(designated).map((id) => beneficiaryByRecordId.get(id)).filter((x): x is string => Boolean(x))),
    [designated, beneficiaryByRecordId],
  );
  /** A target warehouse only makes sense when every selected cell shares one beneficiary. */
  const singleSelectedBeneficiary = selectedBeneficiaryIds.size === 1 ? [...selectedBeneficiaryIds][0] : null;

  // A target warehouse must belong to the chosen beneficiary AND be active, so
  // the list is scoped to it and cleared whenever the selection spans more
  // than one beneficiary, or a different single one.
  useEffect(() => {
    setTargetWarehouseId('');
    if (!singleSelectedBeneficiary) { setWarehouses([]); return; }
    let alive = true;
    getWarehouses(singleSelectedBeneficiary)
      .then((rows) => { if (alive) setWarehouses(rows.filter((w) => w.status === 'active')); })
      .catch(() => { if (alive) setWarehouses([]); });
    return () => { alive = false; };
  }, [singleSelectedBeneficiary]);

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

  const sourcesByLine = useMemo(() => {
    const m = new Map<string, NeedLineSourceLink[]>();
    for (const s of claimedSources) m.set(s.needLineId, [...(m.get(s.needLineId) ?? []), s]);
    return m;
  }, [claimedSources]);

  const lineByScope = useMemo(
    () => new Map(needLines.map((n) => [scopeKey(n.beneficiaryOrganizationId, n.centralItemId, n.targetWarehouseId), n])),
    [needLines],
  );

  const activeSessionIds = useMemo(() => new Set(records.map((r) => r.importSessionId)), [records]);

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
   * canonical material, that no need line anywhere in the revision has claimed.
   * One cell feeds at most one line; one row may feed several.
   */
  const candidates = useMemo(
    () => records
      .filter((r) => mappedItemByEntity.has(r.targetEntity) && !claimedRecordIds.has(r.id))
      .sort((a, b) => a.recordOrdinal - b.recordOrdinal),
    [records, mappedItemByEntity, claimedRecordIds],
  );

  const selectedIds = useMemo(() => Object.keys(designated), [designated]);

  /**
   * (213) One need line per distinct (beneficiary, canonical material, target
   * warehouse) SCOPE among the designations — never per material alone. A
   * single confirmed action may therefore create or extend lines for several
   * DIFFERENT beneficiaries at once, one per group, exactly matching how a
   * multi-institution row's cells are each resolved to their own beneficiary.
   * The target warehouse applies only within the single-beneficiary case
   * (see the warehouse-scoping note in this file's header); a multi-
   * beneficiary selection always groups with a NULL warehouse.
   */
  const groups = useMemo(() => {
    const byScope = new Map<string, Group>();
    for (const id of selectedIds) {
      const record = records.find((r) => r.id === id);
      const item = record ? mappedItemByEntity.get(record.targetEntity) : undefined;
      const beneficiaryId = beneficiaryByRecordId.get(id);
      if (!record || !item || !beneficiaryId) continue; // unresolved cells never form a group
      const warehouseId = singleSelectedBeneficiary ? (targetWarehouseId || null) : null;
      const key = scopeKey(beneficiaryId, item, warehouseId);
      const g = byScope.get(key)
        ?? { beneficiaryId, itemId: item, warehouseId, recordIds: [], added: '0', total: '0', existing: undefined, expectedIds: [] };
      g.recordIds.push(id);
      byScope.set(key, g);
    }
    for (const [key, g] of byScope) {
      const added = sumExactDecimals(g.recordIds.map((id) => designated[id]?.quantity ?? ''));
      const existing = lineByScope.get(scopeKey(g.beneficiaryId, g.itemId, g.warehouseId));
      const expectedIds = existing ? (sourcesByLine.get(existing.id) ?? []).map((s) => s.sourceRecordId) : [];
      const total = existing && added !== '' ? sumExactDecimals([existing.approvedQuantity, added]) : added;
      byScope.set(key, { ...g, added, total, existing, expectedIds });
    }
    return byScope;
  }, [selectedIds, designated, records, mappedItemByEntity, beneficiaryByRecordId, singleSelectedBeneficiary,
      targetWarehouseId, lineByScope, sourcesByLine]);

  const anyExisting = [...groups.values()].some((g) => g.existing);

  const everyQuantityValid = selectedIds.length > 0
    && selectedIds.every((id) => DECIMAL.test((designated[id]?.quantity ?? '').trim()));
  const everySelectionResolved = selectedIds.length > 0 && selectedIds.every((id) => beneficiaryByRecordId.has(id));
  const canSave = editable && selectedIds.length > 0 && everySelectionResolved
    && everyQuantityValid && reason.trim().length > 0 && groups.size > 0
    && [...groups.values()].every((g) => g.total !== '');

  /** Mapping completeness of the active session, mirroring M212's own review blocker. */
  const mappedRows = useMemo(
    () => dispositions.filter((d) => d.decision === 'mapped'),
    [dispositions],
  );
  const claimedEntities = useMemo(
    () => new Set(claimedSources.filter((s) => activeSessionIds.has(s.importSessionId)).map((s) => s.targetEntity)),
    [claimedSources, activeSessionIds],
  );
  const complete = mappedRows.length > 0
    && mappedRows.every((d) => claimedEntities.has(d.targetEntity));

  const institutionName = (id: string) => {
    const o = institutions.find((x) => x.id === id);
    return o ? (lang === 'ar' ? o.name_ar : o.name) : id;
  };

  function toggle(record: SourceRecord, on: boolean) {
    // (213) A cell whose physical column has no confirmed beneficiary cannot
    // be designated — never guessed, never defaulted. The checkbox itself is
    // disabled for this case (see the candidates list below); this is a
    // second, defensive gate against toggling one programmatically.
    if (on && !beneficiaryByRecordId.has(record.id)) return;
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
    let written = 0;
    try {
      // (213) One RPC call per (beneficiary, canonical material, warehouse)
      // SCOPE, each independently audited — a single confirmation may still
      // write lines for several different beneficiaries in one action.
      for (const group of groups.values()) {
        const quantitySources: NeedLineQuantitySource[] = group.recordIds.map((id) => ({
          sourceRecordId: id,
          designatedQuantity: (designated[id]?.quantity ?? '').trim(),
          appliedOverrideId: designated[id]?.overrideId ?? null,
        }));
        const existing = group.existing;
        await setNeedLine({
          planRevisionId,
          beneficiaryOrganizationId: group.beneficiaryId,
          centralItemId: group.itemId,
          approvedQuantity: group.total,
          mappingReason: reason.trim(),
          quantitySources,
          expectedSourceRecordIds: group.expectedIds,
          // An existing line keeps its unit: its designations are quantities in it.
          approvedUnit: existing ? existing.approvedUnit : (conversionRequired ? null : unit),
          unitConversionState: existing
            ? existing.unitConversionState
            : (conversionRequired ? 'conversion_required' : 'canonical'),
          targetWarehouseId: group.warehouseId,
          sourceUnitText: existing ? existing.sourceUnitText : (sourceUnitText.trim() || null),
        });
        written += 1;
      }
      setNotice(t('cn2b_nl_saved', lang));
      setDesignated({});
      setPreviewing(false);
      setReason('');
      onChanged();
    } catch (e) {
      // A server refusal is shown by its stable code, translated where known —
      // never flattened into a generic failure, never a raw database message.
      const code = refusalCode(e);
      setError(centralNeedsErrorText(code, lang));
      setPreviewing(false);
      if (written > 0 || RELOAD_ON.has(code)) onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(line: NeedLine) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await deleteNeedLine({
        needLineId: line.id,
        reason: deleteReason.trim(),
        expectedSourceRecordIds: (sourcesByLine.get(line.id) ?? []).map((s) => s.sourceRecordId),
      });
      setNotice(t('cn2b_nl_deleted', lang));
      setDeletingLineId(null);
      setDeleteReason('');
      onChanged();
    } catch (e) {
      const code = refusalCode(e);
      setError(centralNeedsErrorText(code, lang));
      if (RELOAD_ON.has(code)) { setDeletingLineId(null); onChanged(); }
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
          {/* (213) No global beneficiary choice: each candidate's beneficiary
              is resolved from its own confirmed column mapping and shown
              beside it. A cell with none is listed but cannot be selected —
              map its column in the panel above first. */}
          <p data-testid="cn2b-nl-beneficiary-note">{t('cn2b_nl_beneficiary_hint', lang)}</p>

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
              const beneficiaryId = beneficiaryByRecordId.get(r.id);
              const beneficiaryLabel = beneficiaryId ? institutionName(beneficiaryId) : null;
              return (
                <div key={r.id} className="cn2b-nl-candidate" data-testid="cn2b-nl-candidate"
                  data-beneficiary-resolved={beneficiaryId ? 'true' : 'false'}
                  data-column-decision={beneficiaryId ? 'beneficiary' : nonBeneficiaryRecordIds.has(r.id) ? 'non_beneficiary' : 'unresolved'}>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(picked)}
                      disabled={!beneficiaryId}
                      onChange={(e) => toggle(r, e.target.checked)}
                    />
                    {r.targetEntity} · {r.fieldName}
                    {raw !== null && <> · {t('cn2b_nl_suggested', lang)} {raw}</>}
                    {' · '}
                    {beneficiaryLabel
                      ? <strong data-testid="cn2b-nl-candidate-beneficiary">{beneficiaryLabel}</strong>
                      : nonBeneficiaryRecordIds.has(r.id)
                        ? <span data-testid="cn2b-nl-candidate-non-beneficiary">{t('cn2b_beneficiary_column_state_non_beneficiary', lang)}</span>
                        : <span data-testid="cn2b-nl-candidate-unmapped">{t('cn2b_beneficiary_column_state_unresolved', lang)}</span>}
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
              disabled={!singleSelectedBeneficiary}
              onChange={(e) => setTargetWarehouseId(e.target.value)}
            >
              <option value="">{t('cn2b_nl_warehouse_none', lang)}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{lang === 'ar' ? w.name_ar : w.name}</option>
              ))}
            </select>
          </label>
          {/* (213) A warehouse belongs to one organization, so it can only
              scope a selection that resolves to a single beneficiary. */}
          <p data-testid="cn2b-nl-warehouse-hint">
            {selectedBeneficiaryIds.size > 1
              ? t('cn2b_nl_warehouse_multi_beneficiary_disabled', lang)
              : t('cn2b_nl_warehouse_hint', lang)}
          </p>

          <PhoenixInput
            label={t('cn2b_nl_reason', lang)}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={reason.trim() === '' ? t('cn2b_nl_reason_required', lang) : undefined}
          />

          {/* The approved total is never typed: it IS the designated sum, plus
              whatever the line already holds when it exists — one figure per
              (beneficiary, material, warehouse) scope. */}
          <p data-testid="cn2b-nl-total">
            {t('cn2b_nl_total', lang)}:{' '}
            {[...groups.values()]
              .map((g) => `${institutionName(g.beneficiaryId)} / ${g.itemId}=${g.total}`)
              .join(' · ') || '—'}
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
                {selectedBeneficiaryIds.size > 1 && (
                  <>
                    {' · '}
                    <strong data-testid="cn2b-nl-beneficiary-count">{selectedBeneficiaryIds.size}</strong>
                    {' '}{t('cn2b_nl_multi_beneficiary_note', lang)}
                  </>
                )}
              </p>
              {/* (213) Grouped by beneficiary FIRST, so a multi-institution
                  bulk save is reviewed the way section 18 of the corrective
                  brief describes it: Hospital A's lines, then Hospital B's. */}
              <ul>
                {[...groups.values()]
                  .sort((a, b) => institutionName(a.beneficiaryId).localeCompare(institutionName(b.beneficiaryId)))
                  .map((g) => (
                  <li key={`${g.beneficiaryId}|${g.itemId}|${g.warehouseId ?? ''}`}
                    data-testid="cn2b-nl-preview-group" data-existing={g.existing ? 'true' : 'false'}
                    data-beneficiary={g.beneficiaryId}>
                    <strong>{institutionName(g.beneficiaryId)}</strong>
                    {' — '}{g.itemId}:{' '}
                    {g.existing
                      ? <>{t('cn2b_nl_adds_to_existing', lang)} ({g.expectedIds.length} · {t('cn2b_nl_current_total', lang)} {g.existing.approvedQuantity}) → {t('cn2b_nl_new_total', lang)} {g.total}</>
                      : <>{t('cn2b_nl_creates_new', lang)} → {g.total}</>}
                  </li>
                ))}
              </ul>
              {anyExisting && <p data-testid="cn2b-nl-unit-locked">{t('cn2b_nl_existing_unit_locked', lang)}</p>}
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
          const sources = sourcesByLine.get(n.id) ?? [];
          return (
            <li key={n.id} data-testid="cn2b-nl-line">
              <div>
                {institutionName(n.beneficiaryOrganizationId)}
                {' — '}
                {n.approvedQuantity}{' '}
                {n.unitConversionState === 'conversion_required'
                  ? t('cn2b_nl_unit_conversion_required', lang)
                  : n.approvedUnit}
                {' — '}
                {n.targetWarehouseId ? n.targetWarehouseId : t('cn2b_nl_warehouse_none', lang)}
                {' — '}
                {t('cn2b_nl_from_sources', lang)}: {sources.length}
              </div>
              {/* The line's whole lineage, revision-wide: an operator adding to or
                  deleting this line sees what it already contains. */}
              <ul aria-label={t('cn2b_nl_lineage', lang)} data-testid="cn2b-nl-lineage">
                {sources.map((s) => (
                  <li key={s.sourceRecordId}>
                    {s.targetEntity} · {s.fieldName} = {s.designatedQuantity}
                    {!activeSessionIds.has(s.importSessionId) && <> ({t('cn2b_nl_other_session', lang)})</>}
                  </li>
                ))}
              </ul>
              {editable && deletingLineId !== n.id && (
                <PhoenixButton
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => { setDeletingLineId(n.id); setDeleteReason(''); setError(null); }}
                >
                  {t('cn2b_nl_delete', lang)}
                </PhoenixButton>
              )}
              {editable && deletingLineId === n.id && (
                <div data-testid="cn2b-nl-delete-confirm">
                  <p>{t('cn2b_nl_delete_title', lang)}</p>
                  <p>{t('cn2b_nl_delete_explainer', lang)}</p>
                  <PhoenixInput
                    label={t('cn2b_nl_delete_reason', lang)}
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    error={deleteReason.trim() === '' ? t('cn2b_nl_delete_reason_required', lang) : undefined}
                  />
                  <PhoenixButton
                    type="button"
                    disabled={busy || deleteReason.trim() === ''}
                    loading={busy}
                    onClick={() => confirmDelete(n)}
                  >
                    {t('cn2b_nl_delete_confirm', lang)}
                  </PhoenixButton>
                  <PhoenixButton
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { setDeletingLineId(null); setDeleteReason(''); }}
                  >
                    {t('cn2b_nl_bulk_cancel', lang)}
                  </PhoenixButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </PhoenixCard>
  );
}
