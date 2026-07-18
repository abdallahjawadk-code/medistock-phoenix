import { useId } from 'react';

interface PhoenixMarkProps {
  size?: number | string;
  className?: string;
  title?: string;
  monochrome?: boolean;
}

export function PhoenixMark({
  size = 44,
  className = '',
  title = 'MediStock Phoenix',
  monochrome = false,
}: PhoenixMarkProps) {
  const uid = useId().replace(/:/g, '');
  const fireId = `phoenix-fire-${uid}`;
  const emberId = `phoenix-ember-${uid}`;
  const haloId = `phoenix-halo-${uid}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={fireId} x1="18" y1="16" x2="77" y2="82" gradientUnits="userSpaceOnUse">
          <stop stopColor={monochrome ? 'currentColor' : '#FFE4A3'} />
          <stop offset=".32" stopColor={monochrome ? 'currentColor' : '#F6B64A'} />
          <stop offset=".68" stopColor={monochrome ? 'currentColor' : '#F26A21'} />
          <stop offset="1" stopColor={monochrome ? 'currentColor' : '#C82D31'} />
        </linearGradient>
        <linearGradient id={emberId} x1="49" y1="31" x2="49" y2="79" gradientUnits="userSpaceOnUse">
          <stop stopColor={monochrome ? 'currentColor' : '#63F0E1'} />
          <stop offset="1" stopColor={monochrome ? 'currentColor' : '#0BAE9C'} />
        </linearGradient>
        <radialGradient id={haloId}>
          <stop stopColor={monochrome ? 'currentColor' : '#F6B64A'} stopOpacity=".32" />
          <stop offset="1" stopColor={monochrome ? 'currentColor' : '#F6B64A'} stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="48" cy="48" r="44" fill={`url(#${haloId})`} opacity={monochrome ? 0 : 1} />
      <path
        d="M46.8 13.2c4.8 7.2 5.4 13.2 1.9 18.1 7.4-2.4 14.2-1.1 20.4 3.9-8.7.5-14.4 3.1-17.1 7.8 8.8-2.1 17.6-.1 26.4 6-9.8 1-17.5 4.3-23.2 10 7.5-.3 14 1.8 19.6 6.4-10.2.8-18 4.2-23.6 10.2L48 82l-3.2-6.4C39.2 69.6 31.4 66.2 21.2 65.4c5.6-4.6 12.1-6.7 19.6-6.4-5.7-5.7-13.4-9-23.2-10 8.8-6.1 17.6-8.1 26.4-6-2.7-4.7-8.4-7.3-17.1-7.8 6.2-5 13-6.3 20.4-3.9-3.5-4.9-2.9-10.9 1.9-18.1Z"
        fill={`url(#${fireId})`}
        stroke={monochrome ? 'currentColor' : 'rgba(255,236,188,.74)'}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M48 32.5c-5.8 8.3-7.6 15-5.4 20.1-3.6 3.8-4.5 8.4-2.7 13.8L48 82l8.1-15.6c1.8-5.4.9-10-2.7-13.8 2.2-5.1.4-11.8-5.4-20.1Z"
        fill={`url(#${emberId})`}
        stroke={monochrome ? 'currentColor' : 'rgba(191,255,247,.62)'}
        strokeWidth="1.1"
      />
      <path d="M31 49.7c5 1.8 9.4 4.4 13.1 8M65 49.7c-5 1.8-9.4 4.4-13.1 8" stroke="rgba(255,247,226,.78)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="48" cy="45.5" r="2.15" fill={monochrome ? 'currentColor' : '#FFF4D7'} />
    </svg>
  );
}
