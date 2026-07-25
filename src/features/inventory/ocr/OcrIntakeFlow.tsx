import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  receiveWarehouseStock, getWarehouseReceiptLotGeneration,
  newRequestId, classifyIntakeError, GENERATION_UNAVAILABLE_CODE,
  type ReceiveWarehouseStockInput,
} from '../warehouse-intake.service';
import { validateImageFile, ACCEPT_ATTRIBUTE, rejectionMessageKey } from './image/validate';
import { assessQuality, type QualityAssessment } from './image/quality';
import { extractPharmaFields, bestCandidatePerField, isPlausibleBatch, isPlausibleNationalCode, type PharmaFieldName } from './parse/fields';
import { matchCatalog, type CatalogMaterial, type MatchOutcome } from './match/catalog-match';
import { assessBatchIdentity, type ExistingBatchIdentity } from './match/duplicate-identity';
import { assessFieldConfidence, orderForReview, REQUIRED_CONFIRMATION_FIELDS } from './confidence';
import { OcrReviewWorkspace, type ReviewFieldModel, type ReviewWarning } from './OcrReviewWorkspace';
import type { OcrLanguage, OcrProvider, OcrProgress, OcrDocumentResult } from './types';
import { OcrCancelledError, OcrUnavailableError } from './types';
import { displaySupplyType } from '@/shared/lib/supply-types';

/**
 * PHARMA-OCR-A — the staged OCR intake flow.
 *
 * Capture → Quality → Recognize → Match → Review → Final preview → Confirm.
 *
 * THE SAFETY INVARIANT OF THIS FILE: no intake RPC is reachable from any stage
 * before 'preview', and even there it fires only from the explicit confirm
 * handler. There is exactly ONE call to receiveWarehouseStock in this file, in
 * confirmAndSubmit, guarded by canSubmit. OCR never auto-saves, never picks an
 * availability status, and never changes warehouse scope — the warehouse comes
 * from the parent screen's already-authorized selection.
 *
 * On completion it calls the SAME service and RPC as manual entry. There is no
 * OCR-specific write path.
 */

type Stage = 'capture' | 'quality' | 'recognizing' | 'review' | 'preview' | 'submitting' | 'done';

interface Props {
  /** Already scope-checked by the parent Inventory Center. Never chosen here. */
  warehouseId: string;
  /** Authorized central catalog for matching. OCR may not add to it. */
  catalog: readonly CatalogMaterial[];
  /** Existing batches in this warehouse, for duplicate/conflict detection. */
  existingBatches: readonly ExistingBatchIdentity[];
  canSubmitIntake: boolean;
  onCancel: () => void;
  onSubmitted: (messageKey: string) => void;
  /** 078 generation conflict — parent reloads canonical stock; retry stays explicit. */
  onConflict?: () => void;
}

const FIELD_LABEL_KEYS: Partial<Record<PharmaFieldName, string>> = {
  scientificName: 'inv_scientific_name',
  tradeName: 'inv_trade_name',
  concentration: 'inv_concentration',
  dosageForm: 'inv_dosage_form',
  unit: 'inv_unit',
  nationalCode: 'inv_national_code',
  batchNumber: 'inv_batch_number',
  expiryDate: 'inv_expiry_date',
  quantity: 'inv_quantity_received',
  unitPrice: 'inv_unit_price',
  supplyType: 'inv_supply_type',
  sourceDocumentNumber: 'inv_source_document',
  notes: 'inv_notes',
};

/** Fields carried into the intake RPC. Others are review-only context. */
const SUBMITTED_FIELDS: PharmaFieldName[] = [
  'scientificName', 'tradeName', 'concentration', 'dosageForm', 'unit',
  'nationalCode', 'batchNumber', 'expiryDate', 'quantity', 'unitPrice',
  'supplyType', 'sourceDocumentNumber', 'notes',
];

export function OcrIntakeFlow({
  warehouseId, catalog, existingBatches, canSubmitIntake, onCancel, onSubmitted, onConflict,
}: Props) {
  const { lang, dir } = useApp();

  const [stage, setStage] = useState<Stage>('capture');
  const [language, setLanguage] = useState<OcrLanguage>('ara+eng');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [quality, setQuality] = useState<QualityAssessment | null>(null);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [values, setValues] = useState<Partial<Record<PharmaFieldName, string>>>({});
  const [originals, setOriginals] = useState<Partial<Record<PharmaFieldName, string>>>({});
  const [reviewFields, setReviewFields] = useState<ReviewFieldModel[]>([]);
  const [warnings, setWarnings] = useState<ReviewWarning[]>([]);
  const [confirmed, setConfirmed] = useState<Partial<Record<PharmaFieldName, boolean>>>({});
  const [match, setMatch] = useState<MatchOutcome | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  /** Never pre-ticked, and reset whenever the operator returns to review. */
  const [warehouseConfirmed, setWarehouseConfirmed] = useState(false);

  const providerRef = useRef<OcrProvider | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /** Release the object URL and drop the decoded buffer. Called on every exit path. */
  const releaseImage = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setImageUrl(null);
    setImageBlob(null);
  }, []);

  /** Terminate the worker. Safe to call repeatedly. */
  const teardownProvider = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    const provider = providerRef.current;
    providerRef.current = null;
    if (provider) await provider.dispose();
  }, []);

  // No worker or object URL may outlive this component under any exit —
  // navigation, unmount, or an error thrown mid-flow.
  useEffect(() => () => {
    void teardownProvider();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, [teardownProvider]);

  // ── Stage 1: capture ──────────────────────────────────────────────────────

  const onFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setErrorKey(null);

    const validation = await validateImageFile(file);
    if (!validation.ok) {
      setErrorKey(rejectionMessageKey(validation.reason));
      return;
    }

    releaseImage();
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setImageUrl(url);
    setImageBlob(file);
    setDimensions({ width: validation.width, height: validation.height });

    const assessment = await assessImage(file, validation.width, validation.height);
    setQuality(assessment);
    setStage('quality');
  };

  // ── Stage 2 → 3: recognize ────────────────────────────────────────────────

  const startRecognition = async () => {
    if (!imageBlob) return;
    setErrorKey(null);
    setStage('recognizing');
    setProgress({ phase: 'loading-engine', ratio: null });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Dynamic import keeps the engine out of every critical chunk. This is
      // the first moment any OCR code is fetched.
      const { createTesseractProvider } = await import('./tesseract-provider');
      const provider = createTesseractProvider({ onProgress: setProgress });
      providerRef.current = provider;

      await provider.initialize(language);
      const result = await provider.recognize(imageBlob, controller.signal);

      buildReview(result);
      setStage('review');
    } catch (cause) {
      if (cause instanceof OcrCancelledError) {
        // Cancel returns to the quality stage with the image and any edits kept.
        setStage('quality');
      } else if (cause instanceof OcrUnavailableError) {
        setErrorKey('ocr_err_unavailable');
        setStage('quality');
      } else {
        setErrorKey('ocr_err_failed');
        setStage('quality');
      }
    } finally {
      // The worker is disposed whether recognition succeeded, failed or was
      // cancelled — nothing is left running once this returns.
      await teardownProvider();
      setProgress(null);
    }
  };

  // ── Stage 4: parse, match, score ──────────────────────────────────────────

  const buildReview = (result: OcrDocumentResult) => {
    const extraction = extractPharmaFields(result);
    const best = bestCandidatePerField(extraction.candidates);

    const nextValues: Partial<Record<PharmaFieldName, string>> = {};
    const nextOriginals: Partial<Record<PharmaFieldName, string>> = {};
    for (const [field, entry] of best) {
      nextValues[field] = entry.best.value;
      nextOriginals[field] = entry.best.sourceText;
    }

    const outcome = matchCatalog(
      {
        scientificName: nextValues.scientificName ?? null,
        tradeName: nextValues.tradeName ?? null,
        concentration: nextValues.concentration ?? null,
        dosageForm: nextValues.dosageForm ?? null,
        nationalCode: nextValues.nationalCode ?? null,
      },
      catalog,
    );
    setMatch(outcome);

    // A unique match may FILL identity fields, but never confirms them — the
    // required-confirmation ticks below are still unchecked.
    if (outcome.kind === 'unique') {
      const material = outcome.candidate.material;
      nextValues.scientificName ??= material.scientificName;
      nextValues.concentration ??= material.concentration ?? undefined;
      nextValues.dosageForm ??= material.dosageForm ?? undefined;
      nextValues.unit ??= material.unit ?? undefined;
      nextValues.nationalCode ??= material.nationalCode ?? undefined;
    }

    const nextWarnings: ReviewWarning[] = [];
    if (outcome.kind === 'no_match') {
      nextWarnings.push({ id: 'no_match', severity: 'blocking', message: t('ocr_warn_no_match', lang) });
    }
    if (outcome.kind === 'ambiguous') {
      nextWarnings.push({ id: 'ambiguous_match', severity: 'blocking', message: t('ocr_warn_ambiguous_match', lang) });
    }

    const identity = assessBatchIdentity(
      {
        warehouseId,
        scientificName: nextValues.scientificName ?? '',
        nationalCode: nextValues.nationalCode ?? null,
        batchNumber: nextValues.batchNumber ?? null,
        expiryDate: nextValues.expiryDate ?? null,
      },
      existingBatches,
    );
    for (const finding of identity.findings) {
      nextWarnings.push({
        id: `identity_${finding.kind}_${finding.existing.warehouseStockId}`,
        severity: 'blocking',
        message: t(`ocr_warn_${finding.kind}`, lang),
      });
    }

    const models: ReviewFieldModel[] = [];
    for (const field of SUBMITTED_FIELDS) {
      const entry = best.get(field);
      const value = nextValues[field] ?? '';
      const formatValid = validateFieldFormat(field, value);
      const catalogAgreement = outcome.kind === 'unique'
        ? !outcome.candidate.conflictingFields.includes(field)
        : null;

      const confidence = entry
        ? assessFieldConfidence({
          candidate: entry.best,
          formatValid,
          catalogAgreement,
          crossFieldConsistent: null,
        })
        : { field, band: 'uncertain' as const, evidence: {} as never, reasons: ['not_detected'] };

      models.push({
        field,
        label: t(FIELD_LABEL_KEYS[field] ?? field, lang),
        value,
        originalOcrValue: nextOriginals[field] ?? null,
        box: entry?.best.box ?? null,
        band: confidence.band,
        reasons: confidence.reasons,
        requiresConfirmation: REQUIRED_CONFIRMATION_FIELDS.includes(field),
        confirmed: false,
        alternatives: entry?.best.ambiguousAlternatives,
      });
    }

    const ordered = orderForReview(models.map(m => ({ field: m.field, band: m.band, evidence: {} as never, reasons: m.reasons })));
    const byField = new Map(models.map(m => [m.field, m]));

    setValues(nextValues);
    setOriginals(nextOriginals);
    setWarnings(nextWarnings);
    setConfirmed({});
    setReviewFields(ordered.map(o => byField.get(o.field)!).filter(Boolean));
  };

  // ── Field editing ─────────────────────────────────────────────────────────

  const onChangeField = (field: PharmaFieldName, value: string) => {
    setValues(previous => ({ ...previous, [field]: value }));
    setReviewFields(previous => previous.map(f => (f.field === field ? { ...f, value } : f)));
    // Editing a value invalidates its prior confirmation — the operator must
    // re-affirm what they actually changed it to.
    setConfirmed(previous => ({ ...previous, [field]: false }));
    setReviewFields(previous => previous.map(f => (f.field === field ? { ...f, confirmed: false } : f)));
    // A changed payload is a NEW logical attempt with its own idempotency key;
    // only an UNCHANGED resubmit (a lost-response retry) replays the previous one.
    setRequestId(newRequestId());
  };

  const onToggleConfirm = (field: PharmaFieldName, isConfirmed: boolean) => {
    setConfirmed(previous => ({ ...previous, [field]: isConfirmed }));
    setReviewFields(previous => previous.map(f => (f.field === field ? { ...f, confirmed: isConfirmed } : f)));
  };

  // ── Gating ────────────────────────────────────────────────────────────────

  const hasBlockingWarning = warnings.some(w => w.severity === 'blocking');

  const outstandingConfirmations = useMemo(
    () => REQUIRED_CONFIRMATION_FIELDS.filter(field => {
      // Price is only mandatory to confirm when a value is actually present.
      if (field === 'unitPrice' && !values.unitPrice) return false;
      if (field === 'nationalCode' && !values.nationalCode) return false;
      if (field === 'batchNumber' && !values.batchNumber) return false;
      return !confirmed[field];
    }),
    [confirmed, values],
  );

  const quantityValue = Number(values.quantity);
  const quantityValid = Number.isInteger(quantityValue) && quantityValue > 0;
  // The closed supply vocabulary is mandatory for every Pharmacy Department
  // intake, including OCR-assisted review. Invalid/unmapped OCR text cannot
  // reach preview and therefore cannot fail later at the writer.
  const normalizedSupplyType = displaySupplyType(values.supplyType);
  const supplyTypeValid = normalizedSupplyType !== null;

  const canReachPreview =
    !hasBlockingWarning && outstandingConfirmations.length === 0
    && quantityValid && supplyTypeValid;

  // CANONICAL-INTEGRATION: the warehouse is a critical field, but unlike the
  // others it is NOT read from the document — it arrives already scope-checked
  // from the Inventory Center. It therefore gets its own explicit confirmation
  // at the final preview, so the operator states the destination rather than
  // inheriting whatever was selected several steps earlier.
  const canSubmit = stage === 'preview' && canReachPreview && canSubmitIntake && warehouseConfirmed;

  // ── Final submit — the ONLY RPC call in this flow ─────────────────────────

  const confirmAndSubmit = async () => {
    if (!canSubmit) return;
    setStage('submitting');

    const base: Omit<ReceiveWarehouseStockInput, 'expectedGeneration'> = {
      requestId,
      warehouseId,
      scientificName: values.scientificName ?? '',
      quantity: quantityValue,
      // Absence is an explicit operator statement, exactly as in manual entry.
      hasNoNationalCode: !values.nationalCode,
      hasNoBatchNumber: !values.batchNumber,
      // 118: OCR assists manual central intake; it never selects a catalog row.
      centralItemId: null,
      tradeName: values.tradeName || null,
      concentration: values.concentration || null,
      dosageForm: values.dosageForm || null,
      unit: values.unit || null,
      nationalCode: values.nationalCode || null,
      batchNumber: values.batchNumber || null,
      expiryDate: values.expiryDate || null,
      unitPrice: values.unitPrice ? Number(values.unitPrice) : null,
      // 088: the wire value is the CLOSED vocabulary only. OCR text is coerced
      // through the display mapping (donations → aid); unmappable → null.
      supplyType: normalizedSupplyType,
      purchaseOrigin: normalizedSupplyType === 'purchase' ? 'central' : null,
      sourceDocumentNumber: values.sourceDocumentNumber || null,
      // Entry method is recorded in the EXISTING free-text notes contract — no
      // schema field, no migration, no new column.
      notes: [values.notes, `[${t('ocr_entry_method_note', lang)}]`].filter(Boolean).join(' '),
    };

    // 078 discipline: the canonical generation is read ONLY here — after the
    // mandatory human review and explicit confirmations froze the material and
    // batch identity above (canSubmit). OCR confidence never invents a
    // generation; a failed read refuses without calling any writer.
    const generation = await getWarehouseReceiptLotGeneration(base);
    if (!generation.ok) {
      setErrorKey(classifyIntakeError(GENERATION_UNAVAILABLE_CODE));
      setStage('preview');
      return;
    }

    const payload: ReceiveWarehouseStockInput = { ...base, expectedGeneration: generation.generation };
    const result = await receiveWarehouseStock(payload);
    if (result.ok) {
      releaseImage();
      setRequestId(newRequestId());
      onSubmitted(result.data?.replayed ? 'inv_intake_replayed' : 'inv_intake_ok');
      setStage('done');
    } else {
      const failureKey = classifyIntakeError(result.error);
      setErrorKey(failureKey);
      // The canonical lot moved between the read and the post: the parent
      // reloads canonical stock; the retry stays an explicit operator act.
      if (failureKey === 'inv_err_generation_conflict') onConflict?.();
      // Corrections survive a failed submit; the operator retries with the SAME
      // request id, so a timeout cannot post the quantity twice.
      setStage('preview');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const cancelRecognition = () => { abortRef.current?.abort(); };

  const leaveFlow = async () => {
    await teardownProvider();
    releaseImage();
    onCancel();
  };

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px', fontWeight: 700 }}>
          {t('ocr_title', lang)}
          <span style={{
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
            padding: '3px 9px', borderRadius: 'var(--rpill)',
            background: 'var(--warn2)', color: 'var(--warn)', border: '1px solid var(--warn)',
          }}>
            {t('ocr_beta_badge', lang)}
          </span>
        </h3>
        <PhoenixButton variant="ghost" onClick={leaveFlow}>{t('ocr_use_manual_entry', lang)}</PhoenixButton>
      </div>

      {/* CANONICAL-INTEGRATION: mandatory BETA notice. Rendered once here, OUTSIDE
          the stage switch, so it is present on capture, quality, recognition,
          review, preview and submission alike — an operator can never reach a
          stage where the human-review requirement is off screen. */}
      <div
        role="note"
        data-testid="ocr-beta-banner"
        style={{
          background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)',
          padding: '10px 14px', fontSize: '12.5px', fontWeight: 600, color: 'var(--warn)',
        }}
      >
        <PhoenixIcon name="warning" inline /> {t('ocr_beta_banner', lang)}
      </div>

      {errorKey && (
        <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12.5px', color: 'var(--err)' }}>
          {t(errorKey, lang)}
        </div>
      )}

      {stage === 'capture' && (
        <PhoenixCard>
          <PhoenixSelect
            label={t('ocr_language', lang)}
            value={language}
            onChange={event => setLanguage(event.target.value as OcrLanguage)}
            options={[
              { value: 'ara+eng', label: t('ocr_lang_both', lang) },
              { value: 'ara', label: t('ocr_lang_ara', lang) },
              { value: 'eng', label: t('ocr_lang_eng', lang) },
            ]}
          />
          <label style={{ display: 'block', marginTop: '12px', fontSize: '12.5px', fontWeight: 600 }}>
            {t('ocr_choose_image', lang)}
            <input
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              capture="environment"
              onChange={event => void onFileSelected(event.target.files?.[0])}
              style={{ display: 'block', marginTop: '8px', minHeight: '44px' }}
            />
          </label>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '8px' }}>
            {t('ocr_accepted_formats', lang)}
          </p>
        </PhoenixCard>
      )}

      {stage === 'quality' && imageUrl && (
        <PhoenixCard>
          <img src={imageUrl} alt={t('ocr_document_alt', lang)} style={{ maxWidth: '100%', borderRadius: 'var(--r3)' }} />
          {quality && (
            <div style={{ marginTop: '12px' }}>
              <p style={{ fontSize: '12.5px', fontWeight: 700 }}>
                {t(`ocr_quality_${quality.verdict}`, lang)}
              </p>
              {quality.findings.length > 0 && (
                <ul style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '6px', paddingInlineStart: '18px' }}>
                  {quality.findings.map(finding => (
                    <li key={finding.issue}>
                      {t(`ocr_quality_issue_${finding.issue}`, lang)}
                      {' '}({finding.measured.toFixed(1)} / {finding.threshold})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
            <PhoenixButton onClick={startRecognition}>{t('ocr_start_recognition', lang)}</PhoenixButton>
            <PhoenixButton variant="ghost" onClick={() => { releaseImage(); setQuality(null); setStage('capture'); }}>
              {t('ocr_retake', lang)}
            </PhoenixButton>
          </div>
        </PhoenixCard>
      )}

      {stage === 'recognizing' && (
        <PhoenixCard>
          <p style={{ fontSize: '13px', fontWeight: 600 }}>
            {t(`ocr_phase_${progress?.phase ?? 'preparing'}`, lang)}
            {progress?.ratio !== null && progress?.ratio !== undefined
              ? ` — ${Math.round(progress.ratio * 100)}%`
              : ''}
          </p>
          <div style={{ marginTop: '12px' }}>
            <PhoenixButton variant="ghost" onClick={cancelRecognition}>{t('ocr_cancel', lang)}</PhoenixButton>
          </div>
        </PhoenixCard>
      )}

      {stage === 'review' && imageUrl && (
        <>
          <OcrReviewWorkspace
            imageUrl={imageUrl}
            imageWidth={dimensions.width}
            imageHeight={dimensions.height}
            fields={reviewFields}
            warnings={warnings}
            lang={lang}
            dir={dir}
            onChangeField={onChangeField}
            onToggleConfirm={onToggleConfirm}
          />
          <PhoenixCard>
            {match && match.kind !== 'unique' && (
              <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '8px' }}>
                {t('ocr_select_material_manually', lang)}
              </p>
            )}
            {outstandingConfirmations.length > 0 && (
              <p style={{ fontSize: '12px', color: 'var(--warn)', marginBottom: '8px' }}>
                {t('ocr_outstanding_confirmations', lang)}: {outstandingConfirmations.length}
              </p>
            )}
            <PhoenixButton onClick={() => setStage('preview')} disabled={!canReachPreview}>
              {t('ocr_go_to_preview', lang)}
            </PhoenixButton>
          </PhoenixCard>
        </>
      )}

      {(stage === 'preview' || stage === 'submitting') && (
        <PhoenixCard>
          <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ocr_final_preview', lang)}</h4>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '10px' }}>
            {t('ocr_final_preview_note', lang)}
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '12.5px' }}>
            {SUBMITTED_FIELDS.filter(field => values[field]).map(field => (
              <div key={field} style={{ display: 'contents' }}>
                <dt style={{ fontWeight: 600, color: 'var(--t2)' }}>{t(FIELD_LABEL_KEYS[field] ?? field, lang)}</dt>
                <dd style={{ margin: 0 }}>{values[field]}</dd>
              </div>
            ))}
          </dl>
          <label style={{
            display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px',
            fontSize: '12.5px', fontWeight: 600, marginTop: '12px',
          }}>
            <input
              type="checkbox"
              checked={warehouseConfirmed}
              onChange={event => setWarehouseConfirmed(event.target.checked)}
            />
            {t('ocr_confirm_warehouse', lang)}
          </label>

          <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
            {/* canSubmit already requires stage === 'preview', so it is false
                during 'submitting' — no separate in-flight check is needed. */}
            <PhoenixButton onClick={confirmAndSubmit} disabled={!canSubmit}>
              {t('ocr_confirm_and_submit', lang)}
            </PhoenixButton>
            <PhoenixButton
              variant="ghost"
              onClick={() => { setWarehouseConfirmed(false); setStage('review'); }}
              disabled={stage === 'submitting'}
            >
              {t('ocr_back_to_review', lang)}
            </PhoenixButton>
          </div>
        </PhoenixCard>
      )}

      {stage === 'done' && <PhoenixEmptyState icon="✅" title={t('inv_intake_ok', lang)} />}
    </div>
  );
}

/** Format validators mirroring the parser's, applied to operator-edited values. */
function validateFieldFormat(field: PharmaFieldName, value: string): boolean {
  if (!value) return false;
  switch (field) {
    case 'batchNumber': return isPlausibleBatch(value);
    case 'nationalCode': return isPlausibleNationalCode(value);
    case 'expiryDate': return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'quantity': return /^\d+$/.test(value) && Number(value) > 0;
    case 'unitPrice': return /^\d+(\.\d+)?$/.test(value);
    default: return true;
  }
}

/** Decode once to RGBA and run the quality metrics; releases every resource. */
async function assessImage(blob: Blob, width: number, height: number): Promise<QualityAssessment | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return assessQuality(data, width, height);
  } catch {
    // A quality assessment failure must never block recognition — the operator
    // simply proceeds without a warning they might otherwise have received.
    return null;
  } finally {
    bitmap?.close();
  }
}
