import compactGold from '@/assets/brand/phoenix-pharmacy/phoenix-pharmacy-compact-gold.png';
import compactTeal from '@/assets/brand/phoenix-pharmacy/phoenix-pharmacy-compact-teal.png';
import full from '@/assets/brand/phoenix-pharmacy/phoenix-pharmacy-full.png';

/** Exact owner-supplied raster crops. No path drawing, recolouring, or CSS art. */
export type PhoenixPharmacyEmblemVariant = 'full' | 'compact-gold' | 'compact-teal';

interface Props {
  variant?: PhoenixPharmacyEmblemVariant;
  size?: number;
  decorative?: boolean;
  className?: string;
  priority?: boolean;
  /** Accessible name. Existing wrappers pass an empty string beside live brand text. */
  title?: string;
}

const ASSETS = {
  full: { src: full, width: 783, height: 622 },
  'compact-gold': { src: compactGold, width: 219, height: 185 },
  'compact-teal': { src: compactTeal, width: 218, height: 184 },
} as const;

export function PhoenixPharmacyEmblem({
  variant = 'full',
  size = 80,
  decorative,
  className = '',
  priority = false,
  title = '',
}: Props) {
  const asset = ASSETS[variant];
  const isDecorative = decorative ?? title.trim().length === 0;

  return (
    <img
      className={`phoenix-pharmacy-emblem phoenix-pharmacy-emblem--${variant} ${className}`.trim()}
      src={asset.src}
      alt={isDecorative ? '' : title}
      aria-hidden={isDecorative ? true : undefined}
      role={isDecorative ? undefined : 'img'}
      width={size}
      height={size}
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      draggable={false}
      data-source-width={asset.width}
      data-source-height={asset.height}
    />
  );
}

export default PhoenixPharmacyEmblem;
