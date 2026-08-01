interface Props {
  size?: number;
  className?: string;
  /** Accessible name. Pass "" for a decorative mark beside live brand text. */
  title?: string;
}

/**
 * A7.2.2 — MediStock geometric brand mark.
 *
 * The identity mark for the Login and Welcome surfaces. It replaces the
 * photographic Phoenix-bird app icon there, per the reference board's
 * requirement that the auth identity be an institutional geometric mark
 * rather than a bird.
 *
 * The form is an isometric medicine consignment — the same solid the hero
 * scene builds its world from — carrying a medical cross on its lit top
 * face: "MediStock" stated literally as medicine + stock, in the phase's
 * own teal/gold institutional palette. Original geometry, no third-party
 * logo, no bird, no raster asset, and legible down to ~20px.
 *
 * The product NAME remains "MediStock Phoenix" as live text beside it —
 * only the visual mark changes.
 *
 * Scope: Login and Welcome only. PhoenixSidebar and PhoenixMobileDrawer
 * deliberately keep PhoenixMark, so the wider application's identity is
 * untouched by this pass.
 */
export function MediStockMark({ size = 44, className = '', title = 'MediStock Phoenix' }: Props) {
  return (
    <svg
      className={`medistock-mark ${className}`.trim()}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}

      {/* consignment solid — one colour per face, lit from above-left */}
      <polygon className="medistock-mark__left"  points="6,16 24,25 24,41 6,32" />
      <polygon className="medistock-mark__right" points="24,25 42,16 42,32 24,41" />
      <polygon className="medistock-mark__top"   points="24,7 42,16 24,25 6,16" />

      {/* medical cross on the lit face */}
      <g className="medistock-mark__cross">
        <polygon points="17.5,10.25 35.5,19.25 30.5,21.75 12.5,12.75" />
        <polygon points="30.5,10.25 35.5,12.75 17.5,21.75 12.5,19.25" />
      </g>
    </svg>
  );
}
