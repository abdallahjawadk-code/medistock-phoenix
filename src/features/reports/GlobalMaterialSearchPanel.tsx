import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { useAsync } from '@/shared/lib/useAsync';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  searchGlobalMaterialStock,
  type GlobalMaterialScope,
  type GlobalMaterialSearchResult,
  type GlobalMaterialSearchRow,
  type GlobalMaterialSignal,
} from './global-material-search.service';
import { exportGlobalMaterialSearchWorkbook } from './global-material-export';

const COPY = {
  ar: {
    title: 'البحث الشامل عن مادة',
    subtitle: 'عرض الرصيد الحقيقي في مؤسسة واحدة أو مجموعة مؤسسات — متاح للمشرف العام فقط',
    query: 'اسم المادة أو الاسم التجاري أو الرمز الوطني',
    queryPlaceholder: 'مثال: Amoxicillin أو الرمز الوطني',
    organizations: 'المؤسسات',
    all: 'تحديد الكل',
    clear: 'إلغاء التحديد',
    selected: 'محددة',
    scope: 'نوع الموقع',
    allScopes: 'المذاخر والمنافذ',
    warehouses: 'المذاخر فقط',
    outlets: 'المنافذ فقط',
    search: 'بحث',
    export: 'تصدير Excel احترافي',
    minQuery: 'أدخل حرفين على الأقل للبحث.',
    orgRequired: 'حدد مؤسسة واحدة على الأقل.',
    noResults: 'لا توجد نتائج مطابقة ضمن المؤسسات المحددة.',
    results: 'نتائج',
    locations: 'مواقع',
    institutions: 'مؤسسات',
    onHand: 'الرصيد الفعلي',
    reserved: 'المحجوز',
    available: 'المتاح',
    material: 'المادة',
    institution: 'المؤسسة',
    location: 'الموقع',
    national: 'الرمز الوطني',
    batches: 'الدفعات',
    nearestExpiry: 'أقرب صلاحية',
    status: 'الحالة',
    warehouse: 'مذخر',
    outlet: 'منفذ',
    truncated: 'تم الوصول إلى حد العرض الآمن؛ ضيّق عبارة البحث أو المؤسسات.',
    sourceTruncated: 'بلغ أحد استعلامات المصدر حدّه الأقصى، لذا البيانات غير مكتملة والمجاميع أدناه حدّ أدنى وليست الإجمالي الحقيقي. ضيّق عبارة البحث أو المؤسسات للحصول على صورة كاملة.',
    exportReady: 'تم إنشاء ملف Excel من النتائج الحالية.',
    exportFailed: 'تعذر إنشاء ملف Excel.',
    loadOrganizations: 'تعذر تحميل المؤسسات.',
    policy: 'البحث يدوي عند الطلب فقط، والنتائج محدودة لحماية قاعدة البيانات.',
  },
  en: {
    title: 'Global Material Search',
    subtitle: 'View live balances across one or multiple institutions — super admin only',
    query: 'Material, trade name, or national code',
    queryPlaceholder: 'Example: Amoxicillin or national code',
    organizations: 'Institutions',
    all: 'Select all',
    clear: 'Clear',
    selected: 'selected',
    scope: 'Location type',
    allScopes: 'Warehouses and outlets',
    warehouses: 'Warehouses only',
    outlets: 'Outlets only',
    search: 'Search',
    export: 'Professional Excel export',
    minQuery: 'Enter at least two characters.',
    orgRequired: 'Select at least one institution.',
    noResults: 'No matching results in the selected institutions.',
    results: 'Results',
    locations: 'Locations',
    institutions: 'Institutions',
    onHand: 'On hand',
    reserved: 'Reserved',
    available: 'Available',
    material: 'Material',
    institution: 'Institution',
    location: 'Location',
    national: 'National code',
    batches: 'Batches',
    nearestExpiry: 'Nearest expiry',
    status: 'Status',
    warehouse: 'Warehouse',
    outlet: 'Outlet',
    truncated: 'The safe display limit was reached; narrow the query or institution selection.',
    sourceTruncated: 'A source query hit its cap, so the underlying data is incomplete and the totals below are a LOWER BOUND, not the real total. Narrow the query or institution selection for a complete picture.',
    exportReady: 'Excel was generated from the current result set.',
    exportFailed: 'Could not generate the Excel workbook.',
    loadOrganizations: 'Could not load institutions.',
    policy: 'Search runs only on demand and results are capped to protect the database.',
  },
} as const;

const SIGNAL_COPY: Record<GlobalMaterialSignal, { ar: string; en: string }> = {
  missing: { ar: 'مفقودة', en: 'Missing' },
  low_stock: { ar: 'شحيحة', en: 'Low stock' },
  surplus: { ar: 'فائضة', en: 'Surplus' },
  near_expiry: { ar: 'قريبة النفاذ', en: 'Near expiry' },
  expired: { ar: 'منتهية', en: 'Expired' },
};

const SIGNAL_STYLE: Record<GlobalMaterialSignal, { color: string; background: string }> = {
  missing: { color: 'var(--err)', background: 'var(--err2)' },
  expired: { color: 'var(--err)', background: 'var(--err2)' },
  low_stock: { color: 'var(--warn)', background: 'var(--warn2)' },
  near_expiry: { color: 'var(--warn)', background: 'var(--warn2)' },
  surplus: { color: 'var(--ok)', background: 'var(--ok2)' },
};

function rowOrganization(row: GlobalMaterialSearchRow, lang: 'ar' | 'en'): string {
  return lang === 'ar'
    ? (row.organizationNameAr || row.organizationName)
    : (row.organizationName || row.organizationNameAr);
}

function rowLocation(row: GlobalMaterialSearchRow, lang: 'ar' | 'en'): string {
  return lang === 'ar'
    ? (row.scopeNameAr || row.scopeName)
    : (row.scopeName || row.scopeNameAr);
}

function formatQuantity(value: number, lang: 'ar' | 'en'): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-IQ' : 'en-GB').format(value);
}

function SignalBadges({ row, lang }: { row: GlobalMaterialSearchRow; lang: 'ar' | 'en' }) {
  if (row.signals.length === 0) {
    return (
      <span style={{ padding: '2px 7px', borderRadius: 'var(--rpill)', background: 'var(--ok2)', color: 'var(--ok)', fontSize: '10px', fontWeight: 700 }}>
        {lang === 'ar' ? 'متاحة' : 'Available'}
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
      {row.signals.map(signal => (
        <span key={signal} style={{
          padding: '2px 7px',
          borderRadius: 'var(--rpill)',
          background: SIGNAL_STYLE[signal].background,
          color: SIGNAL_STYLE[signal].color,
          fontSize: '10px',
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}>
          {SIGNAL_COPY[signal][lang]}
        </span>
      ))}
    </div>
  );
}

export function GlobalMaterialSearchPanel() {
  const { lang, role } = useApp();
  const c = COPY[lang];
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const organizations = useAsync(() => getOrganizations(), []);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<GlobalMaterialScope>('all');
  const [selectedOrganizations, setSelectedOrganizations] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<GlobalMaterialSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const initializedCatalog = useRef('');
  const requestSequence = useRef(0);

  const activeOrganizations = useMemo(
    () => (organizations.data ?? []).filter(org => org.status !== 'archived'),
    [organizations.data],
  );
  const catalogFingerprint = activeOrganizations.map(org => org.id).sort().join('|');

  useEffect(() => {
    if (!catalogFingerprint || initializedCatalog.current === catalogFingerprint) return;
    initializedCatalog.current = catalogFingerprint;
    requestSequence.current += 1;
    setSearching(false);
    setSelectedOrganizations(new Set(activeOrganizations.map(org => org.id)));
    setResult(null);
    setMessage(null);
  }, [catalogFingerprint, activeOrganizations]);

  const summary = useMemo(() => {
    const rows = result?.rows ?? [];
    return {
      institutions: new Set(rows.map(row => row.organizationId)).size,
      locations: new Set(rows.map(row => `${row.scopeKind}:${row.scopeId}`)).size,
      onHand: rows.reduce((sum, row) => sum + row.onHand, 0),
      reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
      available: rows.reduce((sum, row) => sum + row.available, 0),
    };
  }, [result]);

  if (role !== 'super_admin') return null;

  function invalidateSearchContext() {
    requestSequence.current += 1;
    setSearching(false);
    setResult(null);
    setMessage(null);
  }

  function toggleOrganization(id: string) {
    setSelectedOrganizations(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    invalidateSearchContext();
  }

  async function runSearch() {
    const clean = query.trim();
    if (clean.length < 2) {
      setMessage({ kind: 'error', text: c.minQuery });
      return;
    }
    const orgIds = [...selectedOrganizations];
    if (orgIds.length === 0) {
      setMessage({ kind: 'error', text: c.orgRequired });
      return;
    }

    const sequence = ++requestSequence.current;
    setSearching(true);
    setMessage(null);
    try {
      const next = await searchGlobalMaterialStock({
        term: clean,
        organizationIds: orgIds,
        scope,
      });
      if (sequence !== requestSequence.current) return;
      setResult(next);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setResult(null);
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (sequence === requestSequence.current) setSearching(false);
    }
  }

  async function runExport() {
    if (!result || result.rows.length === 0) return;
    setExporting(true);
    setMessage(null);
    try {
      await exportGlobalMaterialSearchWorkbook({
        lang,
        query: query.trim(),
        organizations: activeOrganizations
          .filter(org => selectedOrganizations.has(org.id))
          .map(org => ({ id: org.id, name: org.name, nameAr: org.name_ar })),
        result,
      });
      setMessage({ kind: 'ok', text: c.exportReady });
    } catch {
      setMessage({ kind: 'error', text: c.exportFailed });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ animation: 'fs .25s ease' }}>
      <div style={{ marginBottom: '14px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '16px', fontWeight: 700 }}>{c.title}</h3>
        <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '4px' }} dir="auto">{c.subtitle}</p>
      </div>

      <PhoenixCard padding={isMobile ? '12px' : '16px'} style={{ marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(260px, 1.4fr) minmax(170px, .6fr)', gap: '12px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11.5px', fontWeight: 600 }}>
            {c.query}
            <input
              value={query}
              onChange={event => { setQuery(event.target.value); invalidateSearchContext(); }}
              onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }}
              placeholder={c.queryPlaceholder}
              dir="auto"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
                border: '1px solid var(--brd)', background: 'var(--bg)', color: 'var(--t)',
                fontSize: '12.5px', outline: 'none',
              }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11.5px', fontWeight: 600 }}>
            {c.scope}
            <select
              value={scope}
              onChange={event => { setScope(event.target.value as GlobalMaterialScope); invalidateSearchContext(); }}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
                border: '1px solid var(--brd)', background: 'var(--bg)', color: 'var(--t)',
                fontSize: '12.5px',
              }}
            >
              <option value="all">{c.allScopes}</option>
              <option value="warehouse">{c.warehouses}</option>
              <option value="outlet">{c.outlets}</option>
            </select>
          </label>
        </div>

        <div style={{ marginTop: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '7px' }}>
            <span style={{ fontSize: '11.5px', fontWeight: 700 }}>
              {c.organizations} · {selectedOrganizations.size} {c.selected}
            </span>
            <div style={{ display: 'flex', gap: '5px' }}>
              <PhoenixButton
                variant="ghost"
                size="sm"
                onClick={() => { setSelectedOrganizations(new Set(activeOrganizations.map(org => org.id))); invalidateSearchContext(); }}
              >
                {c.all}
              </PhoenixButton>
              <PhoenixButton
                variant="ghost"
                size="sm"
                onClick={() => { setSelectedOrganizations(new Set()); invalidateSearchContext(); }}
              >
                {c.clear}
              </PhoenixButton>
            </div>
          </div>

          {organizations.loading && <PhoenixLoadingState label={c.organizations} />}
          {!organizations.loading && organizations.error && (
            <PhoenixErrorState title={c.loadOrganizations} message={organizations.error} onRetry={organizations.reload} />
          )}
          {!organizations.loading && !organizations.error && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
              gap: '6px',
              maxHeight: '180px',
              overflowY: 'auto',
              padding: '8px',
              border: '1px solid var(--brd)',
              borderRadius: 'var(--r2)',
              background: 'var(--bg)',
            }}>
              {activeOrganizations.map(org => (
                <label key={org.id} style={{
                  display: 'flex', alignItems: 'center', gap: '7px',
                  padding: '7px 8px', borderRadius: 'var(--r2)',
                  background: selectedOrganizations.has(org.id) ? 'var(--p2)' : 'var(--s)',
                  border: selectedOrganizations.has(org.id) ? '1px solid var(--p)' : '1px solid transparent',
                  cursor: 'pointer', fontSize: '11.5px',
                }}>
                  <input
                    type="checkbox"
                    checked={selectedOrganizations.has(org.id)}
                    onChange={() => toggleOrganization(org.id)}
                  />
                  <span dir="auto" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lang === 'ar' ? (org.name_ar || org.name) : (org.name || org.name_ar)}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div role="note" style={{ marginTop: '10px', fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">
          <PhoenixIcon name="scope" size={13} inline /> {c.policy}
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          <PhoenixButton loading={searching} disabled={organizations.loading} onClick={() => void runSearch()}>
            <PhoenixIcon name="search" size={13} inline /> {c.search}
          </PhoenixButton>
          <PhoenixButton
            variant="secondary"
            loading={exporting}
            disabled={!result || result.rows.length === 0}
            onClick={() => void runExport()}
          >
            <PhoenixIcon name="reports" size={13} inline /> {c.export}
          </PhoenixButton>
        </div>

        {message && (
          <div role="status" style={{
            marginTop: '10px', padding: '8px 10px', borderRadius: 'var(--r2)',
            background: message.kind === 'error' ? 'var(--err2)' : 'var(--ok2)',
            color: message.kind === 'error' ? 'var(--err)' : 'var(--ok)',
            fontSize: '11.5px', fontWeight: 600,
          }}>
            {message.text}
          </div>
        )}
      </PhoenixCard>

      {searching && <PhoenixLoadingState label={c.search} />}

      {!searching && result && result.rows.length === 0 && (
        <PhoenixEmptyState icon="search" title={c.noResults} />
      )}

      {!searching && result && result.rows.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: '8px', marginBottom: '12px' }}>
            {[
              [c.results, result.totalRows],
              [c.institutions, summary.institutions],
              [c.onHand, summary.onHand],
              [c.reserved, summary.reserved],
              [c.available, summary.available],
            ].map(([label, value]) => (
              <PhoenixCard key={String(label)} padding="11px">
                <div style={{ fontSize: '18px', fontWeight: 700 }}>{formatQuantity(Number(value), lang)}</div>
                <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{label}</div>
              </PhoenixCard>
            ))}
          </div>

          {/* G3.2 — SOURCE truncation is reported before display truncation and
              is a different, more serious statement. `truncated` says the list
              shown was cut; `sourceTruncated` says the underlying QUERY was cut,
              so every total above is a lower bound. Presenting capped data as a
              complete total is the failure this removes. */}
          {result.sourceTruncated && (
            <div
              role="status"
              data-testid="global-search-source-truncated"
              style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: 'var(--r2)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '11px', fontWeight: 700 }}
            >
              <PhoenixIcon name="warning" size={13} inline /> {c.sourceTruncated}
            </div>
          )}

          {result.truncated && (
            <div role="status" style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: 'var(--r2)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '11px' }}>
              <PhoenixIcon name="warning" size={13} inline /> {c.truncated}
            </div>
          )}

          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {result.rows.map(row => (
                <PhoenixCard key={row.key} padding="12px" style={{ borderInlineStart: row.signals.includes('missing') || row.signals.includes('expired') ? '3px solid var(--err)' : '3px solid var(--p)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{row.scientificName}</div>
                      <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">
                        {rowOrganization(row, lang)} · {rowLocation(row, lang)}
                      </div>
                    </div>
                    <SignalBadges row={row} lang={lang} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginTop: '10px', textAlign: 'center' }}>
                    <div><strong>{formatQuantity(row.onHand, lang)}</strong><div style={{ fontSize: '9.5px', color: 'var(--t2)' }}>{c.onHand}</div></div>
                    <div><strong>{formatQuantity(row.reserved, lang)}</strong><div style={{ fontSize: '9.5px', color: 'var(--t2)' }}>{c.reserved}</div></div>
                    <div><strong>{formatQuantity(row.available, lang)}</strong><div style={{ fontSize: '9.5px', color: 'var(--t2)' }}>{c.available}</div></div>
                  </div>
                </PhoenixCard>
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--brd)', borderRadius: 'var(--r3)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1080px', fontSize: '11px' }}>
                <thead>
                  <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                    {[c.material, c.institution, c.location, c.national, c.onHand, c.reserved, c.available, c.batches, c.nearestExpiry, c.status].map(label => (
                      <th key={label} style={{ padding: '9px 8px', textAlign: 'start', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map(row => (
                    <tr key={row.key} style={{ borderBottom: '1px solid var(--brd)' }}>
                      <td style={{ padding: '9px 8px', fontWeight: 650 }} dir="auto">
                        {row.scientificName}
                        {row.tradeNames.length > 0 && <div style={{ color: 'var(--t2)', fontSize: '9.5px' }}>{row.tradeNames.join('، ')}</div>}
                      </td>
                      <td style={{ padding: '9px 8px' }} dir="auto">{rowOrganization(row, lang)}</td>
                      <td style={{ padding: '9px 8px' }} dir="auto">
                        <span style={{ color: 'var(--t2)' }}>{row.scopeKind === 'warehouse' ? c.warehouse : c.outlet} · </span>
                        {rowLocation(row, lang)}
                      </td>
                      <td style={{ padding: '9px 8px' }} dir="ltr">{row.nationalCode ?? '—'}</td>
                      <td style={{ padding: '9px 8px', fontWeight: 650 }}>{formatQuantity(row.onHand, lang)}</td>
                      <td style={{ padding: '9px 8px' }}>{formatQuantity(row.reserved, lang)}</td>
                      <td style={{ padding: '9px 8px', color: 'var(--p)', fontWeight: 700 }}>{formatQuantity(row.available, lang)}</td>
                      <td style={{ padding: '9px 8px' }}>{formatQuantity(row.batchCount, lang)}</td>
                      <td style={{ padding: '9px 8px' }} dir="ltr">{row.nearestExpiry ?? '—'}</td>
                      <td style={{ padding: '9px 8px' }}><SignalBadges row={row} lang={lang} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
