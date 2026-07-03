import { useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDate, formatStableDateTime } from '@/shared/lib/date';
import { getQrTokensByOrg, disableQrToken } from '@/shared/supabase/services/qr.service';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixMetricCard } from '@/shared/ui/PhoenixMetricCard';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

/* ── Types ── */

type FilterType = 'all' | 'active' | 'disabled' | 'risk' | 'no_qr' | 'recent';

interface TargetRef {
  id: string;
  target_type: string;
  target_id: string;
  label: string | null;
  status: string;
}

interface AuditToken {
  id: string;
  public_id: string;
  status: string;
  last_scanned_at: string | null;
  scan_count: number;
  created_at: string;
  disabled_at: string | null;
  qr_targets: TargetRef | TargetRef[] | null;
}

/* ── Pure helpers ── */

function getTarget(row: AuditToken): TargetRef | null {
  const tg = row.qr_targets;
  if (!tg) return null;
  return Array.isArray(tg) ? tg[0] ?? null : tg;
}

function makePublicUrl(publicId: string): string {
  return `${window.location.origin}/?qid=${publicId}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso: string | null, lang: 'ar' | 'en'): string {
  return formatStableDate(iso, lang);
}

function fmtDatetime(iso: string | null, lang: 'ar' | 'en'): string {
  return formatStableDateTime(iso, lang);
}

/* ── Main screen ── */

export function QrScreen() {
  const { lang, activeOrgId, myPermissions } = useApp();
  const isMobile = window.innerWidth < 768;
  const canRevoke   = myPermissions.has('qr.revoke');
  const canGenerate = myPermissions.has('qr.generate');

  const [filter, setFilter]             = useState<FilterType>('all');
  const [search, setSearch]             = useState('');
  const [toast, setToast]               = useState<string | null>(null);
  const [busyId, setBusyId]             = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const qrData = useAsync(
    () => activeOrgId ? getQrTokensByOrg(activeOrgId) : Promise.resolve([]),
    [activeOrgId],
  );
  const pointsData = useAsync(
    () => activeOrgId ? getPointsByOrg(activeOrgId) : Promise.resolve([]),
    [activeOrgId],
  );

  const rows   = (qrData.data    ?? []) as unknown as AuditToken[];
  const points = pointsData.data ?? [];

  /* ── Computed metrics ── */
  const activeRows   = rows.filter(r => r.status === 'active');
  const disabledRows = rows.filter(r => r.status !== 'active');
  const riskRows     = activeRows.filter(r => {
    const tg = getTarget(r);
    return tg && tg.status !== 'active';
  });
  const totalScans   = rows.reduce((sum, r) => sum + (r.scan_count || 0), 0);
  const recentRows   = rows.filter(r => r.last_scanned_at != null);

  // Ports not covered by any active QR (distribution_point type only)
  const activeDpTargetIds = new Set(
    activeRows
      .map(r => getTarget(r))
      .filter((tg): tg is TargetRef => !!tg && tg.target_type === 'distribution_point')
      .map(tg => tg.target_id),
  );
  const portsWithoutQr = points.filter(p => p.status === 'active' && !activeDpTargetIds.has(p.id));

  /* ── Filter + search ── */
  const filteredRows = (() => {
    let base: AuditToken[];
    switch (filter) {
      case 'active':   base = activeRows; break;
      case 'disabled': base = disabledRows; break;
      case 'risk':     base = riskRows; break;
      case 'recent':   base = [...recentRows].sort((a, b) =>
        new Date(b.last_scanned_at!).getTime() - new Date(a.last_scanned_at!).getTime(),
      ); break;
      default:         base = rows;
    }
    if (!search.trim()) return base;
    const q = search.toLowerCase();
    return base.filter(r => {
      const tg = getTarget(r);
      return (tg?.label ?? '').toLowerCase().includes(q) ||
             r.public_id.toLowerCase().includes(q);
    });
  })();

  /* ── Actions ── */
  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function onCopy(pid: string) {
    try {
      await navigator.clipboard.writeText(makePublicUrl(pid));
      showToast(t('qr_copied', lang));
    } catch { /* clipboard unavailable */ }
  }

  function onOpen(pid: string) {
    window.open(makePublicUrl(pid), '_blank', 'noopener,noreferrer');
  }

  async function onPrint(row: AuditToken) {
    const tg    = getTarget(row);
    const label = tg?.label ?? tg?.target_type ?? '—';
    const url   = makePublicUrl(row.public_id);
    // Open the window synchronously, still inside the click handler's user-
    // gesture context — some browsers (notably Safari) treat window.open()
    // called after an `await` as no longer gesture-triggered and silently
    // block it. Write the QR image in once it's ready instead.
    const win = window.open('', '_blank', 'width=520,height=680');
    if (!win) {
      showToast(t('print_popup_blocked', lang));
      return;
    }
    try {
      const src = await QRCode.toDataURL(url, {
        width: 240, margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' },
      });
      const generated = formatStableDate(new Date(), lang);
      win.document.write(`<!DOCTYPE html>
<html dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang === 'ar' ? 'ar' : 'en'}">
<head>
  <meta charset="UTF-8">
  <title>QR — ${esc(label)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 40px 24px; color: #111; margin: 0; background: #fff; }
    h2 { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
    .type { font-size: 12px; color: #888; margin: 0 0 20px; text-transform: uppercase; letter-spacing: .5px; }
    img { display: block; margin: 0 auto 16px; width: 200px; height: 200px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; }
    .url { font-size: 10.5px; color: #666; word-break: break-all; font-family: monospace; direction: ltr; margin: 0 0 6px; }
    .date { font-size: 10px; color: #888; margin: 0 0 16px; direction: ltr; }
    .brand { font-size: 10px; color: #aaa; border-top: 1px solid #eee; padding-top: 12px; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <h2>${esc(label)}</h2>
  <p class="type">${esc(tg?.target_type ?? '')}</p>
  <img src="${src}" alt="QR Code">
  <p class="url">${esc(url)}</p>
  <p class="date" dir="ltr">${esc(generated)}</p>
  <p class="brand">MediStock-Babil / MASAR Health Network</p>
</body>
</html>`);
      win.document.close();
      win.focus();
      win.print();
      win.close();
    } catch {
      win.close();
      showToast(t('qr_display_error', lang));
    }
  }

  async function onRevoke(id: string) {
    setConfirmRevokeId(null);
    setBusyId(id);
    try {
      await disableQrToken(id, 'manual_revoke');
      showToast(t('qr_revoked', lang));
      qrData.reload();
      pointsData.reload();
    } catch { showToast(t('qr_create_error', lang)); }
    finally { setBusyId(null); }
  }

  const loading = qrData.loading || pointsData.loading;
  const error   = qrData.error   || pointsData.error;

  /* ── Filter chips definition ── */
  const chips: Array<{ id: FilterType; label: string; count: number }> = [
    { id: 'all',      label: lang === 'ar' ? 'الكل' : 'All',             count: rows.length       },
    { id: 'active',   label: t('d_qr_active',          lang),             count: activeRows.length },
    { id: 'disabled', label: t('d_qr_disabled',         lang),             count: disabledRows.length },
    { id: 'risk',     label: t('qr_linked_inactive_port', lang),           count: riskRows.length   },
    { id: 'recent',   label: t('qr_recently_scanned',   lang),             count: recentRows.length },
    ...(portsWithoutQr.length > 0 ? [{ id: 'no_qr' as FilterType, label: t('qr_ports_no_qr', lang), count: portsWithoutQr.length }] : []),
  ];

  return (
    <div style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('nav_qr_audit', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
            {t('qr_audit_center_subtitle', lang)}
          </p>
        </div>
        <PhoenixOrgScope />
      </div>

      {/* ── Privacy notice ── */}
      <div style={{
        background: 'var(--p2)', border: '1px solid var(--p)',
        borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '20px',
        fontSize: '12px', color: 'var(--pd)', display: 'flex', alignItems: 'center', gap: '8px',
      }}>
        🔐 {t('qr_no_expose', lang)}
      </div>

      {/* ── No org scope ── */}
      {!activeOrgId && (
        <PhoenixEmptyState icon="📱" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      )}

      {activeOrgId && loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {activeOrgId && !loading && error && (
        <PhoenixErrorState
          title={t('load_error', lang)}
          message={error}
          onRetry={() => { qrData.reload(); pointsData.reload(); }}
        />
      )}

      {activeOrgId && !loading && !error && (
        <>
          {/* ── Summary metric cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? '140px' : '160px'}, 1fr))`, gap: '10px', marginBottom: '24px' }}>
            <PhoenixMetricCard
              icon="✅"
              value={activeRows.length}
              label={t('d_qr_active', lang)}
              valueColor="#059669"
              iconBg="#d1fae5"
              onClick={() => setFilter('active')}
            />
            <PhoenixMetricCard
              icon="🚫"
              value={disabledRows.length}
              label={t('d_qr_disabled', lang)}
              valueColor="var(--t3)"
              iconBg="var(--s2)"
              onClick={() => setFilter('disabled')}
            />
            {riskRows.length > 0 && (
              <PhoenixMetricCard
                icon="⚠️"
                value={riskRows.length}
                label={t('qr_linked_inactive_port', lang)}
                badge={lang === 'ar' ? 'خطر' : 'Risk'}
                badgeVariant="err"
                valueColor="#dc2626"
                iconBg="#fee2e2"
                onClick={() => setFilter('risk')}
              />
            )}
            {portsWithoutQr.length > 0 && (
              <PhoenixMetricCard
                icon="📵"
                value={portsWithoutQr.length}
                label={t('qr_ports_no_qr', lang)}
                badge={lang === 'ar' ? 'تنبيه' : 'Alert'}
                badgeVariant="warn"
                valueColor="#d97706"
                iconBg="#fef3c7"
                onClick={() => setFilter('no_qr')}
              />
            )}
            <PhoenixMetricCard
              icon="📊"
              value={totalScans}
              label={t('qr_total_scans', lang)}
              valueColor="var(--p)"
              iconBg="var(--p2)"
            />
          </div>

          {/* ── Risk alert banner ── */}
          {riskRows.length > 0 && filter === 'all' && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px',
              fontSize: '12px', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              ⚠️ {lang === 'ar'
                ? `${riskRows.length} رمز QR نشط مرتبط بمنفذ غير نشط — راجع هذه الرموز أو عطّلها`
                : `${riskRows.length} active QR code(s) linked to inactive port(s) — review or revoke them`}
            </div>
          )}

          {/* ── Filter chips + search ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
            {chips.map(chip => (
              <button
                key={chip.id}
                onClick={() => setFilter(chip.id)}
                style={{
                  padding: '6px 12px', borderRadius: 'var(--rpill)',
                  border: '1px solid var(--brd)',
                  background: filter === chip.id ? 'var(--p)' : 'var(--s)',
                  color:      filter === chip.id ? 'white'    : 'var(--t2)',
                  fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
                  transition: 'all 100ms',
                }}
              >
                {chip.label}{chip.count > 0 ? ` (${chip.count})` : ''}
              </button>
            ))}

            <div style={{ position: 'relative', marginInlineStart: 'auto', minWidth: '180px' }}>
              <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', pointerEvents: 'none' }}>🔍</span>
              <input
                type="search"
                placeholder={lang === 'ar' ? 'ابحث بالاسم أو المعرّف...' : 'Search label or ID...'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  padding: '7px 10px', paddingInlineStart: '32px',
                  borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
                  background: 'var(--s)', color: 'var(--t)', fontSize: '12px', width: '100%',
                }}
                aria-label={lang === 'ar' ? 'بحث' : 'Search'}
              />
            </div>
          </div>

          {/* ── Ports without QR section ── */}
          {filter === 'no_qr' && (
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '10px', color: '#d97706' }}>
                📵 {t('qr_ports_no_qr', lang)} ({portsWithoutQr.length})
              </h3>
              {portsWithoutQr.length === 0 ? (
                <PhoenixEmptyState icon="✅" title={lang === 'ar' ? 'جميع المنافذ النشطة لديها QR' : 'All active ports have a QR'} description="" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {portsWithoutQr.map(p => (
                    <div
                      key={p.id}
                      style={{
                        background: '#fffbeb', border: '1px solid #fde68a',
                        borderRadius: 'var(--r3)', padding: '12px 14px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        flexWrap: 'wrap', gap: '10px',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>
                          {lang === 'ar' ? (p.name_ar || p.name) : (p.name || p.name_ar)}
                        </div>
                        <div style={{ fontSize: '11px', color: '#92400e', marginTop: '2px' }}>
                          {p.pointType} · {t('qr_no_token', lang)}
                        </div>
                      </div>
                      {canGenerate && (
                        <div style={{ fontSize: '11px', color: '#92400e', fontStyle: 'italic', maxWidth: '240px', textAlign: 'end' }}>
                          {t('qr_create_from_port', lang)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Token list ── */}
          {filter !== 'no_qr' && (
            <>
              {rows.length === 0 && (
                <PhoenixEmptyState
                  icon="📱"
                  title={t('qr_no_registered', lang)}
                  description={t('empty_hint', lang)}
                />
              )}

              {rows.length > 0 && filteredRows.length === 0 && (
                <PhoenixEmptyState
                  icon="🔍"
                  title={lang === 'ar' ? 'لا نتائج' : 'No results'}
                  description={lang === 'ar' ? 'جرّب فلتراً مختلفاً أو كلمة بحث مختلفة' : 'Try a different filter or search term'}
                />
              )}

              {filteredRows.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {filteredRows.map(row => {
                    const tg       = getTarget(row);
                    const isActive = row.status === 'active';
                    const isRisk   = isActive && !!tg && tg.status !== 'active';
                    const url      = makePublicUrl(row.public_id);
                    return (
                      <AuditTokenCard
                        key={row.id}
                        row={row}
                        tg={tg}
                        isActive={isActive}
                        isRisk={isRisk}
                        url={url}
                        lang={lang}
                        isMobile={isMobile}
                        canRevoke={canRevoke}
                        busyId={busyId}
                        onCopy={() => onCopy(row.public_id)}
                        onOpen={() => onOpen(row.public_id)}
                        onPrint={() => onPrint(row)}
                        onRevoke={() => setConfirmRevokeId(row.id)}
                      />
                    );
                  })}
                </div>
              )}

              {/* No issues banner */}
              {rows.length > 0 && riskRows.length === 0 && filter === 'all' && (
                <div style={{
                  marginTop: '16px', padding: '10px 14px',
                  borderRadius: 'var(--r3)', background: '#ecfdf5',
                  border: '1px solid #6ee7b7', fontSize: '12px', color: '#059669',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  ✅ {t('qr_no_critical_issues', lang)}
                </div>
              )}
            </>
          )}

          {/* ── Privacy footer ── */}
          <div style={{
            marginTop: '24px', padding: '10px 12px', borderRadius: 'var(--r2)',
            background: 'var(--s2)', border: '1px solid var(--brd)',
            fontSize: '11px', color: 'var(--t3)',
          }}>
            🔒 {t('qr_no_expose', lang)}
          </div>
        </>
      )}

      {/* ── Revoke confirmation dialog ── */}
      <PhoenixDialog
        open={confirmRevokeId !== null}
        onClose={() => setConfirmRevokeId(null)}
        title={t('qr_revoke', lang)}
      >
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '8px', lineHeight: 1.6 }}>
          {t('qr_confirm_revoke', lang)}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ok)', fontWeight: 600, marginBottom: '16px' }}>
          🔒 {lang === 'ar' ? 'إلغاء QR لا يحذف المنفذ.' : 'Revoking QR does not delete the port.'}
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setConfirmRevokeId(null)}>
            {t('cancel', lang)}
          </PhoenixButton>
          <PhoenixButton
            variant="warn" size="md" style={{ flex: 2 }}
            loading={confirmRevokeId !== null && busyId === confirmRevokeId}
            onClick={() => { if (confirmRevokeId) onRevoke(confirmRevokeId); }}
          >
            🚫 {t('qr_revoke', lang)}
          </PhoenixButton>
        </div>
      </PhoenixDialog>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

/* ── Audit Token Card ── */

function AuditTokenCard({
  row, tg, isActive, isRisk, url, lang, isMobile,
  canRevoke, busyId, onCopy, onOpen, onPrint, onRevoke,
}: {
  row: AuditToken;
  tg: TargetRef | null;
  isActive: boolean;
  isRisk: boolean;
  url: string;
  lang: 'ar' | 'en';
  isMobile: boolean;
  canRevoke: boolean;
  busyId: string | null;
  onCopy: () => void;
  onOpen: () => void;
  onPrint: () => void;
  onRevoke: () => void;
}) {
  const cardBorder = isRisk ? '1px solid #dc2626' : isActive ? '1px solid #6ee7b7' : undefined;

  return (
    <PhoenixCard padding="14px 16px" border={cardBorder} hover>
      {/* ── Row 1: label + badges + scan count ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '5px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isMobile ? '160px' : '320px' }}>
            {tg?.label ?? tg?.target_type ?? '—'}
          </span>
          <PhoenixStatusBadge
            variant={isActive ? 'ok' : 'neutral'}
            label={isActive ? t('qr_active', lang) : t('inactive', lang)}
          />
          {isRisk && (
            <span style={{
              padding: '1px 7px', borderRadius: 'var(--rpill)',
              background: '#fef2f2', border: '1px solid #dc2626',
              color: '#dc2626', fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
            }}>
              ⚠ {t('qr_linked_inactive_port', lang)}
            </span>
          )}
        </div>

        {/* Scan count badge */}
        <div style={{ textAlign: 'end', flexShrink: 0 }}>
          <span style={{ fontSize: '18px', fontWeight: 800, color: row.scan_count > 0 ? 'var(--p)' : 'var(--t3)' }}>
            {row.scan_count}
          </span>
          <div style={{ fontSize: '10px', color: 'var(--t3)', marginTop: '-1px' }}>
            {lang === 'ar' ? 'مسح' : 'scans'}
          </div>
        </div>
      </div>

      {/* ── Row 2: target type + target status ── */}
      <div style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '5px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {tg?.target_type && <span>{tg.target_type}</span>}
        {tg && tg.status !== 'active' && (
          <>
            <span style={{ color: 'var(--t3)' }}>·</span>
            <span style={{ color: '#dc2626', fontWeight: 600 }}>
              {t('qr_inactive_target', lang)}: {tg.status}
            </span>
          </>
        )}
        {!tg && (
          <span style={{ color: 'var(--t3)', fontStyle: 'italic' }}>
            {lang === 'ar' ? 'هدف غير معروف' : 'Unknown target'}
          </span>
        )}
      </div>

      {/* ── Row 3: public URL (safe, clickable to copy) ── */}
      <div
        onClick={onCopy}
        title={lang === 'ar' ? 'انقر للنسخ' : 'Click to copy'}
        style={{
          fontSize: '10.5px', color: 'var(--p)', fontFamily: 'monospace',
          wordBreak: 'break-all', lineHeight: 1.4, cursor: 'pointer',
          marginBottom: '8px',
        }}
        dir="ltr"
      >
        {url}
      </div>

      {/* ── Row 4: timestamps ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '11px', color: 'var(--t2)', marginBottom: '10px' }}>
        {row.last_scanned_at ? (
          <span>
            {lang === 'ar' ? 'آخر مسح: ' : 'Last scan: '}
            <span style={{ fontWeight: 600 }} dir="ltr">{fmtDatetime(row.last_scanned_at, lang)}</span>
          </span>
        ) : (
          <span style={{ color: 'var(--t3)' }}>
            {lang === 'ar' ? 'لم يُمسح بعد' : 'Not scanned yet'}
          </span>
        )}
        <span>
          {lang === 'ar' ? 'أُنشئ: ' : 'Created: '}<span dir="ltr">{fmtDate(row.created_at, lang)}</span>
        </span>
        {row.disabled_at && (
          <span style={{ color: 'var(--t3)' }}>
            {lang === 'ar' ? 'عُطِّل: ' : 'Disabled: '}<span dir="ltr">{fmtDate(row.disabled_at, lang)}</span>
          </span>
        )}
      </div>

      {/* ── Row 5: actions ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        <button
          onClick={onCopy}
          style={{
            padding: '5px 10px', borderRadius: 'var(--r2)',
            border: '1px solid var(--brd)', background: 'var(--s)',
            color: 'var(--t2)', fontSize: '11.5px', cursor: 'pointer',
            transition: 'all 100ms',
          }}
        >
          📋 {t('qr_copy_link', lang)}
        </button>

        <button
          onClick={onOpen}
          style={{
            padding: '5px 10px', borderRadius: 'var(--r2)',
            border: '1px solid var(--brd)', background: 'var(--s)',
            color: 'var(--t2)', fontSize: '11.5px', cursor: 'pointer',
            transition: 'all 100ms',
          }}
        >
          🔗 {t('qr_open_public', lang)}
        </button>

        {isActive && (
          <button
            onClick={onPrint}
            style={{
              padding: '5px 10px', borderRadius: 'var(--r2)',
              border: '1px solid var(--brd)', background: 'var(--s)',
              color: 'var(--t2)', fontSize: '11.5px', cursor: 'pointer',
              transition: 'all 100ms',
            }}
          >
            🖨 {t('qr_print', lang)}
          </button>
        )}

        {canRevoke && isActive && (
          <PhoenixButton
            variant="warn" size="sm"
            loading={busyId === row.id}
            onClick={onRevoke}
          >
            🚫 {t('qr_revoke', lang)}
          </PhoenixButton>
        )}

        {isRisk && (
          <span style={{ fontSize: '10.5px', color: '#dc2626', fontStyle: 'italic', marginInlineStart: 'auto' }}>
            {t('qr_review_or_disable', lang)}
          </span>
        )}
      </div>
    </PhoenixCard>
  );
}
