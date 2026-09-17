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
 * canonical item). CORPUS-CONTRACT.md documents that, as currently exposed
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
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import {
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
}

export function SimpleMaterialCard({ lang, importSessionId, editable, targetEntity, fields, onResolved }: Props) {
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
      setError(centralNeedsErrorText((e as { code?: string }).code ?? 'unknown_error', lang));
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
      setError(centralNeedsErrorText((e as { code?: string }).code ?? 'unknown_error', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard className="cn2b-simple-card" data-testid="cn2b-simple-material-card">
      <p className="cn2b-simple-card__eyebrow">{t('cn2b_simple_found_in_file', lang)}</p>
      <ul className="cn2b-simple-card__evidence-list" data-testid="cn2b-simple-material-evidence">
        {evidence.map((f) => (
          <li key={f.fieldName}>
            <span className="cn2b-simple-card__evidence-field">{f.fieldName}</span>
            <span className="cn2b-simple-card__evidence-value">{f.text}</span>
          </li>
        ))}
        {evidence.length === 0 && <li className="cn2b-simple-card__empty">{t('cn2b_simple_no_evidence', lang)}</li>}
      </ul>

      <p className="cn2b-simple-card__label" data-testid="cn2b-simple-material-unit-row">
        {t('cn2b_simple_source_unit_label', lang)}:{' '}
        {sourceUnitText ?? (
          <span className="cn2b-simple-card__warn" data-testid="cn2b-simple-unit-needs-review">
            {t('cn2b_simple_unit_needs_review', lang)}
          </span>
        )}
      </p>

      {error && <div className="cn2b-simple-card__error" role="alert">{error}</div>}

      {/* Read-only: the row's evidence and unit state stay visible, every control does not. */}
      {!editable && (
        <p className="cn2b-bc-readonly" data-empty="read-only" data-testid="cn2b-simple-material-read-only">
          {t('cn2b_bc_read_only', lang)}
        </p>
      )}

      {editable && suggestion && !picking && !showNotApplicable && (
        <>
          <p className="cn2b-simple-card__label">{t('cn2b_simple_matching_material', lang)}</p>
          <p className="cn2b-simple-card__match" data-testid="cn2b-simple-material-suggestion">{suggestion.name}</p>
          <p className="cn2b-simple-card__hint">
            {t('cn2b_simple_approved_unit_label', lang)}: {suggestion.unit}
          </p>
          <div className="cn2b-simple-card__actions">
            <PhoenixButton type="button" variant="primary" disabled={busy} onClick={() => void mapTo(suggestion)}>
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
          <PhoenixButton type="button" variant="primary" disabled={busy} onClick={() => { setPicking(true); setQuery(''); }}>
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
                <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => void mapTo(c)}>
                  {c.name} <span className="cn2b-simple-card__hint">({c.unit})</span>
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
    </PhoenixCard>
  );
}
