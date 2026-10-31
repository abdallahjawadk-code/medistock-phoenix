import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { mt, manualUnitText, type ManualKey, type ManualLang } from '../manual/manual-needs.i18n';
import { MATERIAL_UNITS } from '../manual/material-registration.service';
import { ANNUAL_IDENTITY_FIELDS, type AnnualIdentityField } from './annual-catalog.contract';
import type { AnnualCanonicalPreview, AnnualCatalogItemResult } from './annual-catalog-server.contract';
import { editableAnnualFields, type AnnualCatalogChange, type AnnualEditableFields } from './annual-needs.contract';

export interface AnnualEditorSubmission {
  expectedFieldVersionId: string;
  expectedCanonicalFingerprint: string;
  fields: AnnualEditableFields;
  reason: string;
}

interface Props {
  lang: ManualLang;
  contextKey: string;
  item: AnnualCatalogItemResult;
  changes: readonly AnnualCatalogChange[];
  sourcePanel?: ReactNode;
  canEdit: boolean;
  busy?: boolean;
  outcomeUnknown?: boolean;
  notice?: string | null;
  errorText?: string | null;
  historyBusy?: boolean;
  historyFailed?: boolean;
  hasMoreHistory?: boolean;
  canonicalPreview?: AnnualCanonicalPreview | null;
  onSave: (input: AnnualEditorSubmission) => Promise<AnnualCatalogItemResult | null>;
  onLoadHistory?: (more: boolean) => void;
  onPreviewCanonical?: () => void;
  onRefreshCanonical?: (input: Omit<AnnualEditorSubmission, 'fields'>) => Promise<AnnualCatalogItemResult | null>;
  onRequestRegistration?: (fields: AnnualEditableFields) => void;
  onClose?: () => void;
  onReloadCurrent?: () => void;
}

const FIELD_LABELS: Record<AnnualIdentityField, ManualKey> = {
  scientificName: 'annualScientificName', nameAr: 'annualArabicName', nationalCode: 'annualNationalCode', barcode: 'annualBarcode',
  dosageForm: 'annualDosageForm', concentration: 'annualConcentration', unit: 'unit',
};

function timestamp(value: string, lang: ManualLang): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-IQ' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad',
  }).format(new Date(value));
}

/** Form and attributed evidence only. The caller owns the command, idempotency key and authoritative refresh. */
export function AnnualCatalogEditor({ lang, contextKey, item, changes, canEdit, busy = false, outcomeUnknown = false,
  notice, errorText, historyBusy = false, historyFailed = false, hasMoreHistory = false, canonicalPreview, sourcePanel,
  onSave, onLoadHistory, onPreviewCanonical, onRefreshCanonical, onRequestRegistration, onClose, onReloadCurrent }: Props) {
  const [before, setBefore] = useState(() => editableAnnualFields(item.fieldVersion.fields));
  const [fields, setFields] = useState(() => editableAnnualFields(item.fieldVersion.fields));
  const [baseVersion, setBaseVersion] = useState(item.fieldVersion.fieldVersionId);
  const [baseFingerprint, setBaseFingerprint] = useState(item.canonicalFingerprint);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const epoch = useRef(0);
  const formId = useId();
  const token = `${item.scope.ownerOrgId}:${item.scope.planningYear}:${item.membership.annualItemId}:${contextKey}`;

  const resetTo = (current: AnnualCatalogItemResult) => {
    const values = editableAnnualFields(current.fieldVersion.fields);
    setBefore(values); setFields(values); setBaseVersion(current.fieldVersion.fieldVersionId);
    setBaseFingerprint(current.canonicalFingerprint); setReason(''); setFieldError(null);
  };

  useEffect(() => { epoch.current += 1; resetTo(item); setSubmitting(false); return () => { epoch.current += 1; }; }, [token]);

  const stale = item.fieldVersion.fieldVersionId !== baseVersion;
  const changed = ANNUAL_IDENTITY_FIELDS.some((field) => before[field] !== fields[field]);
  const locked = busy || submitting || outcomeUnknown;
  const currentChange = changes.find((change) => change.toFieldVersionId === item.fieldVersion.fieldVersionId);
  const legalReview = currentChange?.requiresLegalReview ?? [];
  const needsReview = legalReview.length > 0 || item.membership.status === 'preparing';
  const canonicalReady = !item.canonicalDrift || canonicalPreview !== null && canonicalPreview !== undefined;

  const save = async () => {
    if (!canEdit || busy || submitting || stale || !changed || !canonicalReady) return;
    if (!reason.trim()) { setFieldError(mt('reasonRequired', lang)); return; }
    const mine = epoch.current;
    setSubmitting(true); setFieldError(null);
    try {
      const saved = await onSave({ expectedFieldVersionId: baseVersion, expectedCanonicalFingerprint: canonicalPreview?.canonicalFingerprint ?? baseFingerprint, fields, reason });
      if (saved && epoch.current === mine) resetTo(saved);
    } catch { if (epoch.current === mine) setFieldError(mt('annualEditFailed', lang)); }
    finally { if (epoch.current === mine) setSubmitting(false); }
  };

  const refresh = async () => {
    if (!canEdit || !canonicalPreview || !onRefreshCanonical || busy || submitting || stale) return;
    if (!reason.trim()) { setFieldError(mt('reasonRequired', lang)); return; }
    const mine = epoch.current;
    setSubmitting(true); setFieldError(null);
    try {
      const saved = await onRefreshCanonical({ expectedFieldVersionId: baseVersion,
        expectedCanonicalFingerprint: canonicalPreview.canonicalFingerprint, reason });
      if (saved && epoch.current === mine) resetTo(saved);
    } catch { if (epoch.current === mine) setFieldError(mt('annualEditFailed', lang)); }
    finally { if (epoch.current === mine) setSubmitting(false); }
  };

  return <section className="prism-annual-editor" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby={`${formId}-title`}>
    <header className="prism-annual-editor__header">
      <div><h4 id={`${formId}-title`}>{mt('annualEditTitle', lang)}</h4><p className="prism-search-hint">{mt('annualVersion', lang)} <bdi dir="ltr">{item.fieldVersion.versionNumber}</bdi> · <bdi dir="ltr">{item.scope.planningYear}</bdi></p></div>
      {onClose && <button type="button" disabled={locked} onClick={onClose}>{mt('annualCloseDetails', lang)}</button>}
    </header>
    <p className="prism-search-hint">{mt('annualEditPolicy', lang)}</p>
    {onReloadCurrent && <button type="button" disabled={locked} onClick={onReloadCurrent}>{mt('annualLoadServerVersion', lang)}</button>}
    {item.canonicalDrift && <p className="prism-notice prism-notice--warning">{mt('annualCanonicalStale', lang)}</p>}
    {needsReview && <div role="note" className="prism-notice prism-notice--warning">
      <p>{mt('annualLegalReviewRequired', lang)}</p>
      {legalReview.length > 0 && <ul>{legalReview.map((field) => <li key={field}>{mt(FIELD_LABELS[field], lang)}</li>)}</ul>}
      {onRequestRegistration && <button type="button" disabled={locked} onClick={() => onRequestRegistration(editableAnnualFields(item.fieldVersion.fields))}>{mt('annualRequestLegalReview', lang)}</button>}
    </div>}
    {notice && <p role="status" className="prism-notice prism-notice--success">{notice}</p>}
    {errorText && <p role="alert" className="prism-notice prism-notice--error">{errorText}</p>}
    {outcomeUnknown && <p role="alert" className="prism-notice prism-notice--warning">{mt('annualEditUnknown', lang)}</p>}
    {stale && <div role="alert" className="prism-notice prism-notice--warning"><p>{mt('annualEditStale', lang)}</p>
      <button type="button" disabled={locked} onClick={() => resetTo(item)}>{mt('annualUseCurrentVersion', lang)}</button>
    </div>}
    <form aria-label={mt('annualEditTitle', lang)} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="prism-table-scroll prism-annual-field-table" role="region" aria-label={mt('annualBeforeAfter', lang)} tabIndex={0}>
        <table><thead><tr><th scope="col">{mt('annualField', lang)}</th><th scope="col">{mt('annualBefore', lang)}</th><th scope="col">{mt('annualAfter', lang)}</th></tr></thead>
          <tbody>{ANNUAL_IDENTITY_FIELDS.map((field) => <tr key={field} data-changed={before[field] !== fields[field]}>
            <th scope="row"><label htmlFor={`${formId}-${field}`}>{mt(FIELD_LABELS[field], lang)}</label></th>
            <td><bdi dir={field === 'nameAr' ? 'rtl' : 'ltr'}>{field === 'unit' ? manualUnitText(before[field], lang) : before[field] ?? '—'}</bdi></td>
            <td>{field === 'unit'
              ? <select id={`${formId}-${field}`} value={fields[field] ?? ''} disabled={!canEdit || locked} onChange={(event) => setFields((old) => ({ ...old, unit: event.target.value || null }))}>
                <option value="">—</option>{MATERIAL_UNITS.map((unit) => <option key={unit} value={unit}>{manualUnitText(unit, lang)}</option>)}
              </select>
              : <input id={`${formId}-${field}`} dir={field === 'nameAr' ? 'rtl' : 'ltr'} maxLength={4000} value={fields[field] ?? ''} disabled={!canEdit || locked}
                onChange={(event) => setFields((old) => ({ ...old, [field]: event.target.value || null }))} />}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      {canEdit && <>
        <label htmlFor={`${formId}-reason`}>{mt('annualEditReason', lang)}
          <textarea id={`${formId}-reason`} maxLength={2000} rows={3} value={reason} disabled={locked} aria-required="true"
            onChange={(event) => { setReason(event.target.value); setFieldError(null); }} />
        </label>
        <p className="prism-search-hint">{mt('annualActorSource', lang)}</p>
        {fieldError && <p role="alert" className="prism-field-error">{fieldError}</p>}
        <div className="prism-form-actions">
          <button type="submit" disabled={busy || submitting || stale || !changed || !reason.trim() || !canonicalReady}><PhoenixIcon name="save" size={16} aria-hidden="true" />{mt(outcomeUnknown ? 'annualRetrySameEdit' : 'annualSaveEdit', lang)}</button>
          {onPreviewCanonical && <button type="button" disabled={locked} onClick={onPreviewCanonical}>{mt('annualPreviewCanonical', lang)}</button>}
        </div>
      </>}
    </form>
    {canonicalPreview && <section className="prism-annual-canonical" aria-label={mt('annualCanonicalPreview', lang)}>
      <h4>{mt('annualCanonicalPreview', lang)}</h4>
      <p className="prism-search-hint">{mt('annualCanonicalRefreshHint', lang)}</p>
      <dl>{ANNUAL_IDENTITY_FIELDS.map((field) => <div key={field}><dt>{mt(FIELD_LABELS[field], lang)}</dt><dd><bdi>{field === 'unit' ? manualUnitText(canonicalPreview.canonicalSnapshot[field], lang) : canonicalPreview.canonicalSnapshot[field] ?? '—'}</bdi></dd></div>)}</dl>
      {canEdit && onRefreshCanonical && <button type="button" disabled={busy || submitting || stale || !reason.trim()} onClick={() => void refresh()}>{mt('annualConfirmCanonicalRefresh', lang)}</button>}
    </section>}
    {sourcePanel}
    <section className="prism-annual-history" aria-label={mt('annualChangeHistory', lang)}>
      <div className="prism-annual-editor__header"><h4>{mt('annualChangeHistory', lang)}</h4>
        {onLoadHistory && <button type="button" disabled={historyBusy || locked} onClick={() => onLoadHistory(false)}>{mt('annualReloadHistory', lang)}</button>}
      </div>
      {historyBusy && <p role="status" className="prism-loading">{mt('loading', lang)}</p>}
      {historyFailed && <p role="alert" className="prism-notice prism-notice--error">{mt('annualHistoryFailed', lang)}</p>}
      {!historyBusy && !historyFailed && changes.length === 0 && <p>{mt('annualHistoryEmpty', lang)}</p>}
      <ol>{changes.map((change) => <li key={change.changeId}><details>
        <summary><span className="prism-annual-history__actor"><PhoenixIcon name="editor" size={16} aria-hidden="true" /><bdi>{change.fromTrustedProfile && change.actorName ? change.actorName : mt('annualHistoricalActorMissing', lang)}</bdi></span>
          <time dateTime={change.createdAt} title={change.createdAt}>{timestamp(change.createdAt, lang)} {mt('annualBaghdadTime', lang)}</time>
        </summary>
        <p><strong>{mt('annualEditReason', lang)}: </strong>{change.reason}</p>
        <div className="prism-table-scroll" role="region" aria-label={mt('annualBeforeAfter', lang)} tabIndex={0}>
          <table><thead><tr><th scope="col">{mt('annualField', lang)}</th><th scope="col">{mt('annualBefore', lang)}</th><th scope="col">{mt('annualAfter', lang)}</th></tr></thead>
            <tbody>{ANNUAL_IDENTITY_FIELDS.filter((field) => change.beforeFields[field] !== change.afterFields[field]).map((field) => <tr key={field}>
              <th scope="row">{mt(FIELD_LABELS[field], lang)}</th><td><bdi>{field === 'unit' ? manualUnitText(change.beforeFields[field], lang) : change.beforeFields[field] ?? '—'}</bdi></td><td><bdi>{field === 'unit' ? manualUnitText(change.afterFields[field], lang) : change.afterFields[field] ?? '—'}</bdi></td>
            </tr>)}</tbody>
          </table>
        </div>
        {change.requiresLegalReview.length > 0 && <p className="prism-notice prism-notice--warning">{mt('annualLegalReviewRequired', lang)} {change.requiresLegalReview.map((field) => mt(FIELD_LABELS[field], lang)).join('، ')}</p>}
      </details></li>)}</ol>
      {hasMoreHistory && onLoadHistory && <button type="button" disabled={historyBusy || locked} onClick={() => onLoadHistory(true)}>{mt('annualMoreHistory', lang)}</button>}
    </section>
  </section>;
}
