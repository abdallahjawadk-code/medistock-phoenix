/**
 * PHOENIX-MATERIAL-RESOLVER — the single "search & select a registered
 * material" control every material-choosing screen mounts.
 *
 * Free text is a FILTER only: no result → the mandated "must be registered
 * first" message; the typed text can never become a material, and nothing here
 * writes anything. Debounced, request-cancelling, server-side/RLS-scoped.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { supplyTypeLabelKey } from '@/shared/lib/supply-types';
import {
  resolveMaterials, type ResolvedMaterial, type MatchGrade,
} from './material-resolver.service';
import { SmartScanner, type ScanClassification } from './SmartScanner';

const GRADE_KEY: Record<MatchGrade, string> = {
  confirmed: 'mr_grade_confirmed',
  strong: 'mr_grade_strong',
  probable: 'mr_grade_probable',
};

const GRADE_COLOR: Record<MatchGrade, string> = {
  confirmed: 'var(--ok)',
  strong: 'var(--p)',
  probable: 'var(--warn)',
};

interface Props {
  lang: 'ar' | 'en';
  /** Scope lot-level matches (batch, on-hand) to one warehouse. */
  warehouseId?: string | null;
  /**
   * 'internal' (default) matches scientific/trade name, national code, batch
   * and barcode; 'public' restricts to scientific or trade NAME only and never
   * reaches lot-level stock — for the public outlet page.
   */
  audience?: 'internal' | 'public';
  onSelect: (material: ResolvedMaterial) => void;
  label?: string;
  autoFocus?: boolean;
}

export function PhoenixMaterialResolver({ lang, warehouseId, audience, onSelect, label, autoFocus }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ResolvedMaterial[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** Barcode scans become a QUERY (a filter) — never a material. */
  const onScanned = (scan: ScanClassification) => {
    setScannerOpen(false);
    if (scan.kind === 'barcode') setQuery(scan.value);
    else if (scan.kind === 'movement') setQuery(scan.id);
    else if (scan.kind === 'establishment') setQuery(scan.qid);
  };

  useEffect(() => {
    abortRef.current?.abort();
    if (query.trim().length < 2) { setResults(null); setBusy(false); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    const timer = setTimeout(() => {
      resolveMaterials(query, { warehouseId, audience, signal: controller.signal })
        .then(rows => { if (!controller.signal.aborted) { setResults(rows); setBusy(false); } })
        .catch(() => { if (!controller.signal.aborted) { setResults([]); setBusy(false); } });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, warehouseId, audience]);

  const fieldStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
    border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px',
  } as const;

  return (
    <div data-testid="material-resolver">
      <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
        {label ?? t('mr_search_label', lang)}
      </label>
      <input
        type="search"
        dir="auto"
        value={query}
        autoFocus={autoFocus}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('mr_search_placeholder', lang)}
        aria-label={label ?? t('mr_search_label', lang)}
        style={fieldStyle}
        data-phoenix-local-search
      />

      <div style={{ marginTop: '6px' }}>
        <button type="button" onClick={() => setScannerOpen(o => !o)}
          style={{ fontSize: '11px', color: 'var(--p)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          {t('scan_open', lang)}
        </button>
      </div>
      {scannerOpen && <SmartScanner lang={lang} onScan={onScanned} onClose={() => setScannerOpen(false)} />}

      {busy && <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('loading', lang)}</p>}

      {!busy && results !== null && results.length === 0 && (
        <p data-testid="material-resolver-empty" style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '8px' }} dir="auto">
          {t('mr_no_registered_match', lang)}
        </p>
      )}

      {!busy && results !== null && results.length > 0 && (
        <div style={{ display: 'grid', gap: '6px', marginTop: '8px', maxHeight: '300px', overflowY: 'auto' }} role="listbox">
          {results.map((r, i) => (
            <button
              key={`${r.source}-${r.centralItemId ?? r.warehouseStockId ?? i}`}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onSelect(r)}
              style={{
                textAlign: 'start', padding: '10px 12px', borderRadius: 'var(--r2)',
                border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)',
                cursor: 'pointer', fontSize: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700 }} dir="auto">
                  {r.scientificName}{r.tradeName ? ` (${r.tradeName})` : ''}
                </span>
                <span style={{ fontSize: '10px', fontWeight: 700, color: GRADE_COLOR[r.grade], border: `1px solid ${GRADE_COLOR[r.grade]}`, borderRadius: 'var(--rpill)', padding: '1px 8px' }}>
                  {t(GRADE_KEY[r.grade], lang)}
                </span>
              </div>
              <div style={{ color: 'var(--t2)', marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
                {r.concentration && <span dir="auto">{r.concentration}</span>}
                {r.dosageForm && <span dir="auto">{r.dosageForm}</span>}
                {r.unit && <span dir="auto">{r.unit}</span>}
                {r.nationalCode && <span dir="ltr">{t('inv_national_code', lang)}: {r.nationalCode}</span>}
                {r.barcode && <span dir="ltr">{t('mr_barcode', lang)}: {r.barcode}</span>}
                {r.batchNumber && <span dir="ltr">{t('mv_f_batch_number', lang)}: {r.batchNumber}</span>}
                {r.expiryDate && <span dir="ltr">{t('mv_f_expiry_date', lang)}: {r.expiryDate}</span>}
              </div>
              <div style={{ color: 'var(--t3)', marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '10.5px' }}>
                {r.available != null && <span>{t('inv_available', lang)}: {r.available} · {t('inv_reserved', lang)}: {r.reserved}</span>}
                {r.supplyType && <span>{t(supplyTypeLabelKey(r.supplyType), lang)}</span>}
                <span><PhoenixIcon name="check" size={10} inline /> {t(r.reasonKey, lang)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
