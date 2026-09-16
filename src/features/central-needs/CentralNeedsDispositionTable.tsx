/**
 * CN-2B — source review and explicit disposition.
 *
 * SOURCE IS NEVER REPLACED. Each field shows its immutable source value and,
 * when a reasoned override exists, the effective value BESIDE it with the
 * reason and the provenance. The two are different columns with different
 * headings; an override never overwrites the cell it corrects.
 *
 * Every value is rendered as text through React, so a cell containing markup
 * is displayed as the characters it holds. Nothing here evaluates a formula:
 * a formula cell shows its verbatim formula text and its cached value as
 * separate facts, and `formattedText` is never used as the value.
 *
 * DISPOSITION IS ALWAYS A HUMAN DECISION. This component offers exactly the
 * two the database accepts — map to a central item, or mark not applicable
 * with a reason — and it never pre-selects, guesses or infers one from the
 * shape of the row. A subtotal line and a medicine line look identical to it,
 * which is the honest state of the evidence.
 *
 * BULK ACTIONS ALWAYS PREVIEW. `targetEntity` is row-level, so a real workbook
 * produces many, and marking them one at a time is impractical. A bulk action
 * therefore states exactly how many entities it will change and requires a
 * second, explicit confirmation before any RPC is called.
 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { centralNeedsErrorText } from './central-needs.i18n';
import {
  CentralNeedsError,
  recordFieldOverride,
  searchCentralItems,
  setRecordDisposition,
  type CentralItemOption,
  type FieldOverride,
  type RecordDisposition,
  type SourceRecord,
} from './central-needs.service';

interface Props {
  importSessionId: string;
  records: SourceRecord[];
  dispositions: RecordDisposition[];
  overrides: FieldOverride[];
  organizationId: string;
  canEdit: boolean;
  onChanged: () => void;
  /** UX-3R Package B: session switching must not silently discard local work. */
  onActivityChange?: (activity: { busy: boolean; dirty: boolean; failed: boolean }) => void;
}

interface EntityGroup {
  targetEntity: string;
  ordinal: number;
  fields: SourceRecord[];
}

/**
 * UX-2A — the review workbench's decision filter. Presentation only: these are
 * the two decisions the database already accepts plus "no decision yet", and
 * choosing one narrows what is DISPLAYED. It decides nothing.
 */
type DecisionFilter = 'all' | 'undecided' | 'mapped' | 'not_applicable';

/** The explicit JSON shape a corrected value is stored as. */
type OverrideValueKind = 'number' | 'text' | 'boolean' | 'blank';

/**
 * The kind a source value already has, used only to PRE-SELECT the control.
 * The reviewer can always change it, because a correction may legitimately
 * change the type — a cell that was imported as the text "12 boxes" may be
 * corrected to the number 12.
 */
function kindOfSourceValue(values: Record<string, unknown>): OverrideValueKind {
  const raw = values.value;
  if (raw === null || raw === undefined) return 'blank';
  if (typeof raw === 'number') return 'number';
  if (typeof raw === 'boolean') return 'boolean';
  return 'text';
}

/**
 * Builds the JSON value to persist. NOTHING is silently coerced: the reviewer
 * states the kind, and each kind has exactly one reading.
 *
 *   number  — must parse as a finite number. "0" is the number zero, which is
 *             a value, never a blank. A non-numeric entry is refused rather
 *             than quietly becoming NaN or 0.
 *   text    — stored verbatim, including "0" as the two-character string.
 *   boolean — only the two literals.
 *   blank   — JSON null, the explicit "no value" the CN-2A contract
 *             distinguishes from both zero and an empty string.
 */
function buildOverrideValue(
  kind: OverrideValueKind, raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (kind === 'blank') return { ok: true, value: null };
  if (kind === 'number') {
    if (raw.trim() === '') return { ok: false, reason: 'number_required' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: 'number_required' };
    return { ok: true, value: n };
  }
  if (kind === 'boolean') {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, reason: 'boolean_required' };
  }
  return { ok: true, value: raw };
}

/** Renders an immutable source value as text — never as markup, never coerced. */
function SourceValue({ values }: { values: Record<string, unknown> }) {
  const { lang } = useApp();
  const raw = values.value;
  const valueType = typeof values.valueType === 'string' ? values.valueType : null;
  const isFormula = values.isFormula === true;
  const formula = typeof values.formula === 'string' ? values.formula : null;

  return (
    <span className="cn2b-value">
      <span className="cn2b-value__raw">{raw === null ? t('cn2b_value_blank', lang) : String(raw)}</span>
      {valueType && <span className="cn2b-value__type">{valueType}</span>}
      {isFormula && formula && (
        <span className="cn2b-value__formula" title={t('cn2b_formula_not_evaluated', lang)}>
          {formula}
        </span>
      )}
    </span>
  );
}

export function CentralNeedsDispositionTable({
  importSessionId,
  records,
  dispositions,
  overrides,
  canEdit,
  onChanged,
  onActivityChange,
}: Props) {
  const { lang } = useApp();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkReason, setBulkReason] = useState('');
  const [bulkPreview, setBulkPreview] = useState<number | null>(null);
  const [itemQuery, setItemQuery] = useState('');
  const [items, setItems] = useState<CentralItemOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // H — the field-override editor. One row at a time, opened explicitly.
  const [overrideFor, setOverrideFor] = useState<SourceRecord | null>(null);
  const [overrideKind, setOverrideKind] = useState<OverrideValueKind>('text');
  const [overrideRaw, setOverrideRaw] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideNote, setOverrideNote] = useState('');


  const dirty = selected.size > 0
    || bulkReason.trim() !== ''
    || bulkPreview !== null
    || overrideFor !== null
    || overrideRaw !== ''
    || overrideReason.trim() !== ''
    || overrideNote.trim() !== '';

  useEffect(() => {
    onActivityChange?.({ busy, dirty, failed: error !== null });
  }, [busy, dirty, error, onActivityChange]);

  /** A confirmed Work Session change discards only session-local draft UI. */
  useEffect(() => {
    setSelected(new Set());
    setBulkReason('');
    setBulkPreview(null);
    setItemQuery('');
    setItems([]);
    setError(null);
    setOverrideFor(null);
    setOverrideRaw('');
    setOverrideReason('');
    setOverrideNote('');
  }, [importSessionId]);

  const groups = useMemo<EntityGroup[]>(() => {
    const byEntity = new Map<string, EntityGroup>();
    for (const r of records) {
      const existing = byEntity.get(r.targetEntity);
      if (existing) existing.fields.push(r);
      else byEntity.set(r.targetEntity, { targetEntity: r.targetEntity, ordinal: r.recordOrdinal, fields: [r] });
    }
    return [...byEntity.values()].sort((a, b) => a.ordinal - b.ordinal);
  }, [records]);

  const dispositionByEntity = useMemo(() => {
    const map = new Map<string, RecordDisposition>();
    for (const d of dispositions) map.set(d.targetEntity, d);
    return map;
  }, [dispositions]);

  const overrideByRecord = useMemo(() => {
    const map = new Map<string, FieldOverride>();
    for (const o of overrides) map.set(o.sourceRecordId, o);
    return map;
  }, [overrides]);

  const undecidedCount = groups.filter((g) => !dispositionByEntity.has(g.targetEntity)).length;

  /**
   * UX-2A — the PRESENTATION filter. It is client-only by construction: it
   * reads the records, dispositions and overrides already in props and calls
   * nothing. A workbook produces hundreds of row entities, and scrolling for
   * the undecided ones was the whole review loop.
   *
   * It filters ENTITY GROUPS, never individual field rows. A matched entity is
   * shown with every one of its source fields, because hiding part of an
   * entity's evidence while showing the rest would misrepresent what the
   * workbook actually contains — the opposite of what this screen exists for.
   */
  const [textFilter, setTextFilter] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
  const filtersActive = textFilter.trim() !== '' || decisionFilter !== 'all';

  const visibleGroups = useMemo<EntityGroup[]>(() => {
    const needle = textFilter.trim().toLowerCase();
    return groups.filter((group) => {
      const decision = dispositionByEntity.get(group.targetEntity);
      if (decisionFilter === 'undecided' && decision) return false;
      if (decisionFilter === 'mapped' && decision?.decision !== 'mapped') return false;
      if (decisionFilter === 'not_applicable' && decision?.decision !== 'not_applicable') return false;
      if (needle === '') return true;
      // Everything the operator can already see for this entity, and nothing
      // else: no request, no derived business value.
      const haystack: string[] = [group.targetEntity, decision?.decisionReason ?? ''];
      for (const field of group.fields) {
        const provenance = field.sourceProvenance ?? {};
        const coordinate = provenance.coordinate as { a1?: string } | undefined;
        const raw = field.sourceValues?.value;
        haystack.push(
          field.fieldName,
          raw === null || raw === undefined ? '' : String(raw),
          typeof provenance.sheetName === 'string' ? provenance.sheetName : '',
          coordinate?.a1 ?? '',
          overrideByRecord.get(field.id)?.overrideReason ?? '',
        );
      }
      return haystack.join('\u0000').toLowerCase().includes(needle);
    });
  }, [groups, dispositionByEntity, overrideByRecord, textFilter, decisionFilter]);

  /**
   * Selection is the REVIEWER's, not the filter's. A hidden entity stays
   * selected — the count below keeps saying so — because silently dropping it
   * would change what a confirmed bulk action does without anyone deciding to.
   */
  function clearFilters() {
    setTextFilter('');
    setDecisionFilter('all');
  }

  async function onSearchItems(query: string) {
    setItemQuery(query);
    if (query.trim().length < 2) { setItems([]); return; }
    try {
      setItems(await searchCentralItems(query.trim()));
    } catch {
      setItems([]);
    }
  }

  async function applyOne(targetEntity: string, decision: 'mapped' | 'not_applicable', centralItemId?: string, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      await setRecordDisposition({ importSessionId, targetEntity, decision, centralItemId, decisionReason: reason });
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'disposition_failed');
    } finally {
      setBusy(false);
    }
  }

  /** Second step of the bulk flow — only reachable after the count was shown. */
  async function confirmBulkNotApplicable() {
    if (bulkPreview === null || bulkReason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      for (const targetEntity of selected) {
        await setRecordDisposition({
          importSessionId,
          targetEntity,
          decision: 'not_applicable',
          decisionReason: bulkReason.trim(),
        });
      }
      setSelected(new Set());
      setBulkPreview(null);
      setBulkReason('');
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'disposition_failed');
    } finally {
      setBusy(false);
    }
  }

  function openOverride(field: SourceRecord) {
    setError(null);
    setOverrideFor(field);
    setOverrideKind(kindOfSourceValue(field.sourceValues));
    // Deliberately NOT pre-filled with the source value: a correction is a new
    // statement, not an edit of the evidence, and pre-filling invites a
    // reviewer to "confirm" a value they never actually re-read.
    setOverrideRaw('');
    setOverrideReason('');
    setOverrideNote('');
  }

  function closeOverride() {
    setOverrideFor(null);
    setOverrideRaw('');
    setOverrideReason('');
    setOverrideNote('');
  }

  async function submitOverride() {
    if (!overrideFor || overrideReason.trim() === '') return;
    const built = buildOverrideValue(overrideKind, overrideRaw);
    if (!built.ok) { setError(built.reason); return; }
    setBusy(true);
    setError(null);
    try {
      await recordFieldOverride({
        sourceRecordId: overrideFor.id,
        finalValue: built.value,
        overrideReason: overrideReason.trim(),
        overrideNote: overrideNote.trim() === '' ? null : overrideNote.trim(),
      });
      closeOverride();
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'override_failed');
    } finally {
      setBusy(false);
    }
  }

  function toggle(targetEntity: string) {
    setBulkPreview(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(targetEntity)) next.delete(targetEntity);
      else next.add(targetEntity);
      return next;
    });
  }

  return (
    <div className="cn2b-review">
      {/*
        UX-2A review workbench. Every number here is counted off state already
        on screen, and every control below narrows the VIEW only — none of them
        reaches the server, and none of them decides anything.
      */}
      <div className="cn2b-toolbar cn2b-toolbar--review">
        <label className="cn2b-field cn2b-toolbar__grow" htmlFor="cn2b-review-filter">
          <span className="cn2b-field__label">{t('cn2b_filter_text', lang)}</span>
          <input
            id="cn2b-review-filter"
            className="cn2b-input"
            type="search"
            value={textFilter}
            placeholder={t('cn2b_filter_text_hint', lang)}
            onChange={(e) => setTextFilter(e.target.value)}
          />
        </label>
        <label className="cn2b-field" htmlFor="cn2b-review-decision">
          <span className="cn2b-field__label">{t('cn2b_filter_decision', lang)}</span>
          <select
            id="cn2b-review-decision"
            className="cn2b-select"
            value={decisionFilter}
            onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
          >
            <option value="all">{t('cn2b_filter_all', lang)}</option>
            <option value="undecided">{t('cn2b_filter_undecided', lang)}</option>
            <option value="mapped">{t('cn2b_filter_mapped', lang)}</option>
            <option value="not_applicable">{t('cn2b_filter_not_applicable', lang)}</option>
          </select>
        </label>
        <div className="cn2b-toolbar__actions">
          <button type="button" className="cn2b-btn" disabled={!filtersActive} onClick={clearFilters}>
            {t('cn2b_filter_clear', lang)}
          </button>
        </div>
      </div>

      <dl className="cn2b-counts" role="status">
        <div className="cn2b-counts__cell">
          <dt>{t('cn2b_entities_total', lang)}</dt>
          <dd data-count="total">{groups.length}</dd>
        </div>
        <div className="cn2b-counts__cell">
          <dt>{t('cn2b_entities_visible', lang)}</dt>
          <dd data-count="visible">{visibleGroups.length}</dd>
        </div>
        <div className="cn2b-counts__cell">
          <dt>{t('cn2b_entities_undecided', lang)}</dt>
          <dd data-count="undecided">{undecidedCount}</dd>
        </div>
        <div className="cn2b-counts__cell">
          <dt>{t('cn2b_entities_selected', lang)}</dt>
          <dd data-count="selected">{selected.size}</dd>
        </div>
      </dl>

      {error && <p className="cn2b-error" role="alert">{centralNeedsErrorText(error, lang)}</p>}

      {canEdit && (
        <fieldset className="cn2b-bulk">
          <legend>{t('cn2b_bulk_legend', lang)}</legend>
          <p className="cn2b-hint">{t('cn2b_bulk_explainer', lang)}</p>
          {/*
            UX-2A — the workbench states its own subject before anything else:
            how many entities the reviewer has selected. The two-step gate below
            is unchanged — reason, then an explicit count, then a separate
            confirm — because that count is the last thing standing between a
            selection and a write.
          */}
          <p className="cn2b-bulk__selection" role="status">
            {t('cn2b_entities_selected', lang)}: <strong>{selected.size}</strong>
          </p>
          <label className="cn2b-field" htmlFor="cn2b-bulk-reason">
            <span className="cn2b-field__label">{t('cn2b_bulk_reason', lang)}</span>
            <input
              id="cn2b-bulk-reason"
              className="cn2b-input"
              type="text"
              value={bulkReason}
              onChange={(e) => { setBulkReason(e.target.value); setBulkPreview(null); }}
            />
          </label>
          <div className="cn2b-actions">
            <button
              type="button"
              className="cn2b-btn"
              disabled={busy || selected.size === 0 || bulkReason.trim() === ''}
              onClick={() => setBulkPreview(selected.size)}
            >
              {t('cn2b_bulk_preview', lang)}
            </button>
            {bulkPreview !== null && (
              <>
                <span className="cn2b-bulk__count" role="status">
                  {t('cn2b_bulk_will_change', lang)}: {bulkPreview}
                </span>
                <button
                  type="button"
                  className="cn2b-btn cn2b-btn--primary"
                  disabled={busy}
                  onClick={() => void confirmBulkNotApplicable()}
                >
                  {t('cn2b_bulk_confirm', lang)}
                </button>
              </>
            )}
          </div>
        </fieldset>
      )}

      {canEdit && (
        /*
          UX-2A — FINDING a canonical material and APPLYING it are separated
          visually, and only visually. Searching still proposes nothing: no best
          match, no fuzzy pick, no default selection. The mapping happens when
          the reviewer presses the map action on a specific row, exactly as
          before, using the identifier they themselves chose here.
        */
        <div className="cn2b-lookup">
          <label className="cn2b-field" htmlFor="cn2b-item-search">
            <span className="cn2b-field__label">{t('cn2b_item_search', lang)}</span>
            <input
              id="cn2b-item-search"
              className="cn2b-input"
              type="search"
              value={itemQuery}
              onChange={(e) => void onSearchItems(e.target.value)}
              list="cn2b-item-options"
            />
            <datalist id="cn2b-item-options">
              {items.map((i) => <option key={i.id} value={i.id} label={i.name} />)}
            </datalist>
          </label>
          <p className="cn2b-hint">{t('cn2b_item_search_explainer', lang)}</p>
        </div>
      )}

      {/*
        Three distinct situations, never collapsed into one another: the
        session carries no source evidence at all; the evidence is there but
        this filter matches none of it; or there are rows to review.
      */}
      {groups.length === 0 ? (
        <PhoenixEmptyState title={t('cn2b_no_source_records', lang)} />
      ) : visibleGroups.length === 0 ? (
        <PhoenixEmptyState title={t('cn2b_filter_no_matches', lang)} />
      ) : (
      <div className="cn2b-scroll">
        <table className="cn2b-table cn2b-table--review">
          <caption className="cn2b-visually-hidden">{t('cn2b_panel_review', lang)}</caption>
          <thead>
            <tr>
              {canEdit && <th scope="col">{t('cn2b_col_select', lang)}</th>}
              <th scope="col">{t('cn2b_col_entity', lang)}</th>
              <th scope="col">{t('cn2b_col_field', lang)}</th>
              <th scope="col">{t('cn2b_col_source_value', lang)}</th>
              <th scope="col">{t('cn2b_col_effective_value', lang)}</th>
              <th scope="col">{t('cn2b_col_provenance', lang)}</th>
              <th scope="col">{t('cn2b_col_decision', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((group) => {
              const decision = dispositionByEntity.get(group.targetEntity);
              return group.fields.map((field, index) => {
                const override = overrideByRecord.get(field.id);
                const provenance = field.sourceProvenance ?? {};
                const coordinate = provenance.coordinate as { a1?: string } | undefined;
                return (
                  <tr key={field.id} data-undecided={decision ? undefined : true}>
                    {canEdit && index === 0 && (
                      <td rowSpan={group.fields.length}>
                        <label className="cn2b-visually-hidden" htmlFor={`sel-${group.targetEntity}`}>
                          {group.targetEntity}
                        </label>
                        <input
                          id={`sel-${group.targetEntity}`}
                          type="checkbox"
                          checked={selected.has(group.targetEntity)}
                          onChange={() => toggle(group.targetEntity)}
                        />
                      </td>
                    )}
                    {index === 0 && (
                      <th scope="row" rowSpan={group.fields.length}>
                        <code className="cn2b-code">{group.targetEntity}</code>
                      </th>
                    )}
                    <td>{field.fieldName}</td>
                    <td><SourceValue values={field.sourceValues} /></td>
                    <td>
                      {override ? (
                        <span className="cn2b-effective">
                          <span className="cn2b-effective__value">
                            {override.finalValue === null
                              ? t('cn2b_value_blank', lang)
                              : String(override.finalValue)}
                          </span>
                          <span className="cn2b-effective__reason">{override.overrideReason}</span>
                        </span>
                      ) : (
                        <span className="cn2b-effective cn2b-effective--same">{t('cn2b_effective_same', lang)}</span>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          className="cn2b-btn cn2b-btn--sm"
                          disabled={busy}
                          onClick={() => openOverride(field)}
                        >
                          {override ? t('cn2b_override_replace', lang) : t('cn2b_override', lang)}
                        </button>
                      )}
                      {overrideFor?.id === field.id && (
                        <div className="cn2b-override" role="group" aria-label={t('cn2b_override', lang)}>
                          {/* The immutable source value stays on screen, in its own
                              cell, while the correction is being written. */}
                          <label className="cn2b-field">
                            <span className="cn2b-field__label">{t('cn2b_override_kind', lang)}</span>
                            <select
                              className="cn2b-select"
                              value={overrideKind}
                              onChange={(e) => setOverrideKind(e.target.value as OverrideValueKind)}
                            >
                              <option value="number">{t('cn2b_kind_number', lang)}</option>
                              <option value="text">{t('cn2b_kind_text', lang)}</option>
                              <option value="boolean">{t('cn2b_kind_boolean', lang)}</option>
                              <option value="blank">{t('cn2b_kind_blank', lang)}</option>
                            </select>
                          </label>
                          {overrideKind !== 'blank' && (
                            <label className="cn2b-field">
                              <span className="cn2b-field__label">{t('cn2b_override_value', lang)}</span>
                              {overrideKind === 'boolean' ? (
                                <select
                                  className="cn2b-select"
                                  value={overrideRaw}
                                  onChange={(e) => setOverrideRaw(e.target.value)}
                                >
                                  <option value="">—</option>
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                              ) : (
                                <input
                                  className="cn2b-input"
                                  type="text"
                                  inputMode={overrideKind === 'number' ? 'decimal' : 'text'}
                                  value={overrideRaw}
                                  onChange={(e) => setOverrideRaw(e.target.value)}
                                />
                              )}
                            </label>
                          )}
                          <label className="cn2b-field">
                            <span className="cn2b-field__label">{t('cn2b_override_reason', lang)}</span>
                            <input
                              className="cn2b-input"
                              type="text"
                              value={overrideReason}
                              onChange={(e) => setOverrideReason(e.target.value)}
                            />
                          </label>
                          <label className="cn2b-field">
                            <span className="cn2b-field__label">{t('cn2b_override_note', lang)}</span>
                            <input
                              className="cn2b-input"
                              type="text"
                              value={overrideNote}
                              onChange={(e) => setOverrideNote(e.target.value)}
                            />
                          </label>
                          <div className="cn2b-actions">
                            <button
                              type="button"
                              className="cn2b-btn cn2b-btn--primary"
                              disabled={busy || overrideReason.trim() === ''}
                              onClick={() => void submitOverride()}
                            >
                              {t('cn2b_override_save', lang)}
                            </button>
                            <button type="button" className="cn2b-btn" disabled={busy} onClick={closeOverride}>
                              {t('cn2b_cancel', lang)}
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="cn2b-provenance">
                        {typeof provenance.sheetName === 'string' ? provenance.sheetName : '—'}
                        {coordinate?.a1 ? ` · ${coordinate.a1}` : ''}
                      </span>
                    </td>
                    {index === 0 && (
                      <td rowSpan={group.fields.length}>
                        {decision ? (
                          <span className="cn2b-decision" data-decision={decision.decision}>
                            {t(`cn2b_decision_${decision.decision}`, lang)}
                            {decision.decisionReason && <em className="cn2b-decision__reason">{decision.decisionReason}</em>}
                          </span>
                        ) : (
                          <span className="cn2b-decision" data-decision="none">{t('cn2b_decision_none', lang)}</span>
                        )}
                        {canEdit && (
                          <div className="cn2b-decision__actions">
                            <button
                              type="button"
                              className="cn2b-btn cn2b-btn--sm"
                              disabled={busy || itemQuery.trim() === ''}
                              onClick={() => void applyOne(group.targetEntity, 'mapped', itemQuery.trim())}
                            >
                              {t('cn2b_decide_map', lang)}
                            </button>
                            <button
                              type="button"
                              className="cn2b-btn cn2b-btn--sm"
                              disabled={busy || bulkReason.trim() === ''}
                              onClick={() => void applyOne(group.targetEntity, 'not_applicable', undefined, bulkReason.trim())}
                            >
                              {t('cn2b_decide_na', lang)}
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
