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
 *
 * UX-2C — THE NEED LINES WORKSPACE, and what it deliberately did NOT change.
 *
 * A real revision carries dozens to hundreds of candidate cells, and the
 * earlier panel was one flat technical list. UX-2C lays the same flow out the
 * way an operator walks it — source evidence → selection → designated
 * contribution → beneficiary + material scope → resulting need line →
 * confirmation → saved line with provenance — and all of that is PRESENTATION:
 *
 *   * every count is derived from props already loaded (`records`,
 *     `dispositions`, `beneficiaryColumns`, `needLines`, `claimedSources`);
 *     no request is issued for a summary, a label or a filter;
 *   * filtering narrows what is DISPLAYED. It never touches `designated`, so a
 *     selected cell a filter hides keeps its contribution and override choice;
 *   * `groups` stays the one canonical grouping. The selection summary, the
 *     preview and the write plan are all read off it — there is no second
 *     grouping algorithm;
 *   * the business rules above, the payload the RPCs receive, the exact-decimal
 *     sum and the stale-refusal reload are unchanged.
 *
 * CONFIRMATION INTEGRITY (UX-2C). Every stage is mounted on one page, so the
 * revision can reload while a preview is open (a column confirmed above, a row
 * re-dispositioned, a line saved elsewhere). The earlier preview kept a live
 * "Rows affected" count while the write silently skipped cells that had become
 * unresolved or unmapped, and could even report "saved" having written nothing.
 * Now the preview captures the exact write plan it displays; confirming
 * executes that captured plan, and only while it is still identical to what
 * the loaded revision would write. Any divergence blocks the confirmation until
 * the operator refreshes the preview and looks again. Editing an input that
 * shapes the write closes the preview, as selecting a cell always did.
 */
import { useEffect, useId, useMemo, useState } from 'react';
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
  type UnitConversionState,
} from './central-needs.service';
import { centralNeedsErrorText } from './central-needs.i18n';

interface Props {
  lang: 'ar' | 'en';
  planRevisionId: string;
  /** Shared Stage 3/5 Work Session; used only to reset session-local draft UI after a confirmed switch. */
  workSessionId?: string | null;
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
  /** UX-3R Package B: exposes only local busy/dirty presentation state to the parent session guard. */
  onActivityChange?: (activity: { busy: boolean; dirty: boolean; failed: boolean }) => void;
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

type SetNeedLineInput = Parameters<typeof setNeedLine>[0];

/** UX-2C — one scope's write, exactly as `setNeedLine` will receive it. */
interface PlannedWrite {
  key: string;
  group: Group;
  input: SetNeedLineInput;
}

/**
 * UX-2C — the presentation filter over candidate cells. Choosing one narrows
 * the view and decides nothing: `designated` is never read for writing here.
 */
type EvidenceFilter = 'all' | 'available' | 'selected' | 'resolved' | 'unresolved' | 'non_beneficiary';

const EVIDENCE_FILTERS: ReadonlyArray<{ value: EvidenceFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'cn2b_nl_filter_all' },
  { value: 'available', labelKey: 'cn2b_nl_filter_available' },
  { value: 'selected', labelKey: 'cn2b_nl_filter_selected' },
  { value: 'resolved', labelKey: 'cn2b_nl_filter_resolved' },
  { value: 'unresolved', labelKey: 'cn2b_nl_filter_unresolved' },
  { value: 'non_beneficiary', labelKey: 'cn2b_nl_filter_non_beneficiary' },
];

/** (213) A record's own physical-column identity, read from its persisted provenance. */
function columnIdentity(record: SourceRecord): { sheetIndex: number; columnIndex: number } | null {
  const p = record.sourceProvenance as { sheetIndex?: unknown; coordinate?: { col?: unknown } } | null;
  const sheetIndex = p?.sheetIndex;
  const columnIndex = p?.coordinate?.col;
  if (typeof sheetIndex !== 'number' || typeof columnIndex !== 'number') return null;
  return { sheetIndex, columnIndex };
}

/**
 * UX-2C — where a cell came from, as its persisted provenance records it.
 * Display and local search only; nothing is resolved from it.
 */
function locationEvidence(record: SourceRecord): { a1: string | null; columnIndex: number | null; filename: string | null } {
  const p = record.sourceProvenance as {
    coordinate?: { a1?: unknown; col?: unknown }; originalFilename?: unknown;
  } | null;
  return {
    a1: typeof p?.coordinate?.a1 === 'string' ? p.coordinate.a1 : null,
    columnIndex: typeof p?.coordinate?.col === 'number' ? p.coordinate.col : null,
    filename: typeof p?.originalFilename === 'string' ? p.originalFilename : null,
  };
}

/** UX-2C — the imported value as plain evidence text: never evaluated, never approved. */
function sourceValueText(record: SourceRecord): string | null {
  const v = (record.sourceValues as { value?: unknown }).value;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  return null;
}

export function CentralNeedsNeedLinePanel({
  lang, planRevisionId, workSessionId, editable, dispositions, records, overrides, needLines, claimedSources,
  beneficiaryColumns, onChanged, onActivityChange,
}: Props) {
  const domId = useId();
  const [institutions, setInstitutions] = useState<OrgRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [unit, setUnit] = useState<NeedLineUnit>('box');
  const [conversionRequired, setConversionRequired] = useState(false);
  const [sourceUnitText, setSourceUnitText] = useState('');
  const [targetWarehouseId, setTargetWarehouseId] = useState('');
  const [reason, setReason] = useState('');

  const [designated, setDesignated] = useState<Record<string, Designation>>({});
  /** UX-2C — the exact write plan a preview displays, captured when it opened. */
  const [preview, setPreview] = useState<{ plan: PlannedWrite[]; signature: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  /** UX-2C presentation filters. Held here, applied only to what is rendered. */
  const [textFilter, setTextFilter] = useState('');
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>('all');
  const filtersActive = textFilter.trim() !== '' || evidenceFilter !== 'all';


  const dirty = Object.keys(designated).length > 0
    || reason.trim() !== ''
    || preview !== null
    || deletingLineId !== null
    || deleteReason.trim() !== ''
    || conversionRequired
    || unit !== 'box'
    || sourceUnitText.trim() !== ''
    || targetWarehouseId !== '';

  useEffect(() => {
    onActivityChange?.({ busy, dirty, failed: error !== null });
  }, [busy, dirty, error, onActivityChange]);

  /** A confirmed revision/session switch discards only local, unpersisted editor state. */
  useEffect(() => {
    setUnit('box');
    setConversionRequired(false);
    setSourceUnitText('');
    setTargetWarehouseId('');
    setReason('');
    setDesignated({});
    setPreview(null);
    setError(null);
    setNotice(null);
    setDeletingLineId(null);
    setDeleteReason('');
    setTextFilter('');
    setEvidenceFilter('all');
  }, [planRevisionId, workSessionId]);

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
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const candidateIdSet = useMemo(() => new Set(candidates.map((r) => r.id)), [candidates]);

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

  /**
   * UX-2C — designations the loaded revision can no longer turn into a line: the
   * cell was claimed by a line saved meanwhile, its row is no longer mapped, or
   * its column is no longer a confirmed beneficiary column. They are surfaced
   * and block saving rather than being silently left out of the write.
   */
  const unavailableSelectedIds = useMemo(
    () => selectedIds.filter((id) => !candidateIdSet.has(id) || !beneficiaryByRecordId.has(id)),
    [selectedIds, candidateIdSet, beneficiaryByRecordId],
  );

  const everyQuantityValid = selectedIds.length > 0
    && selectedIds.every((id) => DECIMAL.test((designated[id]?.quantity ?? '').trim()));
  const everySelectionResolved = selectedIds.length > 0 && selectedIds.every((id) => beneficiaryByRecordId.has(id));
  const canSave = editable && selectedIds.length > 0 && everySelectionResolved
    && unavailableSelectedIds.length === 0
    && everyQuantityValid && reason.trim().length > 0 && groups.size > 0
    && [...groups.values()].every((g) => g.total !== '');

  /**
   * UX-2C — the exact RPC inputs a confirmation would send now, one per group
   * of the canonical `groups` model. The expressions are the ones the write has
   * always used; they are only computed ahead of the click so the preview can
   * show them and the confirmation can execute exactly what was shown.
   */
  const writePlan = useMemo<PlannedWrite[]>(() => [...groups.values()].map((group) => {
    const existing = group.existing;
    const quantitySources: NeedLineQuantitySource[] = group.recordIds.map((id) => ({
      sourceRecordId: id,
      designatedQuantity: (designated[id]?.quantity ?? '').trim(),
      appliedOverrideId: designated[id]?.overrideId ?? null,
    }));
    return {
      key: scopeKey(group.beneficiaryId, group.itemId, group.warehouseId),
      group,
      input: {
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
      },
    };
  }), [groups, designated, planRevisionId, reason, conversionRequired, unit, sourceUnitText]);

  /** Everything a confirmation would write, plus the line state it was computed against. */
  const planSignature = useMemo(
    () => JSON.stringify(writePlan.map((p) => [p.input, p.group.existing?.id ?? null, p.group.existing?.approvedQuantity ?? null])),
    [writePlan],
  );

  const previewStale = preview !== null && preview.signature !== planSignature;
  const canConfirm = preview !== null && !previewStale && canSave && !busy;

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

  /** A loaded warehouse's name, or its stable id when no label is loaded; NULL is institution-level. */
  const warehouseLabel = (id: string | null) => {
    if (!id) return t('cn2b_nl_warehouse_none', lang);
    const w = warehouses.find((x) => x.id === id);
    return w ? (lang === 'ar' ? w.name_ar : w.name) : id;
  };

  const unitLabel = (approvedUnit: NeedLineUnit | null | undefined, state: UnitConversionState | undefined) =>
    state === 'conversion_required' ? t('cn2b_nl_unit_conversion_required', lang) : (approvedUnit ?? '—');

  const byInstitutionName = (a: { beneficiaryId: string }, b: { beneficiaryId: string }) =>
    institutionName(a.beneficiaryId).localeCompare(institutionName(b.beneficiaryId));

  /**
   * UX-2C — counts over the candidate cells, for orientation only. Available,
   * selected, unresolved and non-beneficiary partition the candidates whenever
   * every selection is still designatable.
   */
  const summary = useMemo(() => {
    let available = 0;
    let resolved = 0;
    let unresolved = 0;
    let nonBeneficiary = 0;
    for (const r of candidates) {
      const isResolved = beneficiaryByRecordId.has(r.id);
      if (isResolved) resolved += 1;
      if (isResolved && !selectedIdSet.has(r.id)) available += 1;
      else if (!isResolved && nonBeneficiaryRecordIds.has(r.id)) nonBeneficiary += 1;
      else if (!isResolved) unresolved += 1;
    }
    return { available, resolved, unresolved, nonBeneficiary };
  }, [candidates, beneficiaryByRecordId, nonBeneficiaryRecordIds, selectedIdSet]);

  const mappedRecordCount = useMemo(
    () => records.filter((r) => mappedItemByEntity.has(r.targetEntity)).length,
    [records, mappedItemByEntity],
  );

  /** Client-only. Reads the already-loaded props and calls nothing. */
  const visibleCandidates = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    return candidates.filter((r) => {
      const beneficiaryId = beneficiaryByRecordId.get(r.id);
      const nonBeneficiary = nonBeneficiaryRecordIds.has(r.id);
      const selected = selectedIdSet.has(r.id);
      if (evidenceFilter === 'available' && !(beneficiaryId && !selected)) return false;
      if (evidenceFilter === 'selected' && !selected) return false;
      if (evidenceFilter === 'resolved' && !beneficiaryId) return false;
      if (evidenceFilter === 'unresolved' && (beneficiaryId || nonBeneficiary)) return false;
      if (evidenceFilter === 'non_beneficiary' && !nonBeneficiary) return false;
      if (needle === '') return true;
      const org = beneficiaryId ? institutions.find((o) => o.id === beneficiaryId) : undefined;
      const location = locationEvidence(r);
      const haystack = [
        r.targetEntity, r.fieldName, beneficiaryId ?? '', org?.name ?? '', org?.name_ar ?? '', org?.code ?? '',
        mappedItemByEntity.get(r.targetEntity) ?? '', sourceValueText(r) ?? '',
        location.a1 ?? '', location.columnIndex === null ? '' : `#${location.columnIndex}`, location.filename ?? '',
      ];
      return haystack.join('\n').toLowerCase().includes(needle);
    });
  }, [candidates, beneficiaryByRecordId, nonBeneficiaryRecordIds, selectedIdSet, institutions, mappedItemByEntity,
      textFilter, evidenceFilter]);

  const visibleIdSet = useMemo(() => new Set(visibleCandidates.map((r) => r.id)), [visibleCandidates]);
  const selectedHiddenCount = selectedIds.filter((id) => candidateIdSet.has(id) && !visibleIdSet.has(id)).length;

  function clearFilters() {
    setTextFilter('');
    setEvidenceFilter('all');
  }

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
    setPreview(null);
  }

  function setQuantity(recordId: string, quantity: string) {
    setDesignated((prev) => ({ ...prev, [recordId]: { ...(prev[recordId] ?? { overrideId: null }), quantity } }));
    setPreview(null);
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
    setPreview(null);
  }

  /** UX-2C — an explicit human act: drop designations the reloaded revision no longer allows. */
  function removeUnavailableSelections() {
    setDesignated((prev) => {
      const next = { ...prev };
      for (const id of unavailableSelectedIds) delete next[id];
      return next;
    });
    setPreview(null);
  }

  function openPreview() {
    if (!canSave) return;
    setPreview({ plan: writePlan, signature: planSignature });
  }

  async function commit() {
    // UX-2C: only the plan on screen may execute, and only while it is still
    // exactly what the loaded revision would write.
    if (!preview || previewStale || !canSave) return;
    const plan = preview.plan;
    setBusy(true); setError(null); setNotice(null);
    let written = 0;
    try {
      // (213) One RPC call per (beneficiary, canonical material, warehouse)
      // SCOPE, each independently audited — a single confirmation may still
      // write lines for several different beneficiaries in one action.
      for (const { input } of plan) {
        await setNeedLine(input);
        written += 1;
      }
      setNotice(t('cn2b_nl_saved', lang));
      setDesignated({});
      setPreview(null);
      setReason('');
      onChanged();
    } catch (e) {
      // A server refusal is shown by its stable code, translated where known —
      // never flattened into a generic failure, never a raw database message.
      const code = refusalCode(e);
      setError(centralNeedsErrorText(code, lang));
      setPreview(null);
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

  const saveBlockers = [
    selectedIds.length === 0 && 'cn2b_nl_block_no_selection',
    selectedIds.length > 0 && !everyQuantityValid && 'cn2b_nl_block_quantity',
    unavailableSelectedIds.length > 0 && 'cn2b_nl_block_unavailable',
    reason.trim() === '' && 'cn2b_nl_block_reason',
  ].filter((k): k is string => Boolean(k));

  const previewSourceCount = preview ? preview.plan.reduce((n, p) => n + p.group.recordIds.length, 0) : 0;
  const previewBeneficiaryCount = preview ? new Set(preview.plan.map((p) => p.group.beneficiaryId)).size : 0;

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

      {/* UX-2C — the path an operator walks, in order. Orientation only. */}
      <ol className="cn2b-nl-flow" aria-label={t('cn2b_nl_flow_label', lang)}>
        {['cn2b_nl_flow_evidence', 'cn2b_nl_flow_selection', 'cn2b_nl_flow_contribution', 'cn2b_nl_flow_scope',
          'cn2b_nl_flow_line', 'cn2b_nl_flow_confirm', 'cn2b_nl_flow_persisted'].map((k, i) => (
          <li key={k}>{i + 1}. {t(k, lang)}</li>
        ))}
      </ol>

      {/* UX-2C — counts of already-loaded state. No request backs any of them. */}
      <dl className="cn2b-nl-summary" data-testid="cn2b-nl-summary" aria-label={t('cn2b_nl_sum_label', lang)}>
        <div><dt>{t('cn2b_nl_sum_available', lang)}</dt><dd data-nl-sum="available">{summary.available}</dd></div>
        <div><dt>{t('cn2b_nl_sum_selected', lang)}</dt><dd data-nl-sum="selected">{selectedIds.length}</dd></div>
        <div><dt>{t('cn2b_nl_sum_unresolved', lang)}</dt><dd data-nl-sum="unresolved">{summary.unresolved}</dd></div>
        <div><dt>{t('cn2b_nl_sum_non_beneficiary', lang)}</dt><dd data-nl-sum="non_beneficiary">{summary.nonBeneficiary}</dd></div>
        <div><dt>{t('cn2b_nl_sum_lines', lang)}</dt><dd data-nl-sum="lines">{needLines.length}</dd></div>
        <div><dt>{t('cn2b_nl_sum_claimed', lang)}</dt><dd data-nl-sum="claimed">{claimedSources.length}</dd></div>
      </dl>

      {!editable && <p className="cn2b-nl-readonly" data-testid="cn2b-nl-readonly" data-empty="read-only">{t('cn2b_nl_readonly', lang)}</p>}

      {editable && (
        <div className="cn2b-nl-form">
          {/* (213) No global beneficiary choice: each candidate's beneficiary
              is resolved from its own confirmed column mapping and shown
              beside it. A cell with none is listed but cannot be selected —
              map its column in the panel above first. */}
          <p className="cn2b-nl-hint" data-testid="cn2b-nl-beneficiary-note">{t('cn2b_nl_beneficiary_hint', lang)}</p>

          {/* 1 — SOURCE EVIDENCE AND DESIGNATION. Without at least one
              designated cell there is nothing to save — and nothing the server
              would accept. */}
          <fieldset className="cn2b-nl-section" data-testid="cn2b-nl-candidates">
            <legend className="cn2b-nl-section__title">
              {t('cn2b_nl_evidence_title', lang)} ({selectedIds.length}/{candidates.length})
            </legend>
            <p className="cn2b-nl-hint">{t('cn2b_nl_candidates_hint', lang)}</p>

            {candidates.length === 0 ? (
              mappedRecordCount === 0
                ? <p className="cn2b-nl-empty" data-testid="cn2b-nl-no-candidates" data-empty="no-evidence">{t('cn2b_nl_empty_no_evidence', lang)}</p>
                : <p className="cn2b-nl-empty" data-testid="cn2b-nl-all-claimed" data-empty="all-claimed">{t('cn2b_nl_empty_all_claimed', lang)}</p>
            ) : (
              <>
                {summary.resolved === 0 && (
                  <p className="cn2b-nl-banner" data-testid="cn2b-nl-none-designatable"
                    data-empty={summary.unresolved > 0 ? 'all-unresolved' : 'all-non-beneficiary'}>
                    {summary.unresolved > 0
                      ? t('cn2b_nl_empty_all_unresolved', lang)
                      : t('cn2b_nl_empty_none_designatable', lang)}
                  </p>
                )}

                {/* Local filters: a searchbox and toggle buttons. They narrow
                    the view, reach nothing, and never touch a designation. */}
                <div className="cn2b-nl-toolbar">
                  <input
                    type="search"
                    className="cn2b-nl-input cn2b-nl-toolbar__grow"
                    aria-label={t('cn2b_nl_filter_search', lang)}
                    placeholder={t('cn2b_nl_filter_search_hint', lang)}
                    value={textFilter}
                    onChange={(e) => setTextFilter(e.target.value)}
                  />
                  <div className="cn2b-nl-segmented" role="group" aria-label={t('cn2b_nl_filter_state_label', lang)}>
                    {EVIDENCE_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        className="cn2b-nl-segbtn"
                        data-nl-filter={f.value}
                        data-active={evidenceFilter === f.value}
                        aria-pressed={evidenceFilter === f.value}
                        onClick={() => setEvidenceFilter(f.value)}
                      >
                        {t(f.labelKey, lang)}
                      </button>
                    ))}
                  </div>
                  <PhoenixButton type="button" size="sm" variant="ghost" disabled={!filtersActive} onClick={clearFilters}>
                    {t('cn2b_nl_filter_clear', lang)}
                  </PhoenixButton>
                </div>
                <p className="cn2b-nl-counts">
                  <span>{t('cn2b_nl_count_total', lang)}: <strong data-nl-count="total">{candidates.length}</strong></span>
                  <span>{t('cn2b_nl_count_visible', lang)}: <strong data-nl-count="visible">{visibleCandidates.length}</strong></span>
                  <span>{t('cn2b_nl_count_selected', lang)}: <strong data-nl-count="selected">{selectedIds.length}</strong></span>
                  {selectedHiddenCount > 0 && (
                    <span><strong data-nl-count="selected_hidden">{selectedHiddenCount}</strong> {t('cn2b_nl_count_selected_hidden', lang)}</span>
                  )}
                </p>

                {visibleCandidates.length === 0 ? (
                  <p className="cn2b-nl-empty" data-testid="cn2b-nl-empty-filtered" data-empty="filtered">{t('cn2b_nl_empty_filtered', lang)}</p>
                ) : (
                  <>
                    <div className="cn2b-nl-rowhead" aria-hidden="true">
                      <span>{t('cn2b_nl_col_evidence', lang)}</span>
                      <span>{t('cn2b_nl_col_authority', lang)}</span>
                      <span>{t('cn2b_nl_col_designation', lang)}</span>
                    </div>
                    <div className="cn2b-nl-rows">
                      {visibleCandidates.map((r) => {
                        const picked = designated[r.id];
                        const o = overrideByRecord.get(`${r.targetEntity}::${r.fieldName}`);
                        const raw = rawDecimal(r);
                        const valueText = sourceValueText(r);
                        const location = locationEvidence(r);
                        const beneficiaryId = beneficiaryByRecordId.get(r.id);
                        const beneficiaryLabel = beneficiaryId ? institutionName(beneficiaryId) : null;
                        const decision = beneficiaryId ? 'beneficiary' : nonBeneficiaryRecordIds.has(r.id) ? 'non_beneficiary' : 'unresolved';
                        const contributionId = `${domId}-contribution-${r.id}`;
                        const quantityOk = picked ? DECIMAL.test(picked.quantity.trim()) : true;
                        const overrideValue = o ? overrideDecimal(o) : null;
                        const unavailable = Boolean(picked) && !beneficiaryId;
                        return (
                          <div key={r.id} className="cn2b-nl-row" data-testid="cn2b-nl-candidate"
                            data-beneficiary-resolved={beneficiaryId ? 'true' : 'false'}
                            data-column-decision={decision}
                            data-selected={picked ? 'true' : 'false'}
                            data-unavailable={unavailable ? 'true' : undefined}>
                            {/* SOURCE EVIDENCE — what the workbook says. Never an approval. */}
                            <div className="cn2b-nl-row__band">
                              <label className="cn2b-nl-row__pick">
                                <input
                                  type="checkbox"
                                  checked={Boolean(picked)}
                                  // A selection that is no longer designatable can
                                  // still be cleared; nothing unresolved can be added.
                                  disabled={!beneficiaryId && !picked}
                                  onChange={(e) => toggle(r, e.target.checked)}
                                />
                                <span className="cn2b-nl-row__ident">{r.targetEntity} · {r.fieldName}</span>
                              </label>
                              <span className="cn2b-nl-row__loc">
                                {location.columnIndex !== null && <>{t('cn2b_nl_location_column', lang)} {location.columnIndex}</>}
                                {location.columnIndex !== null && location.a1 && ' · '}
                                {location.a1 && <>{t('cn2b_nl_location_cell', lang)} {location.a1}</>}
                              </span>
                              <span className="cn2b-nl-row__value" data-testid="cn2b-nl-source-value">
                                <span className="cn2b-nl-row__value-label">{t('cn2b_nl_source_value', lang)}:</span>{' '}
                                <strong>{valueText ?? '—'}</strong>
                                {raw === null && <> ({t('cn2b_nl_source_value_not_decimal', lang)})</>}
                              </span>
                            </div>

                            {/* REVIEWED AUTHORITY — decided in earlier stages, only read here. */}
                            <div className="cn2b-nl-row__band">
                              {beneficiaryLabel
                                ? <strong className="cn2b-nl-badge" data-state="beneficiary" data-testid="cn2b-nl-candidate-beneficiary">{beneficiaryLabel}</strong>
                                : decision === 'non_beneficiary'
                                  ? <span className="cn2b-nl-badge" data-state="non_beneficiary" data-testid="cn2b-nl-candidate-non-beneficiary">{t('cn2b_beneficiary_column_state_non_beneficiary', lang)}</span>
                                  : <span className="cn2b-nl-badge" data-state="unresolved" data-testid="cn2b-nl-candidate-unmapped">{t('cn2b_beneficiary_column_state_unresolved', lang)}</span>}
                              {!beneficiaryId && (
                                <p className="cn2b-nl-why" data-testid="cn2b-nl-candidate-why">
                                  {decision === 'non_beneficiary' ? t('cn2b_nl_why_non_beneficiary', lang) : t('cn2b_nl_why_unresolved', lang)}
                                </p>
                              )}
                              <span className="cn2b-nl-row__meta">
                                {t('cn2b_nl_material', lang)}:{' '}
                                <code className="cn2b-nl-code" data-testid="cn2b-nl-candidate-material">{mappedItemByEntity.get(r.targetEntity)}</code>
                              </span>
                            </div>

                            {/* DESIGNATION — the reviewer's contribution to the line. */}
                            <div className="cn2b-nl-row__band">
                              {!picked && beneficiaryId && <span className="cn2b-nl-row__meta">{t('cn2b_nl_not_designated', lang)}</span>}
                              {unavailable && <span className="cn2b-nl-row__meta">{t('cn2b_nl_unavailable_row', lang)}</span>}
                              {picked && (
                                <div className="cn2b-nl-contrib">
                                  <label className="cn2b-nl-contrib__label" htmlFor={contributionId}>
                                    {t('cn2b_nl_contribution', lang)}
                                    <span className="cn2b-visually-hidden">{` — ${r.fieldName}`}</span>
                                  </label>
                                  <input
                                    id={contributionId}
                                    type="text"
                                    className="cn2b-nl-input"
                                    inputMode="decimal"
                                    value={picked.quantity}
                                    aria-invalid={!quantityOk}
                                    aria-describedby={quantityOk ? undefined : `${contributionId}-error`}
                                    onChange={(e) => setQuantity(r.id, e.target.value)}
                                  />
                                  {!quantityOk && (
                                    <p className="cn2b-nl-contrib__error" id={`${contributionId}-error`}>{t('cn2b_nl_contribution_invalid', lang)}</p>
                                  )}
                                  {picked.overrideId === null && raw !== null && picked.quantity.trim() === raw && (
                                    <p className="cn2b-nl-contrib__note">{t('cn2b_nl_suggestion_note', lang)}</p>
                                  )}
                                  {o && (
                                    <>
                                      <span className="cn2b-nl-row__meta" data-testid="cn2b-nl-override-evidence">
                                        {t('cn2b_nl_override_recorded', lang)}: <strong>{overrideValue ?? '—'}</strong> — {o.overrideReason}
                                      </span>
                                      <label className="cn2b-nl-contrib__override">
                                        <input
                                          type="checkbox"
                                          checked={picked.overrideId === o.id}
                                          onChange={(e) => useOverride(r, o, e.target.checked)}
                                        />
                                        {t('cn2b_nl_use_override', lang)}
                                      </label>
                                      {picked.overrideId === o.id && (
                                        <span className="cn2b-nl-row__meta" data-testid="cn2b-nl-override-applied">{t('cn2b_nl_override_applied', lang)}</span>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </fieldset>

          {/* 2 — SELECTED SOURCES → RESULTING NEED LINES, read off the
              canonical `groups` model; live while nothing is being confirmed. */}
          {selectedIds.length > 0 && (
            <section className="cn2b-nl-selection" data-testid="cn2b-nl-selection" aria-labelledby={`${domId}-selection`}>
              <h4 className="cn2b-nl-section__title" id={`${domId}-selection`}>{t('cn2b_nl_selection_title', lang)}</h4>
              <dl className="cn2b-nl-counts-dl">
                <div><dt>{t('cn2b_nl_selection_sources', lang)}</dt><dd data-nl-sel="sources">{selectedIds.length}</dd></div>
                <div><dt>{t('cn2b_nl_selection_beneficiaries', lang)}</dt><dd data-nl-sel="beneficiaries">{selectedBeneficiaryIds.size}</dd></div>
                <div><dt>{t('cn2b_nl_selection_scopes', lang)}</dt><dd data-nl-sel="scopes">{groups.size}</dd></div>
              </dl>
              <ul className="cn2b-nl-scopes">
                {[...groups.values()].sort(byInstitutionName).map((g) => (
                  <li key={scopeKey(g.beneficiaryId, g.itemId, g.warehouseId)} className="cn2b-nl-scope"
                    data-testid="cn2b-nl-selection-scope" data-existing={g.existing ? 'true' : 'false'}
                    data-beneficiary={g.beneficiaryId}>
                    <div className="cn2b-nl-scope__head">
                      <strong>{institutionName(g.beneficiaryId)}</strong>
                      <code className="cn2b-nl-code">{g.itemId}</code>
                      <span>{warehouseLabel(g.warehouseId)}</span>
                      <span>
                        {t('cn2b_nl_scope_added', lang)}:{' '}
                        <strong data-nl-scope="added">{g.added === '' ? t('cn2b_nl_quantity_invalid_short', lang) : g.added}</strong>
                      </span>
                      <span className="cn2b-nl-effect" data-effect={g.existing ? 'extends' : 'new'}>
                        {g.existing ? t('cn2b_nl_adds_to_existing', lang) : t('cn2b_nl_creates_new', lang)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {unavailableSelectedIds.length > 0 && (
                <div className="cn2b-nl-stale" data-testid="cn2b-nl-unavailable-selection">
                  <p style={{ margin: 0 }}>
                    {t('cn2b_nl_unavailable_selected', lang).replace('__N__', String(unavailableSelectedIds.length))}
                  </p>
                  <PhoenixButton type="button" size="sm" variant="danger" disabled={busy} onClick={removeUnavailableSelections}>
                    {t('cn2b_nl_unavailable_remove', lang)}
                  </PhoenixButton>
                </div>
              )}
            </section>
          )}

          {/* 3 — LINE ATTRIBUTES: unit semantics and warehouse scope. */}
          <section className="cn2b-nl-section" aria-labelledby={`${domId}-attributes`}>
            <h4 className="cn2b-nl-section__title" id={`${domId}-attributes`}>{t('cn2b_nl_attributes_title', lang)}</h4>
            <p className="cn2b-nl-hint">{t('cn2b_nl_quantity_hint', lang)}</p>
            <div className="cn2b-nl-attributes">
              <div>
                <p className="cn2b-nl-hint" data-testid="cn2b-nl-unit-explainer">{t('cn2b_nl_unit_explainer', lang)}</p>
                <label>
                  <input
                    type="checkbox"
                    checked={conversionRequired}
                    onChange={(e) => { setConversionRequired(e.target.checked); setPreview(null); }}
                  />
                  {t('cn2b_nl_unit_conversion_required', lang)}
                </label>

                {!conversionRequired && (
                  <label>
                    {t('cn2b_nl_unit', lang)}
                    <select
                      className="cn2b-nl-select"
                      aria-label={t('cn2b_nl_unit', lang)}
                      value={unit}
                      onChange={(e) => { setUnit(e.target.value as NeedLineUnit); setPreview(null); }}
                    >
                      {NEED_LINE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </label>
                )}

                <PhoenixInput
                  label={t('cn2b_nl_source_unit', lang)}
                  value={sourceUnitText}
                  onChange={(e) => { setSourceUnitText(e.target.value); setPreview(null); }}
                />

                {/* Told BEFORE confirming: an existing line's unit is never re-interpreted. */}
                {anyExisting && <p className="cn2b-nl-note" data-testid="cn2b-nl-unit-locked-note">{t('cn2b_nl_unit_locked_note', lang)}</p>}
              </div>

              <div>
                <label>
                  {t('cn2b_nl_warehouse', lang)}
                  <select
                    className="cn2b-nl-select"
                    aria-label={t('cn2b_nl_warehouse', lang)}
                    value={targetWarehouseId}
                    disabled={!singleSelectedBeneficiary}
                    onChange={(e) => { setTargetWarehouseId(e.target.value); setPreview(null); }}
                  >
                    <option value="">{t('cn2b_nl_warehouse_none', lang)}</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>{lang === 'ar' ? w.name_ar : w.name}</option>
                    ))}
                  </select>
                </label>
                {/* (213) A warehouse belongs to one organization, so it can only
                    scope a selection that resolves to a single beneficiary. */}
                <p className="cn2b-nl-hint" data-testid="cn2b-nl-warehouse-hint"
                  data-warehouse-state={selectedBeneficiaryIds.size > 1 ? 'multi' : singleSelectedBeneficiary ? 'single' : 'none'}>
                  {selectedBeneficiaryIds.size > 1
                    ? t('cn2b_nl_warehouse_multi_beneficiary_disabled', lang)
                    : singleSelectedBeneficiary
                      ? <>{t('cn2b_nl_warehouse_of', lang)} {institutionName(singleSelectedBeneficiary)}. {t('cn2b_nl_warehouse_hint', lang)}</>
                      : t('cn2b_nl_warehouse_needs_selection', lang)}
                </p>
              </div>
            </div>
          </section>

          {/* 4 — CHECK AND CONFIRM. The reason sits beside the action it justifies. */}
          <section className="cn2b-nl-section" aria-labelledby={`${domId}-review`}>
            <h4 className="cn2b-nl-section__title" id={`${domId}-review`}>{t('cn2b_nl_review_title', lang)}</h4>

            <PhoenixInput
              label={t('cn2b_nl_reason', lang)}
              value={reason}
              onChange={(e) => { setReason(e.target.value); setPreview(null); }}
              error={reason.trim() === '' ? t('cn2b_nl_reason_required', lang) : undefined}
            />

            {/* The approved total is never typed: it IS the designated sum, plus
                whatever the line already holds when it exists — one figure per
                (beneficiary, material, warehouse) scope. */}
            <p className="cn2b-nl-total" data-testid="cn2b-nl-total">
              {t('cn2b_nl_total', lang)}:{' '}
              {[...groups.values()]
                .map((g) => `${institutionName(g.beneficiaryId)} / ${g.itemId}=${g.total}`)
                .join(' · ') || '—'}
            </p>

            {!preview && saveBlockers.length > 0 && (
              <div data-testid="cn2b-nl-save-blockers">
                <p className="cn2b-nl-hint">{t('cn2b_nl_blockers_title', lang)}</p>
                <ul className="cn2b-nl-blockers">
                  {saveBlockers.map((k) => <li key={k} data-blocker={k}>{t(k, lang)}</li>)}
                </ul>
              </div>
            )}

            {!preview && (
              <div className="cn2b-nl-actions">
                <PhoenixButton
                  type="button"
                  disabled={!canSave || busy}
                  onClick={openPreview}
                >
                  {groups.size > 1 ? t('cn2b_nl_bulk_preview', lang) : t('cn2b_nl_save', lang)}
                </PhoenixButton>
              </div>
            )}

            {preview && (
              <div className="cn2b-nl-preview" data-testid="cn2b-nl-preview" data-stale={previewStale ? 'true' : 'false'}>
                <p className="cn2b-nl-section__title">{t('cn2b_nl_preview_heading', lang)}</p>
                <p className="cn2b-nl-hint">{t('cn2b_nl_preview_explainer', lang)}</p>
                <p style={{ margin: 0 }}>
                  {t('cn2b_nl_bulk_affected', lang)}:{' '}
                  <strong data-testid="cn2b-nl-affected">{previewSourceCount}</strong>
                  {' · '}
                  {t('cn2b_nl_lines_to_create', lang)}:{' '}
                  <strong data-testid="cn2b-nl-lines">{preview.plan.length}</strong>
                  {previewBeneficiaryCount > 1 && (
                    <>
                      {' · '}
                      <strong data-testid="cn2b-nl-beneficiary-count">{previewBeneficiaryCount}</strong>
                      {' '}{t('cn2b_nl_multi_beneficiary_note', lang)}
                    </>
                  )}
                </p>
                {/* (213) Grouped by beneficiary FIRST, so a multi-institution
                    bulk save is reviewed the way section 18 of the corrective
                    brief describes it: Hospital A's lines, then Hospital B's. */}
                <ul className="cn2b-nl-scopes">
                  {[...preview.plan]
                    .sort((a, b) => byInstitutionName(a.group, b.group))
                    .map(({ key, group: g, input }) => (
                    <li key={key} className="cn2b-nl-scope"
                      data-testid="cn2b-nl-preview-group" data-existing={g.existing ? 'true' : 'false'}
                      data-beneficiary={g.beneficiaryId}>
                      <div className="cn2b-nl-scope__head">
                        <strong>{institutionName(g.beneficiaryId)}</strong>
                        <span className="cn2b-nl-effect" data-effect={g.existing ? 'extends' : 'new'}>
                          {g.existing ? t('cn2b_nl_adds_to_existing', lang) : t('cn2b_nl_creates_new', lang)}
                        </span>
                      </div>
                      <dl className="cn2b-nl-facts">
                        <div><dt>{t('cn2b_nl_scope_material', lang)}</dt><dd><code className="cn2b-nl-code" data-nl-scope="material">{g.itemId}</code></dd></div>
                        <div><dt>{t('cn2b_nl_scope_warehouse', lang)}</dt><dd data-nl-scope="warehouse">{warehouseLabel(g.warehouseId)}</dd></div>
                        <div><dt>{t('cn2b_nl_scope_new_sources', lang)}</dt><dd data-nl-scope="new-sources">{g.recordIds.length}</dd></div>
                        <div><dt>{t('cn2b_nl_scope_added', lang)}</dt><dd data-nl-scope="added">{g.added}</dd></div>
                        {g.existing && (
                          <>
                            <div><dt>{t('cn2b_nl_current_total', lang)}</dt><dd data-nl-scope="current">{g.existing.approvedQuantity}</dd></div>
                            <div><dt>{t('cn2b_nl_scope_existing_sources', lang)}</dt><dd data-nl-scope="existing-sources">{g.expectedIds.length}</dd></div>
                          </>
                        )}
                        <div><dt>{t('cn2b_nl_new_total', lang)}</dt><dd data-nl-scope="resulting">{g.total}</dd></div>
                        <div>
                          <dt>{t('cn2b_nl_scope_unit', lang)}</dt>
                          <dd data-nl-scope="unit">
                            {unitLabel(input.approvedUnit, input.unitConversionState)}
                            {g.existing && <> ({t('cn2b_nl_scope_unit_locked', lang)})</>}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
                {preview.plan.some((p) => p.group.existing) && (
                  <p className="cn2b-nl-note" data-testid="cn2b-nl-unit-locked">{t('cn2b_nl_existing_unit_locked', lang)}</p>
                )}
                <p className="cn2b-nl-hint" data-testid="cn2b-nl-preview-reason">
                  {t('cn2b_nl_preview_reason', lang)}: {preview.plan[0]?.input.mappingReason}
                </p>
                {previewStale && (
                  <p className="cn2b-nl-stale" data-testid="cn2b-nl-preview-stale">{t('cn2b_nl_preview_stale', lang)}</p>
                )}
                <div className="cn2b-nl-actions">
                  <PhoenixButton type="button" disabled={!canConfirm} loading={busy} onClick={() => void commit()}>
                    {t('cn2b_nl_bulk_confirm', lang)}
                  </PhoenixButton>
                  {previewStale && canSave && (
                    <PhoenixButton type="button" variant="secondary" disabled={busy} onClick={openPreview}>
                      {t('cn2b_nl_preview_refresh', lang)}
                    </PhoenixButton>
                  )}
                  <PhoenixButton
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPreview(null)}
                  >
                    {t('cn2b_nl_bulk_cancel', lang)}
                  </PhoenixButton>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {error && (
        <div className="cn2b-nl-error" role="alert" data-testid="cn2b-nl-error">
          <strong>{t('cn2b_nl_error_title', lang)}</strong> <span>{error}</span>
        </div>
      )}
      {notice && <p className="cn2b-nl-notice" data-testid="cn2b-nl-notice">{notice}</p>}

      {/* 5 — THE REGISTER: saved lines, each with its revision-wide provenance. */}
      <section className="cn2b-nl-section" aria-labelledby={`${domId}-register`}>
        <h4 className="cn2b-nl-section__title" id={`${domId}-register`}>
          {t('cn2b_nl_register_title', lang)} ({needLines.length})
        </h4>
        <p className="cn2b-nl-hint">{t('cn2b_nl_register_hint', lang)}</p>
        <ul className="cn2b-nl-register__list" data-testid="cn2b-nl-list">
          {needLines.length === 0 && <li className="cn2b-nl-empty" data-empty="no-lines">{t('cn2b_nl_none_yet', lang)}</li>}
          {needLines.map((n) => {
            const sources = sourcesByLine.get(n.id) ?? [];
            const quantityText = `${n.approvedQuantity} ${unitLabel(n.approvedUnit, n.unitConversionState)}`;
            return (
              <li key={n.id} className="cn2b-nl-line" data-testid="cn2b-nl-line"
                data-conversion={n.unitConversionState === 'conversion_required' ? 'true' : 'false'}>
                <div className="cn2b-nl-line__head">
                  <strong>{institutionName(n.beneficiaryOrganizationId)}</strong>
                  <span className="cn2b-nl-line__qty" data-nl-line="quantity">{quantityText}</span>
                </div>
                <dl className="cn2b-nl-facts">
                  <div><dt>{t('cn2b_nl_scope_material', lang)}</dt><dd><code className="cn2b-nl-code">{n.centralItemId}</code></dd></div>
                  <div><dt>{t('cn2b_nl_scope_warehouse', lang)}</dt><dd data-nl-line="warehouse">{warehouseLabel(n.targetWarehouseId)}</dd></div>
                  <div><dt>{t('cn2b_nl_line_sources', lang)}</dt><dd data-nl-line="sources">{sources.length}</dd></div>
                  {n.sourceUnitText && <div><dt>{t('cn2b_nl_source_unit', lang)}</dt><dd>{n.sourceUnitText}</dd></div>}
                  <div className="cn2b-nl-facts__wide"><dt>{t('cn2b_nl_preview_reason', lang)}</dt><dd data-nl-line="reason">{n.mappingReason}</dd></div>
                </dl>
                {/* The line's whole lineage, revision-wide: an operator adding to or
                    deleting this line sees what it already contains. */}
                <ul className="cn2b-nl-lineage" aria-label={t('cn2b_nl_lineage', lang)} data-testid="cn2b-nl-lineage">
                  {sources.map((s) => (
                    <li key={s.sourceRecordId} data-other-session={activeSessionIds.has(s.importSessionId) ? 'false' : 'true'}>
                      <span className="cn2b-nl-row__ident">{s.targetEntity} · {s.fieldName}</span>
                      {' = '}<strong>{s.designatedQuantity}</strong>
                      {s.appliedOverrideId && <> ({t('cn2b_nl_override_in_lineage', lang)})</>}
                      {!activeSessionIds.has(s.importSessionId) && <> ({t('cn2b_nl_other_session', lang)})</>}
                    </li>
                  ))}
                </ul>
                {editable && deletingLineId !== n.id && (
                  <div className="cn2b-nl-actions">
                    <PhoenixButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => { setDeletingLineId(n.id); setDeleteReason(''); setError(null); }}
                    >
                      {t('cn2b_nl_delete', lang)}
                    </PhoenixButton>
                  </div>
                )}
                {editable && deletingLineId === n.id && (
                  <div className="cn2b-nl-delete" data-testid="cn2b-nl-delete-confirm">
                    <p className="cn2b-nl-delete__title">{t('cn2b_nl_delete_title', lang)}</p>
                    <dl className="cn2b-nl-facts">
                      <div className="cn2b-nl-facts__wide">
                        <dt>{t('cn2b_nl_delete_line_label', lang)}</dt>
                        <dd data-nl-delete="line">
                          {institutionName(n.beneficiaryOrganizationId)} · {n.centralItemId} · {quantityText} · {warehouseLabel(n.targetWarehouseId)}
                        </dd>
                      </div>
                      <div><dt>{t('cn2b_nl_delete_sources_affected', lang)}</dt><dd data-nl-delete="sources">{sources.length}</dd></div>
                    </dl>
                    <p>{t('cn2b_nl_delete_explainer', lang)}</p>
                    <PhoenixInput
                      label={t('cn2b_nl_delete_reason', lang)}
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      error={deleteReason.trim() === '' ? t('cn2b_nl_delete_reason_required', lang) : undefined}
                    />
                    <div className="cn2b-nl-actions">
                      <PhoenixButton
                        type="button"
                        variant="danger"
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
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </PhoenixCard>
  );
}
