/**
 * PAPER-REFERENCE-CONTRACT-110 — shared entry controls for the optional
 * number / date / issuing-authority field-set. Every composer that offers
 * paper-reference entry uses THIS component rather than hand-rolling its own
 * three inputs, so the fields read identically everywhere they appear.
 *
 * Purely controlled — it never calls phoenix_set_paper_reference itself. The
 * caller decides WHEN to persist (at header-create time for a draft-first
 * composer, immediately for an already-existing document), matching that
 * surface's own existing persistence idiom rather than inventing a new one.
 */
import { t } from '@/shared/i18n/strings';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';

export interface PaperReferenceValue {
  number: string;
  date: string;
  authority: string;
}

export const EMPTY_PAPER_REFERENCE: PaperReferenceValue = { number: '', date: '', authority: '' };

interface Props {
  lang: 'ar' | 'en';
  value: PaperReferenceValue;
  onChange: (value: PaperReferenceValue) => void;
  disabled?: boolean;
}

export function PaperReferenceFields({ lang, value, onChange, disabled }: Props) {
  return (
    <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      <PhoenixInput
        label={t('mv_h_paper_reference_number', lang)}
        value={value.number}
        disabled={disabled}
        onChange={e => onChange({ ...value, number: e.target.value })}
      />
      <PhoenixInput
        label={t('mv_h_paper_reference_date', lang)}
        type="date"
        value={value.date}
        disabled={disabled}
        onChange={e => onChange({ ...value, date: e.target.value })}
      />
      <PhoenixInput
        label={t('mv_h_issuing_authority', lang)}
        value={value.authority}
        disabled={disabled}
        onChange={e => onChange({ ...value, authority: e.target.value })}
      />
    </div>
  );
}

/** Read-only one-line summary — "—" when nothing was ever recorded. */
export function paperReferenceSummary(
  pr: { paperReferenceNumber: string | null; paperReferenceDate?: string | null; issuingAuthority?: string | null } | null | undefined,
): string {
  if (!pr || !pr.paperReferenceNumber) return '—';
  const parts = [pr.paperReferenceNumber];
  if (pr.paperReferenceDate) parts.push(pr.paperReferenceDate);
  if (pr.issuingAuthority) parts.push(pr.issuingAuthority);
  return parts.join(' · ');
}
