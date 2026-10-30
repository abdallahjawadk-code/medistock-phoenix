import { useId } from 'react';

/** Decorative pharmacy sculpture. It never represents item identity, progress,
 * stock, approval, or dosage. The existing owner-supplied emblem stays intact. */
export function PharmaSculpture({ className = '' }: { className?: string }) {
  const id = `pharma-${useId().replace(/:/g, '')}`;
  return (
    <svg className={`pharma-sculpture ${className}`} viewBox="0 0 240 160" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-shell`} x1="64" y1="35" x2="154" y2="142" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--pharma-sculpture-highlight)" /><stop offset=".18" stopColor="var(--pharma-sculpture-green)" />
          <stop offset=".52" stopColor="var(--pharma-sculpture-deep)" /><stop offset=".8" stopColor="var(--pharma-sculpture-green)" /><stop offset="1" stopColor="var(--pharma-sculpture-deep)" />
        </linearGradient>
        <linearGradient id={`${id}-ivory`} x1="105" y1="75" x2="180" y2="150" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--pharma-sculpture-white)" /><stop offset=".56" stopColor="var(--pharma-sculpture-ivory)" /><stop offset="1" stopColor="var(--pharma-sculpture-shade)" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="80" y1="38" x2="138" y2="115" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--pharma-sculpture-white)" stopOpacity=".9" /><stop offset="1" stopColor="var(--pharma-sculpture-white)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-bead`}>
          <stop stopColor="var(--pharma-sculpture-white)" /><stop offset=".6" stopColor="var(--pharma-sculpture-ivory)" /><stop offset="1" stopColor="var(--pharma-sculpture-shade)" />
        </radialGradient>
      </defs>
      <g className="pharma-sculpture__molecule" stroke="currentColor" strokeWidth="1.4" opacity=".5">
        <path d="m154 24 24 16 28-9 17 24-8 30-30 5-19-23 12-27m-12 27-31 5-15-22m65 40 4 30-27 18" />
        {[ [154,24],[178,40],[206,31],[223,55],[215,85],[185,90],[166,67],[135,72],[120,50],[189,120],[162,138] ].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r={i%3===0?5:3} fill="var(--pharma-molecule-node)" />)}
      </g>
      <ellipse className="pharma-sculpture__shadow" cx="111" cy="139" rx="77" ry="8" fill="var(--pharma-sculpture-shadow)" opacity=".15" />
      <g className="pharma-sculpture__capsule" transform="rotate(-34 108 82)">
        <rect x="30" y="50" width="160" height="65" rx="32.5" fill={`url(#${id}-ivory)`} stroke="var(--pharma-sculpture-shade)" />
        <path d="M110 50H62.5a32.5 32.5 0 0 0 0 65H110V50Z" fill={`url(#${id}-shell)`} />
        <path d="M64 55h46v54H64a27 27 0 0 1 0-54Z" stroke="var(--pharma-sculpture-white)" strokeOpacity=".3" />
        <path d="M55 59h105c14 0 20 9 20 14H44c0-5 4-11 11-14Z" fill={`url(#${id}-shine)`} />
        <path d="M110 51v63" stroke="var(--pharma-sculpture-shade)" strokeWidth="2" />
        {[ [126,84],[143,91],[155,79],[166,94],[127,100],[147,105],[173,82] ].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="6" fill={`url(#${id}-bead)`} opacity=".65" />)}
      </g>
    </svg>
  );
}
