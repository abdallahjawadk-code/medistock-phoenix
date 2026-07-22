/* ─── MASAR COPYRIGHT SEAL ───────────────────────────────────────────────────
   Global copyright branding. The square emblem is the APPROVED MASAR master
   (design/phoenix-source/masar-copyright-master.png), re-encoded to optimized
   runtime sizes — never repainted, traced, stretched or cropped, and its navy
   background is preserved in BOTH themes. The emblem is decorative (empty alt);
   the LIVE text beside it carries the legible, accessible copyright so we never
   depend on tiny baked-in image text.

   Variants:
   • compact — authenticated operational shell (emblem + two-line credit).
   • credit  — Login / Welcome credit areas (emblem + two-line credit).
   • minimal — mobile / constrained / full-screen state surfaces (emblem + © line).

   The whole region is one labelled group so assistive tech announces it once, not
   per card. pointer-events are disabled so it never blocks app controls; it holds
   no focus. The optional metallic sheen is one-shot and CSS-gated off under
   prefers-reduced-motion (static presentation is the default look).
   ─────────────────────────────────────────────────────────────────────────── */

export type MasarSealVariant = 'compact' | 'credit' | 'minimal';

interface Props {
  variant?: MasarSealVariant;
  className?: string;
}

const R = '/assets/phoenix/runtime';
const AVIF = `${R}/masar-seal-128.avif 128w, ${R}/masar-seal-256.avif 256w, ${R}/masar-seal-512.avif 512w`;
const WEBP = `${R}/masar-seal-128.webp 128w, ${R}/masar-seal-256.webp 256w, ${R}/masar-seal-512.webp 512w`;

/** Rendered emblem box (px). Kept large enough that the mark never degrades to a blob. */
const MARK_PX: Record<MasarSealVariant, number> = {
  compact: 40,
  credit: 52,
  minimal: 34,
};

export function MasarCopyrightSeal({ variant = 'compact', className = '' }: Props) {
  const px = MARK_PX[variant];

  return (
    <div
      className={`masar-seal masar-seal--${variant} ${className}`.trim()}
      role="group"
      aria-label="MASAR copyright — PH. Abdallahjawadk, 2026"
    >
      <span className="masar-seal__emblem" aria-hidden="true">
        <picture>
          <source type="image/avif" srcSet={AVIF} sizes={`${px}px`} />
          <source type="image/webp" srcSet={WEBP} sizes={`${px}px`} />
          <img
            className="masar-seal__mark"
            src={`${R}/masar-seal-256.png`}
            alt=""
            width={px}
            height={px}
            decoding="async"
            loading="lazy"
            draggable={false}
          />
        </picture>
        <span className="masar-seal__sheen" aria-hidden="true" />
      </span>
      {variant === 'minimal' ? (
        <span className="masar-seal__text">
          <span className="masar-seal__year">© 2026 · MASAR</span>
        </span>
      ) : (
        <span className="masar-seal__text">
          <span className="masar-seal__name">MASAR · PH. Abdallahjawadk</span>
          <span className="masar-seal__year">© 2026</span>
        </span>
      )}
    </div>
  );
}

export default MasarCopyrightSeal;
