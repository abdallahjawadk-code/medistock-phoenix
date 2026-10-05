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
 * institutions to materials — an exact name match is offered as a
 * suggestion, never persisted without an explicit [صحيح] confirmation, and
 * a row with no exact match simply has no suggestion (matches current
 * Advanced Mode behavior, which never suggests a material at all).
 *
 * PRE3-A — ONE RESOLVER, TWO SEPARATE ACTS. `searchCentralItems` is now the
 * shared material resolver: ACTIVE registered catalog items only, matched by
 * scientific, Arabic/alternate and trade name or national code, raw and
 * Arabic-normalized. A suggestion is offered only when exactly ONE candidate
 * carries the row's text as one of its names; two or more ask the person to
 * choose. In the picker, choosing a result only STAGES it beside its
 * discriminators; nothing is written until the separate confirmation. A search
 * that finds nothing says so honestly ("material not registered") and leaves
 * the row undecided — this card can never create a material, register one,
 * or turn the typed text into one. A search that FAILED says so, and is never
 * shown as "not registered".
 *
 * PRE3 RUN 4 — "EXACTLY ONE" MUST BE PROVEN, NOT GLIMPSED. The suggestion is no
 * longer read off a capped, alphabetical search window (a second exact item past
 * the cut was invisible there). It comes from `findExactCentralItemMatches`: the
 * shared resolver's exact-candidate mode, which returns every active item that
 * could carry the row's text exactly AND says whether that set is proven
 * complete. One suggestion only when the set is complete and holds exactly one
 * item; two or more are a choice; incomplete, failed or stale is NO suggestion
 * (and the card says it could not confirm one). It still writes nothing until
 * the person presses [Correct]. The picker shows at most its window and says
 * when more registered materials match than it shows.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  CentralNeedsError,
  centralItemDiscriminators,
  centralItemExactlyNames,
  centralItemQueryIsSearchable,
  findExactCentralItemMatches,
  searchCentralItems,
  setRecordDisposition,
  type CentralItemOption,
  type SourceRecord,
} from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';

const UNIT_HEADER_RE = /^(unit|units|uom|الوحدة|وحدة|وحده|الوحده)$/i;

/** How many registered materials the picker lists; it asks for one more, only to know when there are more. */
const PICKER_LIMIT = 25;

/**
 * The proven-uniqueness check behind a suggestion, attributed to the exact
 * text it was asked about. `complete` is the server's proof that `matches`
 * holds EVERY active item carrying that text exactly; `failed` is a check that
 * could not run. Neither an unproven nor a failed check ever yields a suggestion.
 */
interface ExactCheck {
  seed: string;
  matches: CentralItemOption[];
  complete: boolean;
  failed: boolean;
}

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

/**
 * Exact name matches only — the same discipline `exactMatchSuggestion` uses for
 * institutions. More than one exact match is not a suggestion: it is a choice.
 */
function exactCentralItemMatches(candidates: CentralItemOption[], evidenceText: string): CentralItemOption[] {
  if (evidenceText.trim() === '') return [];
  return candidates.filter((c) => centralItemExactlyNames(c, evidenceText));
}

/** PRE3-A — what tells two registered materials apart, beside the scientific name and unit. */
function MaterialFacts({ lang, item }: { lang: 'ar' | 'en'; item: CentralItemOption }) {
  const facts = centralItemDiscriminators(item);
  if (facts.length === 0) return null;
  return (
    <span className="cn2b-simple-option__meta" data-testid="cn2b-simple-material-facts">
      {facts.map((fact, index) => (
        <span key={fact.labelKey}>
          {index > 0 && ' · '}
          {t(fact.labelKey, lang)}: <bdi>{fact.value}</bdi>
        </span>
      ))}
    </span>
  );
}

type MaterialSearchPhase = 'idle' | 'too_short' | 'searching' | 'done' | 'failed';

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
  /**
   * CN-UI-S1 — this card's presentation activity, in the SAME shape the
   * Advanced disposition table reports (`busy` = its write is in flight,
   * `dirty` = local work not yet sent, `failed` = its last write was refused).
   * The screen feeds it into the Work Session guard, so a session switch waits
   * for an in-flight decision and asks before local work is dropped.
   * CN-UI-S1 HC1 — "local work" is any of: the material picker open, a typed
   * search, the "not a material" reason surface open, a typed reason. None of
   * these is persisted, and none needs a business write to count. Reported,
   * never decided here; it changes no write.
   */
  onActivityChange?: (activity: { busy: boolean; dirty: boolean; failed: boolean }) => void;
}

const IDLE_ACTIVITY = { busy: false, dirty: false, failed: false } as const;

/**
 * CN-UI-S1 HC1 — the FROZEN dirty contract of this card: has the person done
 * local work a Work Session switch must not drop silently? Opening the picker,
 * typing a search, opening the "not a material" reason surface and typing a
 * reason are each meaningful — none of them waits for a persisted write to
 * count. Pure and exported so the exact contract is pinned directly (each term
 * alone), independently of which UI paths can reach it.
 */
export function materialCardHasLocalWork(state: {
  picking: boolean;
  query: string;
  showNotApplicable: boolean;
  notApplicableReason: string;
}): boolean {
  return state.picking
    || state.query.trim() !== ''
    || state.showNotApplicable
    || state.notApplicableReason.trim() !== '';
}

export function SimpleMaterialCard({ lang, importSessionId, editable, targetEntity, fields, onResolved, onRefused, onActivityChange }: Props) {
  const [query, setQuery] = useState('');
  /** The proven-uniqueness check of the row's own text — the only source of a suggestion. */
  const [exactCheck, setExactCheck] = useState<ExactCheck | null>(null);
  /** Newest-request-wins for that check: a reply for an older row text is dropped. */
  const exactSeq = useRef(0);
  /** The picker's own search, kept apart from the seed so neither overwrites the other. */
  const [results, setResults] = useState<CentralItemOption[]>([]);
  /** The picker's server reply held more registered materials than it lists. */
  const [resultsCapped, setResultsCapped] = useState(false);
  const [searchPhase, setSearchPhase] = useState<MaterialSearchPhase>('idle');
  const [searchError, setSearchError] = useState<CentralNeedsError | string | null>(null);
  /** A result the person chose in the picker. Staged only: nothing is written until it is confirmed. */
  const [pending, setPending] = useState<CentralItemOption | null>(null);
  /** Newest-request-wins for the picker search. */
  const searchSeq = useRef(0);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notApplicableReason, setNotApplicableReason] = useState('');
  const [showNotApplicable, setShowNotApplicable] = useState(false);

  // Every one of those has a way back to clean (Cancel resets its own state),
  // so dirty clears when the work does.
  const dirty = materialCardHasLocalWork({ picking, query, showNotApplicable, notApplicableReason });
  useEffect(() => {
    onActivityChange?.({ busy, dirty, failed: error !== null });
  }, [busy, dirty, error, onActivityChange]);
  // The queue replaces this card once its decision is re-read, and a session
  // switch unmounts it: its last report must not outlive it (a stale `busy`
  // would hold the Work Session switch closed).
  useEffect(() => () => onActivityChange?.(IDLE_ACTIVITY), [onActivityChange]);

  const evidence = useMemo(() => evidenceFields(fields), [fields]);
  const sourceUnitText = useMemo(() => sourceUnitOf(fields), [fields]);
  const longestEvidenceText = useMemo(
    () => evidence.reduce((longest, f) => (f.text.length > longest.length ? f.text : longest), ''),
    [evidence],
  );

  // The row's own longest text is checked for a PROVEN single exact match —
  // purely to save typing; the reviewer can always choose something else.
  // Nothing is persisted from this check. Only the newest check counts, and
  // only for the text it was asked about. A check that fails or cannot prove
  // completeness offers no suggestion; the person still chooses explicitly,
  // and the picker reports its own failures.
  useEffect(() => {
    const seq = (exactSeq.current += 1);
    const seed = longestEvidenceText.trim();
    setExactCheck(null);
    if (!centralItemQueryIsSearchable(seed)) return undefined;
    Promise.resolve()
      .then(() => findExactCentralItemMatches(seed))
      .then(
        (found) => {
          if (seq !== exactSeq.current) return;
          setExactCheck({ seed, matches: found.matches, complete: found.complete === true, failed: false });
        },
        () => {
          if (seq !== exactSeq.current) return;
          setExactCheck({ seed, matches: [], complete: false, failed: true });
        },
      );
    return undefined;
  }, [targetEntity, longestEvidenceText]);

  /** The check that answers THIS row's current text, or nothing. */
  const currentCheck = exactCheck !== null && exactCheck.seed === longestEvidenceText.trim() ? exactCheck : null;
  const exactMatches = useMemo(
    () => exactCentralItemMatches(currentCheck?.matches ?? [], longestEvidenceText),
    [currentCheck, longestEvidenceText],
  );
  // ONE suggestion only when the server proved the exact set complete and it
  // holds exactly one item. Never from a window, a grade or a partial set.
  const suggestion = currentCheck !== null && currentCheck.complete && exactMatches.length === 1 ? exactMatches[0] : null;
  // Checked, but a single match could not be confirmed (failed, or not proven
  // complete) — said plainly, so "no suggestion" is never read as "no match".
  const suggestionUnconfirmed = currentCheck !== null
    && (currentCheck.failed || !currentCheck.complete)
    && exactMatches.length <= 1;

  useEffect(() => {
    const seq = (searchSeq.current += 1);
    if (!picking) {
      setResults([]);
      setResultsCapped(false);
      setSearchPhase('idle');
      setSearchError(null);
      setPending(null);
      return undefined;
    }
    const term = query.trim();
    if (!centralItemQueryIsSearchable(term)) {
      setResults([]);
      setResultsCapped(false);
      setSearchPhase('too_short');
      setSearchError(null);
      return undefined;
    }
    setSearchPhase('searching');
    setSearchError(null);
    const handle = setTimeout(() => {
      searchCentralItems(term, PICKER_LIMIT + 1).then(
        (rows) => {
          if (seq !== searchSeq.current) return;
          setResults(rows.slice(0, PICKER_LIMIT));
          setResultsCapped(rows.length > PICKER_LIMIT);
          setSearchPhase('done');
        },
        (e: unknown) => {
          if (seq !== searchSeq.current) return;
          setResults([]);
          setResultsCapped(false);
          setSearchError(e instanceof CentralNeedsError ? e : 'unknown_error');
          setSearchPhase('failed');
        },
      );
    }, 150);
    return () => clearTimeout(handle);
  }, [picking, query]);

  async function mapTo(item: CentralItemOption) {
    // Defence in depth: no code path reaches the RPC without `editable`, and
    // `mapped` always names a real registered item — never typed text.
    if (!editable) return;
    if (item.id.trim() === '') return;
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
            <MaterialFacts lang={lang} item={suggestion} />
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
        <>
          {exactMatches.length > 1 && (
            <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-material-multiple-matches">
              {t('cn2b_simple_material_multiple_matches', lang)}
            </p>
          )}
          {suggestionUnconfirmed && (
            <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-material-suggestion-unconfirmed">
              {t('cn2b_simple_material_suggestion_unconfirmed', lang)}
            </p>
          )}
          <div className="cn2b-simple-card__actions">
            <PhoenixButton type="button" variant="primary" size="lg" disabled={busy} onClick={() => { setPicking(true); setQuery(''); }}>
              {t('cn2b_simple_choose_material', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setShowNotApplicable(true)}>
              {t('cn2b_simple_not_a_material', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {editable && picking && (
        <div className="cn2b-simple-card__picker" data-testid="cn2b-simple-material-picker">
          <input
            type="search"
            className="cn2b-simple-input"
            aria-label={t('cn2b_simple_search_material', lang)}
            placeholder={t('cn2b_simple_search_material', lang)}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPending(null); }}
          />
          {/* Where the search stands. "Keep typing", "searching", "failed" and
              "not registered" are four different facts and are never merged. */}
          <p className="cn2b-simple-card__hint" role="status" data-testid="cn2b-simple-material-search-state" data-phase={searchPhase}>
            {searchPhase === 'too_short' && t('cn2b_material_search_min', lang)}
            {searchPhase === 'searching' && t('cn2b_material_searching', lang)}
            {searchPhase === 'done' && results.length > 0 && `${t('cn2b_material_search_results', lang)}: ${results.length}`}
          </p>
          {searchPhase === 'done' && resultsCapped && (
            <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-material-search-capped">
              {t('cn2b_material_search_capped', lang)}
            </p>
          )}
          {searchPhase === 'failed' && (
            <div className="cn2b-simple-error" role="alert" data-testid="cn2b-simple-material-search-failed">
              <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {t('cn2b_material_search_failed', lang)}
              {searchError !== null && <> {centralNeedsErrorText(searchError, lang)}</>}
            </div>
          )}
          {searchPhase === 'done' && results.length === 0 && (
            <div className="cn2b-simple-card__empty" data-testid="cn2b-simple-material-not-registered">
              <strong>{t('cn2b_material_not_registered', lang)}</strong>
              <p className="cn2b-simple-card__hint">{t('cn2b_material_not_registered_note', lang)}</p>
            </div>
          )}
          {pending ? (
            <div className="cn2b-simple-match" data-testid="cn2b-simple-material-pending">
              <p className="cn2b-simple-match__label">{t('cn2b_simple_material_confirm_title', lang)}</p>
              <p className="cn2b-simple-match__name"><bdi>{pending.name}</bdi></p>
              <p className="cn2b-simple-card__hint">
                {t('cn2b_simple_catalog_unit_label', lang)}: <bdi>{pending.unit}</bdi>
              </p>
              <MaterialFacts lang={lang} item={pending} />
              <div className="cn2b-simple-card__actions">
                <PhoenixButton type="button" variant="primary" disabled={busy} onClick={() => void mapTo(pending)}>
                  {t('cn2b_simple_material_confirm', lang)}
                </PhoenixButton>
                <PhoenixButton type="button" variant="secondary" disabled={busy} onClick={() => setPending(null)}>
                  {t('cn2b_simple_material_choose_different', lang)}
                </PhoenixButton>
              </div>
            </div>
          ) : results.length > 0 && (
            <ul className="cn2b-simple-card__picker-list">
              {results.map((c) => (
                <li key={c.id}>
                  {/* Choosing STAGES the item; the write waits for the confirmation above. */}
                  <PhoenixButton type="button" variant="ghost" className="cn2b-simple-option" disabled={busy} onClick={() => setPending(c)}>
                    <bdi>{c.name}</bdi> <span className="cn2b-simple-option__meta">(<bdi>{c.unit}</bdi>)</span>{' '}
                    <MaterialFacts lang={lang} item={c} />
                  </PhoenixButton>
                </li>
              ))}
            </ul>
          )}
          <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => { setPicking(false); setQuery(''); }}>
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
