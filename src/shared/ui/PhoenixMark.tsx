/* ─── PHOENIX BRAND MARK ────────────────────────────────────────────────────
   A7.2.4 — compatibility wrapper. PhoenixMark used to render the photographic
   fiery-bird app-icon master in a navy square (A6). The Phoenix Pharmacy
   Emblem global brand rollout retires that raster everywhere it stood for
   app identity — PhoenixSidebar and PhoenixMobileDrawer now render the same
   exact owner-supplied compact-gold raster directly on the dark navigation
   surface. Login/Welcome use the matching full raster.
   ─────────────────────────────────────────────────────────────────────────── */
import { PhoenixPharmacyEmblem } from './PhoenixPharmacyEmblem';

interface PhoenixMarkProps {
  size?: number | string;
  className?: string;
  title?: string;
  /** Retained for API compatibility with the previous raster mark (no visual effect). */
  monochrome?: boolean;
}

export function PhoenixMark({
  size = 44,
  className = '',
  title = 'MediStock Phoenix',
}: PhoenixMarkProps) {
  const numeric = typeof size === 'number' ? size : parseFloat(size) || 44;

  return <PhoenixPharmacyEmblem variant="compact-gold" size={numeric} className={className} title={title} priority />;
}
