/**
 * PHARMACY-PULSE-LOADER — "نبض الصيدلة".
 *
 * The MediStock loading indicator: the Bowl of Hygieia with a golden/teal
 * serpent coiling smoothly around the stem, head raised toward the rim, and a
 * soft light pulse at the end of each cycle. Pure inline SVG + CSS — no GIF,
 * no external library, transforms/opacity/stroke only.
 *
 * - `size="full"` for page states, `size="sm"` for buttons/inline.
 * - Reveal is delayed 300ms in CSS (.nexus-pulse) so sub-300ms operations
 *   never flash a loader.
 * - prefers-reduced-motion: the serpent freezes; only a gentle opacity pulse
 *   remains (CSS).
 * - Background tabs: browsers throttle CSS animations automatically; the
 *   shell additionally pauses them via html[data-page-hidden] (see
 *   PhoenixAppShell's visibility marker).
 */
interface Props {
  size?: 'full' | 'sm';
  title?: string;
}

export function PharmacyPulseLoader({ size = 'full', title = '' }: Props) {
  const px = size === 'sm' ? 18 : 56;
  return (
    <span className={`nexus-pulse nexus-pulse--${size}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={px} height={px} role={title ? 'img' : undefined}>
        {title ? <title>{title}</title> : null}
        {/* cycle-end light pulse */}
        <circle className="nexus-pulse__halo" cx="32" cy="30" r="22" fill="none" />
        {/* Bowl of Hygieia: rim, cup and stem */}
        <g className="nexus-pulse__bowl" fill="none" strokeLinecap="round">
          <path d="M18 22 C18 34, 46 34, 46 22" strokeWidth="3" />
          <line x1="16" y1="22" x2="48" y2="22" strokeWidth="3" />
          <line x1="32" y1="33" x2="32" y2="50" strokeWidth="3" />
          <path d="M24 52 C28 50, 36 50, 40 52" strokeWidth="3" />
        </g>
        {/* the serpent: coils around the stem and raises its head to the rim */}
        <path
          className="nexus-pulse__serpent"
          fill="none"
          strokeWidth="2.6"
          strokeLinecap="round"
          d="M26 52 C20 48, 42 46, 38 42 C34 38, 26 40, 28 36 C30 32, 40 34, 42 28 C43.5 24, 41 20, 44 17"
        />
        {/* serpent head */}
        <circle className="nexus-pulse__head" cx="44.6" cy="15.6" r="2.1" />
      </svg>
    </span>
  );
}
