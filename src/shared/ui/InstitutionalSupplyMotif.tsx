interface Props {
  className?: string;
}

/**
 * A7.2 — original, lightweight institutional supply-network illustration.
 *
 * Replaces the photographic Phoenix-bird hero art on Login/Welcome with an
 * abstract node-and-route composition representing the medicine supply
 * fabric itself (central distribution ↔ hospital ↔ dispensing outlet) —
 * pure inline SVG, no image asset, no new dependency. Every colour is a CSS
 * custom property read from the surrounding daylight token scope (see
 * phase-a-auth-welcome-signature.css), so it re-themes with light/dark like
 * everything else; the only per-element authoring here is layout/geometry.
 *
 * Purely decorative (aria-hidden) — the accessible label lives on the
 * caller's own heading, exactly as the previous photographic hero did.
 *
 * All three nodes sit inside the UPPER portion of the 960×600 viewBox
 * (roughly y∈[140,290]) for two reasons: `preserveAspectRatio="xMidYMid
 * slice"` keeps every node in frame across both the tall-ish Login art
 * panel and Welcome's much wider letterbox hero instead of amputating one
 * the way an object-fit:cover photograph could, AND Login's own caption
 * (kicker/heading/trust-row) is absolutely positioned over the LOWER part
 * of this same panel — keeping the composition's content out of that band
 * avoids a node ever sitting behind the caption text.
 */
export function InstitutionalSupplyMotif({ className = '' }: Props) {
  return (
    <svg
      className={`phoenix-supply-motif ${className}`.trim()}
      viewBox="0 0 960 600"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="motif-glow-gold" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--phoenix-gold)" stopOpacity=".22" />
          <stop offset="100%" stopColor="var(--phoenix-gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="motif-glow-teal" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity=".16" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
        <symbol id="motif-icon-warehouse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21V9l9-5 9 5v12M7 21v-8h10v8M7 16h10" />
        </symbol>
        <symbol id="motif-icon-hospital" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 21V7l8-4 8 4v14M3 21h18" />
          <path d="M12 8v6m-3-3h6" />
        </symbol>
        <symbol id="motif-icon-hub" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18M8 6l8 12M16 6 8 18" />
          <circle cx="12" cy="12" r="9" />
        </symbol>
      </defs>

      {/* soft depth glows — static gradients, zero animation cost */}
      <circle cx="480" cy="230" r="260" fill="url(#motif-glow-gold)" />
      <circle cx="210" cy="195" r="170" fill="url(#motif-glow-teal)" />
      <circle cx="750" cy="195" r="170" fill="url(#motif-glow-teal)" />

      {/* slow orbit ring around the hub — a single restrained living touch */}
      <circle className="phoenix-supply-motif__orbit" cx="480" cy="230" r="92" />

      {/* routes — curved, direction-agnostic (never a literal left/right cue) */}
      <path className="phoenix-supply-motif__route" d="M240,192 C 320,158 380,182 420,208" />
      <path className="phoenix-supply-motif__route" d="M720,192 C 640,158 580,182 540,208" />

      {/* satellites */}
      <g className="phoenix-supply-motif__node phoenix-supply-motif__node--warehouse" transform="translate(210,195)">
        <circle r="38" />
        <use href="#motif-icon-warehouse" x="-16" y="-16" width="32" height="32" />
      </g>
      <g className="phoenix-supply-motif__node phoenix-supply-motif__node--hospital" transform="translate(750,195)">
        <circle r="38" />
        <use href="#motif-icon-hospital" x="-16" y="-16" width="32" height="32" />
      </g>

      {/* hub — largest, gold, drawn last so its routes/glow sit beneath it */}
      <g className="phoenix-supply-motif__node phoenix-supply-motif__node--hub" transform="translate(480,230)">
        <circle r="54" />
        <use href="#motif-icon-hub" x="-22" y="-22" width="44" height="44" />
      </g>
    </svg>
  );
}
