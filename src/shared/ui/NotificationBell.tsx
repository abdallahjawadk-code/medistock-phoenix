import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import {
  getUnreadNotificationCount, listNotifications, markAllNotificationsRead, markNotificationRead,
  type NotificationRow,
} from '@/shared/supabase/services/notifications.service';
import { getPaperReferencesFor, type PaperReference, type PaperReferenceDocumentType } from '@/features/movement/paper-reference.service';
import { paperReferenceSummary } from '@/features/movement/ui/PaperReferenceFields';
import { PhoenixIcon } from './PhoenixIcon';
import { PhoenixLoadingState } from './PhoenixLoadingState';
import { PhoenixErrorState } from './PhoenixErrorState';
import { PhoenixEmptyState } from './PhoenixEmptyState';

/**
 * PAPER-REFERENCE-CONTRACT-110 — a notification's reference_type is the
 * TRIGGERING TABLE NAME (082/099: TG_TABLE_NAME), which is plural and does
 * not literally match 110's singular document_type vocabulary. Only these
 * four map onto a document_type 110 actually covers; every other
 * reference_type (warehouse_return_shipments, outlet_return_shipments,
 * warehouse_transfer_requests, outlet_stock_movements,
 * warehouse_quarantine_stock_movements, stocktakes, ...) is NOT a paper-
 * tracked document and is deliberately left alone.
 *
 * stock_correction_request (phoenix_stock_correction_requests) is a genuine
 * LIMITATION: 082/099 never attach a capture trigger to that table, so no
 * notification ever carries a reference_id for it — there is nothing to look
 * up here for that document type.
 */
const NOTIFICATION_REF_TYPE_TO_DOCUMENT_TYPE: Partial<Record<string, PaperReferenceDocumentType>> = {
  warehouse_dispatches: 'warehouse_dispatch',
  warehouse_return_requests: 'warehouse_return_request',
  outlet_return_requests: 'outlet_return_request',
  warehouse_stock_movements: 'warehouse_stock_movement',
};

/** Bilingual "N minutes/hours/days ago" — no shared relative-time utility
 *  exists in this codebase yet (checked before writing this), so this is a
 *  small local helper matching the hand-rolled convention used elsewhere
 *  (e.g. InterInstitutionAlertsScreen's expiry-days formatter). */
function relativeTime(iso: string, lang: 'ar' | 'en'): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(deltaMs / 60000));
  if (minutes < 1) return lang === 'ar' ? 'الآن' : 'just now';
  if (minutes < 60) return lang === 'ar' ? `قبل ${minutes} دقيقة` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return lang === 'ar' ? `قبل ${hours} ساعة` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return lang === 'ar' ? `قبل ${days} يوم` : `${days}d ago`;
}

function eventLabel(n: NotificationRow, lang: 'ar' | 'en'): string {
  const key = `notif_evt_${n.eventType}`;
  const label = t(key, lang);
  // t() falls back to the raw key when untranslated — surface the raw
  // event_type instead so an untranslated future event reads as data, not
  // as a leaked internal i18n key string.
  return label === key ? n.eventType : label;
}

export function NotificationBell() {
  const { lang, profile } = useApp();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paperRefs, setPaperRefs] = useState<Map<string, PaperReference>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * One batched query PER covered document type across the whole visible
   * page — never one lookup per notification row. A notification whose
   * reference_type isn't one of the four covered document types, or that
   * carries no reference_id at all, is simply never looked up.
   */
  const loadPaperRefs = useCallback(async (rows: NotificationRow[]) => {
    const byDocType = new Map<PaperReferenceDocumentType, string[]>();
    for (const n of rows) {
      const docType = n.referenceType ? NOTIFICATION_REF_TYPE_TO_DOCUMENT_TYPE[n.referenceType] : undefined;
      if (!docType || !n.referenceId) continue;
      const ids = byDocType.get(docType) ?? [];
      ids.push(n.referenceId);
      byDocType.set(docType, ids);
    }
    if (byDocType.size === 0) { setPaperRefs(new Map()); return; }
    const merged = new Map<string, PaperReference>();
    await Promise.all(Array.from(byDocType.entries()).map(async ([docType, ids]) => {
      try {
        const found = await getPaperReferencesFor(docType, ids);
        found.forEach((v, k) => merged.set(`${docType}:${k}`, v));
      } catch { /* best-effort enrichment; the notification itself still renders */ }
    }));
    setPaperRefs(merged);
  }, []);

  const reloadUnreadCount = useCallback(() => {
    if (!profile) return;
    getUnreadNotificationCount().then(setUnreadCount).catch((err: unknown) => {
      console.error('[phoenix] unread notification count failed:', err);
    });
  }, [profile]);

  // Poll the unread count regardless of panel state (a real-time subscription
  // is a natural future upgrade; polling is the same-cost, zero-new-infra
  // choice every other live count in this app already makes).
  useEffect(() => {
    reloadUnreadCount();
    const id = window.setInterval(reloadUnreadCount, 30000);
    return () => window.clearInterval(id);
  }, [reloadUnreadCount]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const loadList = useCallback(() => {
    setLoading(true);
    setError(null);
    listNotifications({ limit: 20 })
      .then((page) => {
        setNotifications(page.notifications);
        void loadPaperRefs(page.notifications);
      })
      .catch((err: unknown) => {
        console.error('[phoenix] notification list load failed:', err);
        setError(err instanceof Error ? err.message : 'Unexpected error');
      })
      .finally(() => setLoading(false));
  }, [loadPaperRefs]);

  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

  if (!profile) return null;

  const handleMarkRead = async (id: string) => {
    // Optimistic: the badge/list should feel instant; the RPC is idempotent
    // (ON CONFLICT DO NOTHING) so a failure just means the next reload
    // re-shows it unread — never a false "read" persisted without the server.
    setNotifications((prev) => prev?.map((n) => (n.id === id ? { ...n, isRead: true } : n)) ?? prev);
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationRead(id);
    } catch (err) {
      console.error('[phoenix] mark-read failed:', err);
      loadList();
      reloadUnreadCount();
    }
  };

  const handleMarkAllRead = async () => {
    const previous = notifications;
    setNotifications((prev) => prev?.map((n) => ({ ...n, isRead: true })) ?? prev);
    setUnreadCount(0);
    try {
      await markAllNotificationsRead();
    } catch (err) {
      console.error('[phoenix] mark-all-read failed:', err);
      setNotifications(previous);
      reloadUnreadCount();
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="nexus-control"
        aria-label={t('notif_bell_label', lang)}
        aria-expanded={open}
        style={{ position: 'relative' }}
      >
        <PhoenixIcon name="bell" size={17} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: -2, insetInlineEnd: -2,
              minWidth: 16, height: 16, padding: '0 3px', borderRadius: 999,
              background: 'var(--ember)', color: 'var(--on-accent)', fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}
          >
            {unreadCount > 9 ? t('notif_unread_badge_overflow', lang) : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('notif_panel_title', lang)}
          className="nexus-notification-panel"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', insetInlineEnd: 0,
            width: 'min(380px, 92vw)', maxHeight: '70vh', overflowY: 'auto',
            background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
            boxShadow: '0 20px 48px rgba(0,0,0,0.28)', zIndex: 'var(--z-topbar, 40)',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0,
            background: 'var(--surface)',
          }}>
            <strong>{t('notif_panel_title', lang)}</strong>
            {unreadCount > 0 && (
              <button type="button" onClick={handleMarkAllRead} className="premium-focus-ring" style={{
                background: 'transparent', border: 'none', color: 'var(--cyanDim)', fontSize: 13, cursor: 'pointer',
              }}>
                {t('notif_mark_all_read', lang)}
              </button>
            )}
          </div>

          <div style={{ padding: 8 }}>
            {loading && <PhoenixLoadingState label={t('loading', lang)} />}
            {!loading && error && (
              <PhoenixErrorState title={t('notif_load_error', lang)} message={error} onRetry={loadList} />
            )}
            {!loading && !error && notifications && notifications.length === 0 && (
              <PhoenixEmptyState icon="bell" title={t('notif_empty_title', lang)} description={t('notif_empty_description', lang)} />
            )}
            {!loading && !error && notifications && notifications.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {notifications.map((n) => {
                  const docType = n.referenceType ? NOTIFICATION_REF_TYPE_TO_DOCUMENT_TYPE[n.referenceType] : undefined;
                  const paperRef = docType && n.referenceId ? paperRefs.get(`${docType}:${n.referenceId}`) : undefined;
                  return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => !n.isRead && handleMarkRead(n.id)}
                      className="premium-focus-ring"
                      style={{
                        width: '100%', textAlign: 'start', display: 'flex', flexDirection: 'column', gap: 2,
                        padding: '8px 10px', borderRadius: 8, border: 'none', cursor: n.isRead ? 'default' : 'pointer',
                        background: n.isRead ? 'transparent' : 'var(--chip)',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {!n.isRead && (
                          <span aria-hidden="true" style={{
                            width: 6, height: 6, borderRadius: 999, background: 'var(--ember)', flexShrink: 0,
                          }} />
                        )}
                        <span style={{ fontWeight: n.isRead ? 400 : 600, fontSize: 13.5 }}>{eventLabel(n, lang)}</span>
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6 }}>
                        {n.reference && <span>{n.reference}</span>}
                        <span dir="ltr">{relativeTime(n.occurredAt, lang)}</span>
                      </span>
                      {/* PAPER-REFERENCE-CONTRACT-110: only when actually recorded — most
                          notifications carry no paper reference and must not show a "—". */}
                      {paperRef?.paperReferenceNumber && (
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          {t('mv_h_paper_reference_number', lang)}: {paperReferenceSummary(paperRef)}
                        </span>
                      )}
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
