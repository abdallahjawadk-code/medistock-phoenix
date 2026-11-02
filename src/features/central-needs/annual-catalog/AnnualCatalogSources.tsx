import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { mt, type ManualKey, type ManualLang } from '../manual/manual-needs.i18n';
import { SOURCE_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualSourceOccurrence,
  type SourceIdentityField, type SourceIdentityObservation } from './annual-catalog.contract';
import type { AnnualCatalogOccurrencesPage } from './annual-catalog-server.contract';
import type { listAnnualCatalogOccurrences } from './annual-catalog.service';

interface Props {
  lang: ManualLang;
  contextKey: string;
  scope: AnnualCatalogScope;
  annualItemId: string;
  reader: typeof listAnnualCatalogOccurrences;
}

type ReadFailure = 'initial' | 'reload' | 'more';
interface ReadState {
  rows: AnnualSourceOccurrence[];
  cursor: string | null;
  loaded: boolean;
  busy: boolean;
  failure: ReadFailure | null;
}

const FIELD_LABELS: Record<SourceIdentityField, ManualKey> = {
  scientificName: 'annualScientificName', nameAr: 'annualArabicName', nationalCode: 'annualNationalCode',
  currentNationalCode: 'annualCurrentNationalCode', previousNationalCode: 'annualPreviousNationalCode',
  barcode: 'annualBarcode', dosageForm: 'annualDosageForm', concentration: 'annualConcentration', unit: 'unit',
};
const REASON_LABELS: Record<Exclude<SourceIdentityObservation, { state: 'value' }>['reason'], ManualKey> = {
  unmapped: 'annualSourceUnmapped', missing_cell: 'annualSourceMissingCell', blank: 'annualSourceBlank',
  empty_text: 'annualSourceEmptyText', formula: 'annualSourceFormulaInvalid', non_text: 'annualSourceNonText',
  text_too_long: 'annualSourceTooLong', control_text: 'annualSourceControlText',
};
const FAILURE_LABELS: Record<ReadFailure, ManualKey> = {
  initial: 'annualSourcesFailed', reload: 'annualSourcesReloadFailed', more: 'annualSourcesMoreFailed',
};

function SourceWitness({ observation, lang }: { observation: SourceIdentityObservation; lang: ManualLang }) {
  const witness = observation.witness;
  if (!witness) return <span>{mt('annualSourceUnmapped', lang)}</span>;
  return <details className="prism-annual-source-witness">
    <summary><bdi dir="ltr">{witness.cell.coordinate.a1}</bdi></summary>
    <dl>
      <div><dt>{mt('annualSourceHeader', lang)}</dt><dd><bdi dir="ltr">{witness.header.coordinate.a1}</bdi> · <bdi>{String(witness.header.rawValue)}</bdi></dd></div>
      <div><dt>{mt('annualSourceRawValue', lang)}</dt><dd><code dir="auto">{JSON.stringify(witness.cell.rawValue)}</code></dd></div>
      {witness.cell.isFormula && <div><dt>{mt('annualSourceFormula', lang)}</dt><dd><code dir="ltr">{witness.cell.formula ?? '—'}</code></dd></div>}
    </dl>
  </details>;
}

export function SourceRecord({ occurrence, lang }: { occurrence: AnnualSourceOccurrence; lang: ManualLang }) {
  const { source, classification } = occurrence;
  return <li><details className="prism-annual-source-record">
    <summary>
      <bdi className="prism-annual-source-file" dir="auto">{source.filename}</bdi>
      <span className="prism-search-hint">{mt('annualSourceSheet', lang)} <bdi>{source.sheetName}</bdi> · {mt('annualSourceRow', lang)} <bdi dir="ltr">{source.row + 1}</bdi></span>
    </summary>
    <p className="prism-search-hint">{classification
      ? <>{mt(classification.origin === 'source' ? 'annualSourceClassification' : 'annualSourceProposedClassification', lang)}: <bdi>{classification.label}</bdi></>
      : mt('annualSourceNoClassification', lang)}</p>
    <div className="prism-table-scroll prism-annual-source-fields" role="region" aria-label={`${mt('annualSourceFields', lang)}: ${source.filename}`} tabIndex={0}>
      <table><thead><tr><th scope="col">{mt('annualField', lang)}</th><th scope="col">{mt('annualSourceValue', lang)}</th><th scope="col">{mt('annualSourceCell', lang)}</th></tr></thead>
        <tbody>{SOURCE_IDENTITY_FIELDS.map((field) => {
          const observation = occurrence.fields[field];
          return <tr key={field}>
            <th scope="row">{mt(FIELD_LABELS[field], lang)}</th>
            <td>{observation.state === 'value' ? <bdi dir="auto">{observation.text}</bdi>
              : <span className="prism-search-hint">{mt(REASON_LABELS[observation.reason], lang)}</span>}</td>
            <td><SourceWitness observation={observation} lang={lang} /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <details className="prism-annual-source-metadata">
      <summary>{mt('annualSourceRecordDetails', lang)}</summary>
      <dl>
        <div><dt>{mt('annualSourceFingerprint', lang)}</dt><dd><code dir="ltr">{source.sha256}</code></dd></div>
        <div><dt>{mt('annualSourceMapping', lang)}</dt><dd><bdi>{source.mappingReference}</bdi></dd></div>
        <div><dt>{mt('annualSourceBlock', lang)}</dt><dd><bdi>{source.blockId}</bdi></dd></div>
        {classification && <div><dt>{mt('annualSourceClassificationReference', lang)}</dt><dd><bdi>{classification.reference}</bdi></dd></div>}
        <div><dt>{mt('annualSourceParser', lang)}</dt><dd><bdi dir="ltr">{source.parser.contractVersion} · SheetJS {source.parser.sheetjsVersion} · {source.parser.runtime}</bdi></dd></div>
        <div><dt>{mt('annualSourceParserFingerprint', lang)}</dt><dd><code dir="ltr">{source.parser.sheetjsTarballSha256}</code></dd></div>
      </dl>
    </details>
  </details></li>;
}

/** Read-only source witnesses. The existing service validates every page and its scope. */
function ScopedSources({ lang, scope, annualItemId, reader }: Props) {
  const [state, setState] = useState<ReadState>({ rows: [], cursor: null, loaded: false, busy: true, failure: null });
  const stateRef = useRef(state); stateRef.current = state;
  const request = useRef(0);
  const active = useRef(false);
  const pending = useRef(false);
  const titleId = useId();
  const ownerOrgId = scope.ownerOrgId;
  const planningYear = scope.planningYear;

  const load = useCallback(async (more = false) => {
    if (pending.current || !active.current) return;
    const before = stateRef.current;
    if (more && (!before.loaded || before.cursor === null || before.failure === 'reload')) return;
    const mine = ++request.current;
    const current = () => active.current && request.current === mine;
    pending.current = true;
    setState((old) => ({ ...old, busy: true, failure: null }));
    try {
      const page: AnnualCatalogOccurrencesPage = await reader({ ownerOrgId, planningYear }, annualItemId, 25, more ? before.cursor : null);
      if (!current()) return;
      setState((old) => {
        const rows = new Map((more ? old.rows : []).map((row) => [row.occurrenceKey, row]));
        page.occurrences.forEach((row) => rows.set(row.occurrenceKey, row));
        return { rows: [...rows.values()], cursor: page.nextAfterOccurrenceId, loaded: true, busy: false, failure: null };
      });
    } catch {
      if (current()) setState((old) => ({ ...old, busy: false, failure: more ? 'more' : old.loaded ? 'reload' : 'initial' }));
    } finally {
      if (current()) pending.current = false;
    }
  }, [reader, ownerOrgId, planningYear, annualItemId]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; request.current += 1; pending.current = false; };
  }, [load]);

  return <section className="prism-annual-sources" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby={titleId} aria-busy={state.busy}>
    <div className="prism-annual-editor__header">
      <h4 id={titleId}>{mt('annualSourcesTitle', lang)}</h4>
      {state.loaded && <button type="button" disabled={state.busy} onClick={() => void load()}>{mt('annualSourcesReload', lang)}</button>}
    </div>
    <p role="note" className="prism-notice prism-notice--warning">{mt('annualSourcesTrust', lang)}</p>
    {state.busy && <p role="status" className="prism-loading">{mt('annualSourcesLoading', lang)}</p>}
    {state.failure && <div className="prism-notice prism-notice--error">
      <p role="alert">{mt(FAILURE_LABELS[state.failure], lang)}</p>
      <button type="button" disabled={state.busy} onClick={() => void load(state.failure === 'more')}>{mt(state.failure === 'more' ? 'annualSourcesRetryMore' : 'annualSourcesRetry', lang)}</button>
    </div>}
    {state.loaded && <p className="prism-search-hint">{mt('annualSourcesShown', lang)} <bdi dir="ltr">{state.rows.length}</bdi>
      {!state.busy && !state.failure && state.cursor === null && state.rows.length > 0 && <> · {mt('annualSourcesComplete', lang)}</>}
    </p>}
    {state.loaded && !state.busy && !state.failure && state.rows.length === 0 && <p>{mt('annualSourcesEmpty', lang)}</p>}
    <ol>{state.rows.map((occurrence) => <SourceRecord key={occurrence.occurrenceKey} occurrence={occurrence} lang={lang} />)}</ol>
    {state.cursor !== null && state.failure === null && <button type="button" disabled={state.busy} onClick={() => void load(true)}>{mt('annualSourcesMore', lang)}</button>}
  </section>;
}

export function AnnualCatalogSources(props: Props) {
  // A new actor/owner/year/item cannot paint even one frame of the previous source rows.
  const key = `${props.contextKey}:${props.scope.ownerOrgId}:${props.scope.planningYear}:${props.annualItemId}`;
  return <ScopedSources key={key} {...props} />;
}
