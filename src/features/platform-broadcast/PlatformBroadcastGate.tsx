import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import {
  getPendingPlatformBroadcasts, acknowledgePlatformBroadcast,
  type PendingBroadcast, type BroadcastSeverity,
} from '@/shared/supabase/services/platform-broadcast.service';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';

const SEVERITY_BADGE: Record<BroadcastSeverity, 'info' | 'warn' | 'err'> = {
  info: 'info',
  warning: 'warn',
  important: 'warn',
  urgent: 'err',
};

function formatPublishDate(iso: string, lang: 'ar' | 'en'): string {
  try {
    return new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Super Admin-only writes happen through PlatformBroadcastAdminPanel; this
 * component is the read/acknowledge side, mounted once as a sibling inside
 * PhoenixAppShell (migration 056, PHASE3-PLATFORM-BROADCAST-NOTICES-A).
 * PhoenixAppShell only ever wraps authenticated screens — PublicQrScreen has
 * its own separate route tree — so this component structurally never mounts
 * on the public QR page; no extra check is needed for that.
 *
 * Fetches pending broadcasts exactly once per session, gated on
 * authReady/session/profile/activeOrgId all being resolved (the same point
 * AppContext itself uses for "run once after login"). Shows at most one
 * modal at a time from a client-side queue; acknowledging removes it and
 * reveals the next, if any. No "later"/dismiss button by design — the whole
 * point of institution-level acknowledgement tracking is that Super Admin
 * can see who has and hasn't seen it, so a silent dismiss would defeat that.
 */
export function PlatformBroadcastGate() {
  const { authReady, session, profile, activeOrgId, lang } = useApp();

  const [queue, setQueue] = useState<PendingBroadcast[]>([]);
  const [fetched, setFetched] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState(false);

  const ready = authReady && !!session && !!profile && !!activeOrgId;

  useEffect(() => {
    if (!ready || fetched) return;
    let active = true;
    setFetched(true);
    getPendingPlatformBroadcasts()
      .then(res => {
        if (!active) return;
        if (res.ok) setQueue(res.broadcasts);
      })
      .catch((err: unknown) => {
        console.error('[phoenix] getPendingPlatformBroadcasts failed:', err);
      });
    return () => { active = false; };
  }, [ready, fetched]);

  if (!ready || queue.length === 0) return null;

  const current = queue[0];

  async function onAcknowledge() {
    setAckBusy(true);
    setAckError(false);
    try {
      const res = await acknowledgePlatformBroadcast(current.id);
      if (!res.ok) {
        setAckError(true);
        return;
      }
      setQueue(q => q.slice(1));
    } catch (err) {
      console.error('[phoenix] acknowledgePlatformBroadcast failed:', err);
      setAckError(true);
    } finally {
      setAckBusy(false);
    }
  }

  return (
    <PhoenixDialog open onClose={() => { /* no dismiss without acknowledging, by design */ }} title={t('pbc_popup_title', lang)} maxWidth={480}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <PhoenixStatusBadge variant={SEVERITY_BADGE[current.severity]} label={t(`pbc_severity_${current.severity}`, lang)} />
        <span style={{ fontSize: '11px', color: 'var(--t2)' }}>
          {t('pbc_published_on', lang)} {formatPublishDate(current.publish_at, lang)}
        </span>
      </div>

      <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px' }} dir="auto">
        {current.title}
      </h3>
      <p style={{ fontSize: '13px', color: 'var(--t2)', whiteSpace: 'pre-wrap', marginBottom: '16px' }} dir="auto">
        {current.body}
      </p>

      {ackError && (
        <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '10px' }} dir="auto">
          {t('pbc_ack_failed', lang)}
        </p>
      )}

      <PhoenixButton variant="primary" size="md" fullWidth loading={ackBusy} onClick={onAcknowledge}>
        {t('pbc_acknowledge_button', lang)}
      </PhoenixButton>
    </PhoenixDialog>
  );
}
