import { CSSProperties, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  hover?: boolean;
  padding?: string;
  shadow?: 'xs' | 'sm' | 'md' | 'lg';
  border?: string;
}

export function PhoenixCard({
  children, className = '', style, onClick, hover = false,
  padding = '18px', shadow = 'sm', border,
}: Props) {
  const baseStyle: CSSProperties = {
    background: 'var(--s)',
    borderRadius: 'var(--r4)',
    padding,
    boxShadow: `var(--sh-${shadow})`,
    border: border ?? '1px solid var(--brd)',
    transition: hover ? 'all 180ms' : undefined,
    cursor: onClick ? 'pointer' : undefined,
    ...style,
  };

  return (
    <div
      className={`phoenix-card premium-depth-card ${hover ? 'premium-3d-hover' : ''} ${className}`}
      style={baseStyle}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
