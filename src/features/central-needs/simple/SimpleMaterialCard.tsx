/**
 * Annual Needs — Simple Mode material + unit card (spec sections 13-14).
 *
 * A THIN wrapper around the existing, unchanged `setRecordDisposition` RPC
 * and `searchCentralItems` read — the same canonical disposition write
 * `CentralNeedsDispositionTable` already uses. This card adds no second
 * material-mapping system and no automatic persisted decision.
 *
 * EVIDENCE, NOT A GUESSED "MATERIAL NAME": `CentralNeedsDispositionTable`'s
 * own header note says it plainly — "it never pre-selects, guesses or infers
 * [a mapping] from the shape of the row... a subtotal line and a medicine
 * line look identical to it, which is the honest state of the evidence." A
 * `targetEntity` (one imported row) can carry many text/number fields, and
 * the CORPUS-CONTRACT.md fresh audit of the real archive proved the parser's
 * single-header-row assumption frequently cannot recover which field is
 * "the item name" or "the unit" for a large share of this corpus's sheets.
 * This card therefore shows every non-empty field of the row as evidence,
 * exactly as Advanced Mode does, rather than fabricating a single label.
 *
 * SOURCE UNIT (section 7.2/18/19/20): a source unit is shown ONLY when this
 * row carries a field whose header text is an exact "unit"-like match
 * (never inferred from the material description, never defaulted from the
 * canonical item). C3 re-measured why the match must stay EXACT: in the real
 * corpus, 19 columns are headed `وحدة المناعة` / `وحدة الهرمونات` — laboratory
 * DEPARTMENTS, not units of measure. A "contains وحدة" rule would have read
 * them as units, so containment matching is deliberately refused here. CORPUS-CONTRACT.md documents that, as currently exposed
 * by the frozen parser contract, this corpus has no sheet where that
 * condition is met — so `sourceUnitText` is `null` and the card fails
 * closed to "needs unit review" for effectively every record, matching
 * section 13's own fallback branch. This is a measured fact about the real
 * corpus, not a shortcut taken here.
 *
 * MATERIAL SUGGESTION: the existing canonical-item search has never done
 * fuzzy or automatic matching. This card extends the SAME "exact match,
 * never fuzzy" discipline `exactMatchSuggestion` already uses for
 * institutions to materials — an exact (trimmed) name match is offered as a
 * suggestion, never persisted without an explicit [صحيح] confirmation, and
 * a row with no exact match simply has no suggestion (matches current
 * Advanced Mode behavior, which never suggests a material at all).
 */
import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  CentralNeedsError,
  searchCentralItems,
  setRecordDisposition,
  type CentralItemOption,
  type SourceRecord,
} from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';

const UNIT_HEADER_RE = /^(unit|units|uom|الوحدة|وحدة|وحده|الوحده)$/i;

/** The row's own unit field, ONLY when a field header is an exact unit-word match. Never guessed. */
function sourceUnitOf(fields: SourceRecord[]): string | null {
  for (const f of fields) {
    if (!UNIT_HEADER_RE.test(f.fieldName.trim())) continue;
    const v = (f.sourceValues as { value?: unknown }).value;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Every field of the row worth showing as evidence — blanks excluded, order preserved. */
function evidenceFields(fields: SourceRecord[]): Array<{ fieldName: string; text: string }> {
  return fields
    .map((f) => {
      const v = (f.sourceValues as { value?: unknown }).value;
      const text = v === null || v === undefined ? '' : String(v);
      return { fieldName: f.fieldName, text };
    })
    .filter((f) => f.text.trim() !== '');
}

/** Exact (trimmed) name match only — the same discipline `exactMatchSuggestion` uses for institutions. */
function exactCentralItemMatch(candidates: CentralItemOption[], evidenceText: string): CentralItemOption | null {
  const trimmed = evidenceText.trim();
  if (trimmed === '') return null;
  const hit = candidates.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
  return hit ?? null;
}

interface Props {
  lang: 'ar' | 'en';
  importSessionId: string;
  /**
   * `canEdit && isDraft`, the same gate Advanced Mode's own panels apply.
   * When false this card renders the row's evidence read-only and offers no
   * control that could reach `setRecordDisposition`.
   */
  editable: boolean;
  targetEntity: string;
  /** Every SourceRecord sharing this targetEntity — the whole imported row. */
  fields: SourceRecord[];
  onResolved: () => void;
  /**
   * C5 §17 (UI-F3) — a server refusal of this card's write. The screen re-reads
   * the registry and the revision when it means the revision's lifecycle moved
   * (e.g. `plan_revision_not_editable`) or the outcome is unknown; nothing is
   * retried.
   */
  onRefused?: (refusal: CentralNeedsError) => void;
}

export function SimpleMaterialCard({ lang, importSessionId, editable, targetEntity, fields, onResolved, onRefused }: Props) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<CentralItemOption[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notApplicableReason, setNotApplicableReason] = useState('');
  const [showNotApplicable, setShowNotApplicable] = useState(false);

  const evidence = useMemo(() => evidenceFields(fields), [fields]);
  const sourceUnitText = useMemo(() => sourceUnitOf(fields), [fields]);
  const longestEvidenceText = useMemo(
    () => evidence.reduce((longest, f) => (f.text.length > longest.length ? f.text : longest), ''),
    [evidence],
  );

  // A one-shot search seeded from the row's own longest text field, purely
  // to save typing — the reviewer can freely change it. Nothing here is
  // persisted from this search alone.
  useEffect(() => {
    let alive = true;
    const seed = longestEvidenceText.trim();
    if (seed === '') { setCandidates([]); return; }
    searchCentralItems(seed, 10)
      .then((rows) => { if (alive) setCandidates(rows); })
      .catch(() => { if (alive) setCandidates([]); });
    return () => { alive = false; };
  }, [targetEntity, longestEvidenceText]);

  const suggestion = useMemo(
    () => exactCentralItemMatch(candidates, longestEvidenceText),
    [candidates, longestEvidenceText],
  );

  useEffect(() => {
    if (!picking) { setCandidates((prev) => prev); return; }
    let alive = true;
    const handle = setTimeout(() => {
      searchCentralItems(query.trim(), 25)
        .then((rows) => { if (alive) setCandidates(rows); })
        .catch(() => { if (alive) setCandidates([]); });
    }, 150);
    return () => { alive = false; clearTimeout(handle); };
  }, [picking, query]);

  async function mapTo(item: CentralItemOption) {
    // Defence in depth: no code path reaches the RPC without `editable`.
    if (!editable) return;
    setBusy(true);
    setError(null);
    try {
      await setRecordDisposition({
        importSessionId,
        targetEntity,
        decision: 'mapped',
        centralItemId: item.id,
      });
      onResolved();
    } catch (e) {
      setError(centralNeedsErrorText(e instanceof CentralNeedsError ? e : (e as { code?: string }).code ?? 'unknown_error', lang));
      if (e instanceof CentralNeedsError) onRefused?.(e);
    } finally {
      setBusy(false);
    }
  }

  async function markNotApplicable() {
    if (!editable) return;
    if (notApplicableReason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await setRecordDisposition({
        importSessionId,
        targetEntity,
        decision: 'not_applicable',
        decisionReason: notApplicableReason.trim(),
      });
      onResolved();
    } catch (e) {
      setError(centralNeedsErrorText(e instanceof CentralNeedsError ? e : (e as { code?: string }).code ?? 'unknown_error', lang));
      if (e instanceof CentralNeedsError) onRefused?.(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cn2b-simple-card cn2b-simple-card--review" data-testid="cn2b-simple-material-card" aria-label={t('cn2b_simple_reviewing_materials', lang)}>
      <div className="cn2b-simple-evidence">
        <p className="cn2b-simple-card__eyebrow">
          <PhoenixIcon name="file" size={14} inline aria-hidden="true" /> {t('cn2b_simple_found_in_file', lang)}
        </p>
        <dl className="cn2b-simple-evidence__list" data-testid="cn2b-simple-material-evidence">
          {evidence.map((f) => (
            <div key={f.fieldName} className="cn2b-simple-evidence__row">
              <dt className="cn2b-simple-evidence__field"><bdi>{f.fieldName}</bdi></dt>
              <dd className="cn2b-simple-evidence__value"><bdi>{f.text}</bdi></dd>
            </div>
          ))}
          {evidence.length === 0 && (
            <div className="cn2b-simple-evidence__row">
              <dd className="cn2b-simple-card__empty">{t('cn2b_simple_no_evidence', lang)}</dd>
            </div>
          )}
        </dl>
        <p className="cn2b-simple-unit" data-state={sourceUnitText ? 'known' : 'review'} data-testid="cn2b-simple-material-unit-row">
          <span className="cn2b-simple-unit__label">{t('cn2b_simple_source_unit_label', lang)}:</span>{' '}
          {sourceUnitText ?? (
            <span className="cn2b-simple-unit__warn" data-testid="cn2b-simple-unit-needs-review">
              <PhoenixIcon name="warning" size={14} inline aria-hidden="true" /> {t('cn2b_simple_unit_needs_review', lang)}
            </span>
          )}
        </p>
      </div>

      {error && (
        <div className="cn2b-simple-error" role="alert">
          <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {error}
        </div>
      )}

      {/* Read-only: the row's evidence and unit state stay visible, every control does not. */}
      {!editable && (
        <p className="cn2b-bc-readonly cn2b-simple-readonly" data-empty="read-only" data-testid="cn2b-simple-material-read-only">
          {t('cn2b_bc_read_only', lang)}
        </p>
      )}

      {editable && suggestion && !picking && !showNotApplicable && (
        <>
          <div className="cn2b-simple-match">
            <p className="cn2b-simple-match__label">{t('cn2b_simple_matching_material', lang)}</p>
            <p className="cn2b-simple-match__name" data-testid="cn2b-simple-material-suggestion"><bdi>{suggestion.name}</bdi></p>
            {/* C3: this is the CATALOG item's own unit — context for the person
                deciding, never an approved unit. Approval happens only when a
                human elects a unit on a need line, so the label says so. */}
            <p className="cn2b-simple-match__meta" data-testid="cn2b-simple-catalog-unit">
              {t('cn2b_simple_catalog_unit_label', lang)}: <bdi>{suggestion.unit}</bdi>
            </p>
          </div>
          <div className="cn2b-simple-card__actions">
            <PhoenixButton type="button" variant="primary" size="lg" disabled={busy} onClick={() => void mapTo(suggestion)}>
              {t('cn2b_simple_correct', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="secondary" disabled={busy} onClick={() => { setPicking(true); setQuery(''); }}>
              {t('cn2b_simple_choose_another_material', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setShowNotApplicable(true)}>
              {t('cn2b_simple_not_a_material', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {editable && !suggestion && !picking && !showNotApplicable && (
        <div className="cn2b-simple-card__actions">
          <PhoenixButton type="button" variant="primary" size="lg" disabled={busy} onClick={() => { setPicking(true); setQuery(''); }}>
            {t('cn2b_simple_choose_material', lang)}
          </PhoenixButton>
          <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setShowNotApplicable(true)}>
            {t('cn2b_simple_not_a_material', lang)}
          </PhoenixButton>
        </div>
      )}

      {editable && picking && (
        <div className="cn2b-simple-card__picker" data-testid="cn2b-simple-material-picker">
          <input
            type="search"
            className="cn2b-simple-input"
            aria-label={t('cn2b_simple_search_material', lang)}
            placeholder={t('cn2b_simple_search_material', lang)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="cn2b-simple-card__picker-list">
            {candidates.map((c) => (
              <li key={c.id}>
                <PhoenixButton type="button" variant="ghost" className="cn2b-simple-option" disabled={busy} onClick={() => void mapTo(c)}>
                  <bdi>{c.name}</bdi> <span className="cn2b-simple-option__meta">(<bdi>{c.unit}</bdi>)</span>
                </PhoenixButton>
              </li>
            ))}
            {candidates.length === 0 && <li className="cn2b-simple-card__empty">{t('cn2b_simple_no_results', lang)}</li>}
          </ul>
          <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setPicking(false)}>
            {t('cn2b_simple_cancel', lang)}
          </PhoenixButton>
        </div>
      )}

      {editable && showNotApplicable && (
        <div className="cn2b-simple-card__reason" data-testid="cn2b-simple-material-not-applicable-reason">
          <p className="cn2b-simple-card__hint">{t('cn2b_simple_not_a_material_reason_hint', lang)}</p>
          <input
            type="text"
            className="cn2b-simple-input"
            aria-label={t('cn2b_beneficiary_column_reason_required', lang)}
            placeholder={t('cn2b_beneficiary_column_reason_required', lang)}
            value={notApplicableReason}
            onChange={(e) => setNotApplicableReason(e.target.value)}
          />
          <div className="cn2b-simple-card__actions">
            <PhoenixButton
              type="button" variant="danger" disabled={busy || notApplicableReason.trim() === ''}
              onClick={() => void markNotApplicable()}
            >
              {t('cn2b_simple_confirm_not_a_material', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => { setShowNotApplicable(false); setNotApplicableReason(''); }}>
              {t('cn2b_simple_cancel', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </section>
  );
}
