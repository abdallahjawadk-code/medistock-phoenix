import { useEffect, useRef, useState } from 'react';
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
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState(false);

  // FIX-PLATFORM-BROADCAST-GATE-NOT-FETCHING-A: the fetch-guard lives in a
  // ref, not React state. A state-based guard (`fetched` set via
  // setFetched(true) inside the same effect that reads it) can only be
  // trusted to prevent a second fetch — it does nothing to guarantee the
  // FIRST fetch fires, since that still depends on the effect's dependency
  // array actually re-running when profile/activeOrgId resolve. Keying the
  // effect off the individual primitives below (rather than a single
  // pre-computed `ready` boolean recomputed inline every render) makes the
  // "did the inputs that matter change" check unambiguous, and the ref
  // guard is synchronous — no risk of two effect runs in the same tick both
  // seeing a stale "not yet fetched" state.
  const hasFetchedRef = useRef(false);

  const sessionUserId = session?.user?.id ?? null;
  const profileId = profile?.id ?? null;
  const ready = authReady && !!sessionUserId && !!profileId && !!activeOrgId;

  useEffect(() => {
    if (!authReady || !sessionUserId) return;

    // DIAGNOSTIC-VISIBLE-BEHAVIOR-A: profile has loaded but this
    // non-super_admin account has no organization_id — the gate will never
    // fetch for this session, and that is a real, actionable condition
    // (an unattached profile), not silent "nothing to show".
    if (profileId && profile && profile.role !== 'super_admin' && !activeOrgId) {
      console.warn(
        '[phoenix] PlatformBroadcastGate: profile has no organization_id — pending broadcasts will never be fetched for this account.',
        { profileId, role: profile.role },
      );
    }

    if (!ready || hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    let active = true;
    getPendingPlatformBroadcasts()
      .then(res => {
        if (!active) return;
        if (res.ok) {
          setQueue(res.broadcasts);
        } else {
          console.error('[phoenix] getPendingPlatformBroadcasts returned ok=false:', res.error);
        }
      })
      .catch((err: unknown) => {
        console.error('[phoenix] getPendingPlatformBroadcasts failed:', err);
      });
    return () => { active = false; };
  }, [authReady, sessionUserId, profileId, activeOrgId, ready, profile]);

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
      <div className={`nexus-broadcast-gate nexus-broadcast-gate--${current.severity}`}>
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
      </div>
    </PhoenixDialog>
  );
}
