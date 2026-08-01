import { PhoenixPharmacyEmblem } from './PhoenixPharmacyEmblem';

interface Props {
  size?: number;
  className?: string;
  /** Accessible name. Pass "" for a decorative mark beside live brand text. */
  title?: string;
}

/**
 * A7.2.4 — compatibility wrapper.
 *
 * MediStockMark used to render its own isometric-cube geometry (A7.2.2). The
 * Phoenix Pharmacy Emblem global brand rollout retires that cube everywhere
 * it stood for app identity. Login and Welcome use the exact full transparent
 * raster supplied by the owner.
 */
export function MediStockMark({ size = 44, className = '', title = 'MediStock Phoenix' }: Props) {
  return <PhoenixPharmacyEmblem variant="full" size={size} className={className} title={title} priority />;
}
