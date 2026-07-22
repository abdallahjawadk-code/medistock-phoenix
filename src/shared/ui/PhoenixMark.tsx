/* ─── PHOENIX BRAND MARK ────────────────────────────────────────────────────
   The small identity mark is the APPROVED app-icon master itself, re-encoded to
   optimized runtime sizes (see scripts/phoenix-runtime-icons.mjs). It is NOT a
   hand-drawn SVG or a pale generic bird — it is the same fiery/gold Phoenix with
   the teal medical emblem that the Login/Welcome hero art uses, so the identity
   is consistent from the 34px loading preview up to the full cinematic plate.
   Source: design/phoenix-source/phoenix-app-icon-master.png (2048², navy safe-zone).
   ─────────────────────────────────────────────────────────────────────────── */

interface PhoenixMarkProps {
  size?: number | string;
  className?: string;
  title?: string;
  /** Retained for API compatibility with the previous SVG mark (no visual effect). */
  monochrome?: boolean;
}

export function PhoenixMark({
  size = 44,
  className = '',
  title = 'MediStock Phoenix',
}: PhoenixMarkProps) {
  const dim = typeof size === 'number' ? `${size}px` : size;
  const numeric = typeof size === 'number' ? size : undefined;

  return (
    <picture>
      <source srcSet="/assets/phoenix/runtime/phoenix-icon-256.avif" type="image/avif" />
      <source srcSet="/assets/phoenix/runtime/phoenix-icon-256.webp" type="image/webp" />
      <img
        className={className}
        src="/assets/phoenix/runtime/phoenix-icon-256.png"
        alt={title || ''}
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        width={numeric}
        height={numeric}
        style={{ width: dim, height: dim, objectFit: 'contain', display: 'block', borderRadius: '22%' }}
        decoding="async"
        loading="eager"
        draggable={false}
      />
    </picture>
  );
}
