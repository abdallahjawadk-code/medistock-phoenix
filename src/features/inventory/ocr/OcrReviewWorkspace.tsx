import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import type { OcrBox } from './types';
import type { PharmaFieldName } from './parse/fields';
import type { ConfidenceBand } from './confidence';

/**
 * PHARMA-OCR-A — the split review workspace.
 *
 * Document on one side, editable fields on the other, linked in BOTH
 * directions: focusing a field highlights the image region it came from, and
 * clicking a region focuses its field. That bidirectional link is the whole
 * point of carrying bounding boxes through every layer — an operator verifying
 * a batch number should not have to hunt the page for it.
 *
 * The original OCR value stays visible beside the corrected one so a correction
 * is always auditable by eye.
 */

export interface ReviewFieldModel {
  field: PharmaFieldName;
  label: string;
  value: string;
  /** Untouched OCR reading; null when the operator added the field by hand. */
  originalOcrValue: string | null;
  box: OcrBox | null;
  band: ConfidenceBand;
  reasons: string[];
  /** True for the fields that always demand an explicit tick. */
  requiresConfirmation: boolean;
  confirmed: boolean;
  /** Alternative readings the parser refused to choose between. */
  alternatives?: string[];
}

export interface ReviewWarning {
  id: string;
  severity: 'blocking' | 'advisory';
  message: string;
}

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  fields: ReviewFieldModel[];
  warnings: ReviewWarning[];
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  onChangeField: (field: PharmaFieldName, value: string) => void;
  onToggleConfirm: (field: PharmaFieldName, confirmed: boolean) => void;
}

const BAND_STYLE: Record<ConfidenceBand, { background: string; color: string; labelKey: string }> = {
  high: { background: 'var(--ok2)', color: 'var(--ok)', labelKey: 'ocr_band_high' },
  needs_review: { background: 'var(--warn2)', color: 'var(--warn)', labelKey: 'ocr_band_needs_review' },
  uncertain: { background: 'var(--err2)', color: 'var(--err)', labelKey: 'ocr_band_uncertain' },
};

export function OcrReviewWorkspace({
  imageUrl, imageWidth, imageHeight, fields, warnings, lang, dir,
  onChangeField, onToggleConfirm,
}: Props) {
  const [activeField, setActiveField] = useState<PharmaFieldName | null>(null);

  // PhoenixInput does not forward refs, and widening that shared component
  // would ripple across every screen that uses it. A deterministic id per field
  // gives the region→field focus link without touching shared UI.
  const inputId = (field: PharmaFieldName) => `ocr-review-field-${field}`;

  const blocking = warnings.filter(w => w.severity === 'blocking');
  const advisory = warnings.filter(w => w.severity === 'advisory');

  // Overlay rectangles are expressed in percentages so they track the rendered
  // image at any size without a resize observer.
  const overlays = useMemo(
    () => fields
      .filter(f => f.box)
      .map(f => ({
        field: f.field,
        band: f.band,
        left: (f.box!.x0 / imageWidth) * 100,
        top: (f.box!.y0 / imageHeight) * 100,
        width: ((f.box!.x1 - f.box!.x0) / imageWidth) * 100,
        height: ((f.box!.y1 - f.box!.y0) / imageHeight) * 100,
      })),
    [fields, imageWidth, imageHeight],
  );

  const focusField = (field: PharmaFieldName) => {
    setActiveField(field);
    document.getElementById(inputId(field))?.focus();
  };

  return (
    <div
      dir={dir}
      style={{
        display: 'grid',
        // Single column on mobile/tablet, split on desktop.
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
        gap: '16px',
        alignItems: 'start',
      }}
    >
      {/* ── Document pane ── */}
      <PhoenixCard>
        <div style={{ position: 'relative', width: '100%' }}>
          <img
            src={imageUrl}
            alt={t('ocr_document_alt', lang)}
            style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 'var(--r3)' }}
          />
          {overlays.map(overlay => {
            const isActive = overlay.field === activeField;
            return (
              <button
                key={overlay.field}
                type="button"
                aria-label={t('ocr_focus_field', lang)}
                onClick={() => focusField(overlay.field)}
                style={{
                  position: 'absolute',
                  left: `${overlay.left}%`,
                  top: `${overlay.top}%`,
                  width: `${overlay.width}%`,
                  height: `${overlay.height}%`,
                  border: `2px solid ${BAND_STYLE[overlay.band].color}`,
                  background: isActive ? 'rgba(56,132,255,.22)' : 'transparent',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  padding: 0,
                  // The DRAWN rectangle must stay true to the recognized region.
                  // A previous version put minWidth/minHeight: 44px directly on
                  // this button with content-box sizing, which inflated every
                  // small region into a 44px block: the highlight no longer sat
                  // on the text it came from, defeating the entire point of
                  // carrying bounding boxes through the pipeline. The hit area
                  // is enlarged by the child below instead, which paints nothing.
                  boxSizing: 'border-box',
                }}
              >
                <span
                  data-hit-area
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '100%',
                    height: '100%',
                    minWidth: '44px',
                    minHeight: '44px',
                  }}
                />
              </button>
            );
          })}
        </div>
      </PhoenixCard>

      {/* ── Field pane ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {blocking.length > 0 && (
          <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--err)', marginBottom: '6px' }}>
              {t('ocr_warnings_blocking', lang)}
            </h3>
            <ul style={{ margin: 0, paddingInlineStart: '18px', fontSize: '12px', color: 'var(--err)' }}>
              {blocking.map(w => <li key={w.id}>{w.message}</li>)}
            </ul>
          </div>
        )}

        {advisory.length > 0 && (
          <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--warn)', marginBottom: '6px' }}>
              {t('ocr_warnings_advisory', lang)}
            </h3>
            <ul style={{ margin: 0, paddingInlineStart: '18px', fontSize: '12px', color: 'var(--warn)' }}>
              {advisory.map(w => <li key={w.id}>{w.message}</li>)}
            </ul>
          </div>
        )}

        {fields.map(field => {
          const band = BAND_STYLE[field.band];
          const changed = field.originalOcrValue !== null && field.originalOcrValue !== field.value;
          return (
            <PhoenixCard key={field.field}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 700 }}>{field.label}</span>
                <span style={{
                  fontSize: '10.5px', fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--rpill)',
                  background: band.background, color: band.color,
                }}>
                  {t(band.labelKey, lang)}
                </span>
              </div>

              <PhoenixInput
                id={inputId(field.field)}
                value={field.value}
                onChange={event => onChangeField(field.field, event.target.value)}
                onFocus={() => setActiveField(field.field)}
              />

              {/* Original OCR text stays visible beside the corrected value. */}
              {field.originalOcrValue !== null && (
                <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '5px' }}>
                  {t('ocr_original_reading', lang)}:{' '}
                  <code style={{ textDecoration: changed ? 'line-through' : 'none' }}>{field.originalOcrValue}</code>
                </p>
              )}

              {field.alternatives && field.alternatives.length > 1 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                  {field.alternatives.map(alternative => (
                    <button
                      key={alternative}
                      type="button"
                      onClick={() => onChangeField(field.field, alternative)}
                      style={{
                        minHeight: '44px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
                        borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
                        background: field.value === alternative ? 'var(--p2)' : 'var(--s)',
                      }}
                    >
                      {alternative}
                    </button>
                  ))}
                </div>
              )}

              {field.reasons.length > 0 && (
                <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '5px' }}>
                  {field.reasons.map(reason => t(`ocr_reason_${reason}`, lang)).join(' · ')}
                </p>
              )}

              {field.requiresConfirmation && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px', fontSize: '12px', marginTop: '4px' }}>
                  <input
                    type="checkbox"
                    checked={field.confirmed}
                    onChange={event => onToggleConfirm(field.field, event.target.checked)}
                  />
                  {t('ocr_confirm_field', lang)}
                </label>
              )}
            </PhoenixCard>
          );
        })}
      </div>
    </div>
  );
}
