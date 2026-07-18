import { t } from '@/shared/i18n/strings';
import { normalizeWhatsappPhone, buildWhatsappUrl } from '@/shared/lib/whatsapp';
import type { Lang } from '@/shared/lib/types';
import { PhoenixIcon } from './PhoenixIcon';

interface Props {
  /** Real, already-loaded contact phone — never invented, never a constant. */
  phone: string | null | undefined;
  message: string;
  lang: Lang;
  /** Override the visible label (defaults to the generic "WhatsApp" label). */
  label?: string;
}

/**
 * UX-WHATSAPP-INSTITUTION-CONTACT-A
 *
 * Opens a plain wa.me deep link in a new tab so the user's own WhatsApp
 * app/Web can send the prefilled message — nothing is sent automatically,
 * there is no WhatsApp Business/Cloud API call, and no token is stored or
 * transmitted. Renders an honest disabled state when the caller has no
 * usable phone number, distinguishing "not configured" from "invalid".
 */
export function WhatsAppContactButton({ phone, message, lang, label }: Props) {
  const hasRaw = !!phone && phone.trim().length > 0;
  const digits = hasRaw ? normalizeWhatsappPhone(phone) : '';
  const valid = digits.length > 0;

  if (!valid) {
    const reasonKey = hasRaw ? 'wa_invalid_number' : 'wa_number_missing';
    return (
      <span
        role="note"
        aria-label={t(reasonKey, lang)}
        title={t(reasonKey, lang)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '7px 12px', minHeight: '38px', borderRadius: 'var(--r2)',
          border: '1px dashed var(--brd)', background: 'var(--s2)', color: 'var(--t3)',
          fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap',
        }}
      >
        <PhoenixIcon name="phone" size={15} aria-hidden="true" />
        <span>{t(reasonKey, lang)}</span>
      </span>
    );
  }

  const url = buildWhatsappUrl(phone, message);
  const visibleLabel = label ?? t('wa_contact', lang);

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={visibleLabel}
      className="premium-focus-ring"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '7px 12px', minHeight: '38px', borderRadius: 'var(--r2)',
        border: '1px solid #25D366', background: '#e9fbf1', color: '#0d7a3f',
        fontSize: '11.5px', fontWeight: 700, whiteSpace: 'nowrap',
        textDecoration: 'none', cursor: 'pointer',
      }}
    >
      <PhoenixIcon name="phone" size={15} aria-hidden="true" />
      <span>{visibleLabel}</span>
    </a>
  );
}
