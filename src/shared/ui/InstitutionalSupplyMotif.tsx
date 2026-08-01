interface Props {
  className?: string;
}

/**
 * A7.2.1 — original, lightweight institutional supply-network illustration.
 *
 * Replaces the photographic Phoenix-bird hero art on Login/Welcome with an
 * isometric-style node-and-route composition representing the medicine
 * supply fabric itself: a central distribution hub connected to a warehouse,
 * a hospital, and a pharmacy/outlet, plus a delivery-route accent — pure
 * inline SVG, no image asset, no new dependency. Each building is a flat-
 * isometric "box" (a top rhombus + two shaded side faces, the standard
 * technique flat illustration uses to read as 3D without true rendering),
 * topped with a small circular icon badge reusing existing icon path data.
 * Every colour is a CSS custom property read from the surrounding daylight
 * token scope (see phase-a-auth-welcome-signature.css) — face shading is
 * done with opacity steps on that ONE colour per element, so it re-themes
 * with light/dark for free; the only per-element authoring here is
 * layout/geometry.
 *
 * Purely decorative (aria-hidden) — the accessible label lives on the
 * caller's own heading, exactly as the previous photographic hero did.
 *
 * All geometry sits inside the UPPER portion of the 960×600 viewBox
 * (roughly y∈[110,300]) for two reasons: `preserveAspectRatio="xMidYMid
 * slice"` keeps every element in frame across both the tall-ish Login art
 * panel and Welcome's much wider letterbox hero instead of amputating one
 * the way an object-fit:cover photograph could, AND Login's own caption
 * (kicker/heading/trust-row) is absolutely positioned over the LOWER part
 * of this same panel — keeping the composition's content out of that band
 * avoids an element ever sitting behind the caption text.
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
          <stop offset="0%" stopColor="var(--phoenix-gold)" stopOpacity=".24" />
          <stop offset="100%" stopColor="var(--phoenix-gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="motif-glow-teal" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity=".18" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>

        <symbol id="motif-icon-warehouse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21V9l9-5 9 5v12M7 21v-8h10v8M7 16h10" />
        </symbol>
        <symbol id="motif-icon-hospital" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 21V7l8-4 8 4v14M3 21h18" />
          <path d="M12 8v6m-3-3h6" />
        </symbol>
        <symbol id="motif-icon-outlet" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 10h16l-1-5H5Zm1 0v10h14V10M9 20v-6h6v6" />
          <path d="M7 10a3 3 0 0 0 5 0 3 3 0 0 0 5 0" />
        </symbol>
        <symbol id="motif-icon-package" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 4 7v10l8 4 8-4V7Z" />
          <path d="m4 7 8 4 8-4M12 11v10" />
        </symbol>
        <symbol id="motif-icon-truck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 6h11v10H2z" />
          <path d="M13 9h3l3 3v4h-6" />
          <circle cx="6.5" cy="17.4" r="2" />
          <circle cx="16.5" cy="17.4" r="2" />
        </symbol>
      </defs>

      {/* soft depth glows — static gradients, zero animation cost */}
      <circle cx="480" cy="220" r="280" fill="url(#motif-glow-gold)" />
      <circle cx="250" cy="170" r="180" fill="url(#motif-glow-teal)" />
      <circle cx="710" cy="170" r="180" fill="url(#motif-glow-teal)" />

      {/* slow orbit ring around the hub — a single restrained living touch */}
      <circle className="phoenix-supply-motif__orbit" cx="480" cy="205" r="98" />

      {/* routes — curved, direction-agnostic (never a literal left/right cue) */}
      <path className="phoenix-supply-motif__route" d="M280,158 C 350,140 400,155 432,182" />
      <path className="phoenix-supply-motif__route" d="M680,158 C 610,140 560,155 528,182" />
      <path className="phoenix-supply-motif__route" d="M480,232 C 480,250 480,262 480,272" />

      {/* ── isometric buildings: top rhombus + two shaded side faces ───────── */}

      {/* warehouse (upper-left) */}
      <g className="phoenix-supply-motif__iso phoenix-supply-motif__iso--warehouse">
        <ellipse className="phoenix-supply-motif__iso-shadow" cx="250" cy="192" rx="46" ry="9" />
        <path className="phoenix-supply-motif__iso-left" d="M222,150 L250,165 L250,191 L222,176 Z" />
        <path className="phoenix-supply-motif__iso-right" d="M250,165 L278,150 L278,176 L250,191 Z" />
        <path className="phoenix-supply-motif__iso-top" d="M250,136 L278,150 L250,165 L222,150 Z" />
        <g className="phoenix-supply-motif__badge" transform="translate(250,136)">
          <circle r="19" />
          <use href="#motif-icon-warehouse" x="-11" y="-11" width="22" height="22" />
        </g>
      </g>

      {/* hospital (upper-right) */}
      <g className="phoenix-supply-motif__iso phoenix-supply-motif__iso--hospital">
        <ellipse className="phoenix-supply-motif__iso-shadow" cx="710" cy="192" rx="46" ry="9" />
        <path className="phoenix-supply-motif__iso-left" d="M682,150 L710,165 L710,191 L682,176 Z" />
        <path className="phoenix-supply-motif__iso-right" d="M710,165 L738,150 L738,176 L710,191 Z" />
        <path className="phoenix-supply-motif__iso-top" d="M710,136 L738,150 L710,165 L682,150 Z" />
        <g className="phoenix-supply-motif__badge" transform="translate(710,136)">
          <circle r="19" />
          <use href="#motif-icon-hospital" x="-11" y="-11" width="22" height="22" />
        </g>
      </g>

      {/* central distribution hub — largest, gold, drawn BEFORE pharmacy so
          its routes/glow/shadow sit beneath the network, never overlapping
          the pharmacy building placed further down the same vertical line */}
      <g className="phoenix-supply-motif__iso phoenix-supply-motif__iso--hub">
        <ellipse className="phoenix-supply-motif__iso-shadow" cx="480" cy="252" rx="66" ry="9" />
        <path className="phoenix-supply-motif__iso-left" d="M430,181 L480,208 L480,251 L430,224 Z" />
        <path className="phoenix-supply-motif__iso-right" d="M480,208 L530,181 L530,224 L480,251 Z" />
        <path className="phoenix-supply-motif__iso-top" d="M480,155 L530,181 L480,208 L430,181 Z" />
        <g className="phoenix-supply-motif__badge phoenix-supply-motif__badge--hub" transform="translate(480,155)">
          <circle r="26" />
          <use href="#motif-icon-package" x="-14" y="-14" width="28" height="28" />
        </g>
      </g>

      {/* pharmacy / dispensing outlet (bottom-centre, clearly separated below
          the hub's own shadow — not stacked directly against it) */}
      <g className="phoenix-supply-motif__iso phoenix-supply-motif__iso--outlet">
        <ellipse className="phoenix-supply-motif__iso-shadow" cx="480" cy="346" rx="46" ry="9" />
        <path className="phoenix-supply-motif__iso-left" d="M452,304 L480,319 L480,345 L452,330 Z" />
        <path className="phoenix-supply-motif__iso-right" d="M480,319 L508,304 L508,330 L480,345 Z" />
        <path className="phoenix-supply-motif__iso-top" d="M480,290 L508,304 L480,319 L452,304 Z" />
        <g className="phoenix-supply-motif__badge" transform="translate(480,290)">
          <circle r="19" />
          <use href="#motif-icon-outlet" x="-11" y="-11" width="22" height="22" />
        </g>
      </g>

      {/* small delivery-route accent — a static truck riding the warehouse
          corridor, reading as motion without adding a third animation */}
      <g className="phoenix-supply-motif__truck" transform="translate(352,152)">
        <circle r="17" />
        <use href="#motif-icon-truck" x="-10" y="-9" width="20" height="20" />
      </g>
    </svg>
  );
}
