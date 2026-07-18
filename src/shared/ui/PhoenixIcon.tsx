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
  | 'clock'
  | 'hospital'
  | 'package'
  | 'ban'
  | 'clipboard'
  | 'mobile'
  | 'print'
  | 'info'
  | 'file'
  | 'refresh'
  | 'trash'
  | 'pin'
  | 'medical'
  | 'recycle'
  | 'bell-off'
  | 'fire'
  | 'camera'
  | 'brain'
  | 'bolt'
  | 'save'
  | 'settings'
  | 'link'
  | 'phone'
  | 'star'
  | 'eye'
  | 'download'
  | 'sparkle'
  | 'globe';

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
    case 'hospital':
      return <P><path d="M4 21V7l8-4 8 4v14M3 21h18" /><path d="M12 8v6m-3-3h6" /></P>;
    case 'package':
      return <P><path d="M12 3 4 7v10l8 4 8-4V7Z" /><path d="m4 7 8 4 8-4M12 11v10" /></P>;
    case 'ban':
      return <P><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></P>;
    case 'clipboard':
      return <P><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 11h6m-6 4h4" /></P>;
    case 'mobile':
      return <P><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></P>;
    case 'print':
      return <P><path d="M7 8V3h10v5M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><rect x="7" y="15" width="10" height="6" /></P>;
    case 'info':
      return <P><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></P>;
    case 'file':
      return <P><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6m-6 4h6" /></P>;
    case 'refresh':
      return <P><path d="M20 11a8 8 0 0 0-14-4L4 9m0-4v4h4m-4 4a8 8 0 0 0 14 4l2-2m0 4v-4h-4" /></P>;
    case 'trash':
      return <P><path d="M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14M10 11v6m4-6v6" /></P>;
    case 'pin':
      return <P><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></P>;
    case 'medical':
      return <P><path d="M12 3v18M8 6l8 12M16 6 8 18" /><circle cx="12" cy="12" r="9" /></P>;
    case 'recycle':
      return <P><path d="M7 19H5a2 2 0 0 1-1.7-3l2-3.5M9 5l1.7-3a2 2 0 0 1 3.4 0l1.6 2.8M17 19h2a2 2 0 0 0 1.7-3l-1-1.8" /><path d="m4.5 12.8 3 .5-1 3M9.5 4.6 8 7.4l3-.4M19.5 14.8l-3 .5 1.2 2.8" /></P>;
    case 'bell-off':
      return <P><path d="M18 9a6 6 0 0 0-9-5.2M6 7c-.4 1-.6 2-.6 2 0 7-3 7-3 9h13M18 15h3c0-2-3-2-3-9M10 21h4" /><path d="m3 3 18 18" /></P>;
    case 'fire':
      return <P><path d="M12 3c1 3-2 4-2 7a2 2 0 0 0 4 0c2 2 3 4 3 6a5 5 0 0 1-10 0c0-4 4-6 5-13Z" /></P>;
    case 'camera':
      return <P><path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.5" /></P>;
    case 'brain':
      return <P><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 5 3 3 0 0 0 5 0V4.5A2.5 2.5 0 0 0 9 4Z" /><path d="M12 4.5A2.5 2.5 0 0 1 15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 5 3 3 0 0 1-5 0" /></P>;
    case 'bolt':
      return <P><path d="M13 3 4 14h6l-1 7 9-11h-6Z" /></P>;
    case 'save':
      return <P><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M8 3v5h7M8 21v-6h8v6" /></P>;
    case 'settings':
      return <P><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.4a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4.4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.2 1Z" /></P>;
    case 'link':
      return <P><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></P>;
    case 'phone':
      return <P><path d="M6 3h3l2 5-2.5 1.5a11 11 0 0 0 5 5L17 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z" /></P>;
    case 'star':
      return <P><path d="m12 3 2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.3 1-5.9L3.5 9.2l5.9-.8Z" /></P>;
    case 'eye':
      return <P><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></P>;
    case 'download':
      return <P><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></P>;
    case 'sparkle':
      return <P><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" /></P>;
    case 'globe':
      return <P><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" /></P>;
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
