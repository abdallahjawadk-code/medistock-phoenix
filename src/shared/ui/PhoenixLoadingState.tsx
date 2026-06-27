interface Props { label?: string; }

export function PhoenixLoadingState({ label = '...' }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '48px 24px', color: 'var(--t2)' }}>
      <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '3px solid var(--brd)', borderTopColor: 'var(--p)', animation: 'spin .8s linear infinite' }} />
      <span style={{ fontSize: '12.5px' }}>{label}</span>
    </div>
  );
}
