import type { ReactNode, SVGProps } from 'react';

export type PhoenixIconName =
  | 'institutions'
  | 'status'
  | 'reports'
  | 'alerts'
  | 'users'
  | 'network'
  | 'editor'
  | 'account'
  | 'role'
  | 'logout'
  | 'menu'
  | 'close'
  | 'sun'
  | 'moon'
  | 'search'
  | 'qr'
  | 'command'
  | 'warehouse'
  | 'outlet'
  | 'route'
  | 'scope'
  | 'warning'
  | 'key'
  | 'mail'
  | 'lock'
  | 'check'
  | 'clock';

interface PhoenixIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: PhoenixIconName;
  size?: number;
  title?: string;
}

const P = ({ children }: { children: ReactNode }) => <>{children}</>;

function iconPaths(name: PhoenixIconName): ReactNode {
  switch (name) {
    case 'institutions':
      return <P><path d="M3 20h18M5 20V9h14v11M3 9l9-5 9 5M8 12v5m4-5v5m4-5v5" /></P>;
    case 'status':
      return <P><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h5m-5 4h3" /><path d="m15 16 1.5 1.5L20 14" /></P>;
    case 'reports':
      return <P><path d="M4 20V10m5 10V4m6 16v-7m5 7V7" /><path d="M3 20h18" /></P>;
    case 'alerts':
      return <P><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></P>;
    case 'users':
      return <P><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></P>;
    case 'network':
      return <P><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M10.7 7.2 6.3 15.8m7-8.6 4.4 8.6M7.5 18h9" /></P>;
    case 'editor':
      return <P><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" /></P>;
    case 'account':
      return <P><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></P>;
    case 'role':
      return <P><path d="M12 3 4 6v5c0 5.25 3.4 8.55 8 10 4.6-1.45 8-4.75 8-10V6Z" /><path d="m9 12 2 2 4-5" /></P>;
    case 'logout':
      return <P><path d="M10 17l5-5-5-5m5 5H3" /><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></P>;
    case 'menu':
      return <P><path d="M4 7h16M4 12h16M4 17h16" /></P>;
    case 'close':
      return <P><path d="M6 6l12 12M18 6 6 18" /></P>;
    case 'sun':
      return <P><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></P>;
    case 'moon':
      return <P><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></P>;
    case 'search':
      return <P><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></P>;
    case 'qr':
      return <P><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zm4 4h3v3h-3zm0-4h3m-7 7h3" /></P>;
    case 'command':
      return <P><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" /></P>;
    case 'warehouse':
      return <P><path d="M3 21V9l9-5 9 5v12M7 21v-8h10v8M7 16h10" /></P>;
    case 'outlet':
      return <P><path d="M4 10h16l-1-5H5Zm1 0v10h14V10M9 20v-6h6v6" /><path d="M7 10a3 3 0 0 0 5 0 3 3 0 0 0 5 0" /></P>;
    case 'route':
      return <P><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6h3a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4H9a3 3 0 0 0-3 3v1" /></P>;
    case 'scope':
      return <P><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></P>;
    case 'warning':
      return <P><path d="M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></P>;
    case 'key':
      return <P><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-3 3 2 2m-5 1 2 2" /></P>;
    case 'mail':
      return <P><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></P>;
    case 'lock':
      return <P><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></P>;
    case 'check':
      return <P><path d="m5 12 4 4L19 6" /></P>;
    case 'clock':
      return <P><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></P>;
  }
}

export function PhoenixIcon({ name, size = 20, title, ...props }: PhoenixIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title && <title>{title}</title>}
      {iconPaths(name)}
    </svg>
  );
}
