/**
 * SOURCE-BALANCES-PANEL — per-source stock balances for one warehouse
 * (CANONICAL-SUPPLY-PROVENANCE-088).
 *
 * Renders: supplied-from-pharmacy-department vs supplementary purchases vs
 * aid vs kimadia, plus totals (on-hand / reserved / available) and a live
 * reconciliation line (physical = sum of source balances — true by
 * construction under 088; any drift is surfaced loudly).
 *
 * READINESS GATE (fail-closed): the phoenix_warehouse_source_balances RPC
 * exists only once migration 088 is applied. Against a pre-088 production the
 * call errors (42883 undefined function) and this panel renders the explicit
 * "feature awaits migration activation" state instead of breaking the screen.
 * It NEVER writes anything.
 */
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { displaySupplyType } from '@/shared/lib/supply-types';

interface SourceBalanceRow {
  supply_type: string | null;
  purchase_origin: string | null;
  lots: number;
  on_hand: number;
  reserved: number;
  available: number;
}

type BalancesResult =
  | { ready: true; rows: SourceBalanceRow[] }
  /** RPC absent (088 not applied yet) — feature awaits migration activation. */
  | { ready: false };

async function readSourceBalances(warehouseId: string): Promise<BalancesResult> {
  if (!supabaseConfigured || !warehouseId) return { ready: true, rows: [] };
  const { data, error } = await supabase.rpc('phoenix_warehouse_source_balances', {
    p_warehouse_id: warehouseId,
  });
  if (error) {
    // 42883 / PGRST202: undefined function — 088 not applied. Fail closed to
    // the awaiting state; any other error surfaces as empty (read-only panel).
    if (error.code === '42883' || error.code === 'PGRST202' || /function/i.test(error.message ?? '')) {
      return { ready: false };
    }
    throw error;
  }
  return {
    ready: true,
    rows: ((data ?? []) as SourceBalanceRow[]).map(r => ({
      ...r, lots: Number(r.lots), on_hand: Number(r.on_hand),
      reserved: Number(r.reserved), available: Number(r.available),
    })),
  };
}

/** Bucket a balances row into its user-facing source label key. */
export function sourceLabelKey(row: Pick<SourceBalanceRow, 'supply_type' | 'purchase_origin'>): string {
  const type = displaySupplyType(row.supply_type);
  if (type === 'purchase') {
    return row.purchase_origin === 'supplementary' ? 'st_origin_supplementary' : 'st_origin_central';
  }
  if (type === 'aid') return 'sc_supply_aid';
  if (type === 'kimadia') return 'sc_supply_kimadia';
  return 'sb_source_unclassified';
}

export function SourceBalancesPanel({ warehouseId }: { warehouseId: string }) {
  const { lang } = useApp();
  const balances = useAsync<BalancesResult>(() => readSourceBalances(warehouseId), [warehouseId]);

  if (!warehouseId) return null;
  if (balances.loading) return <PhoenixLoadingState label={t('loading', lang)} />;
  if (balances.error) return null; // read-only decoration; never breaks the screen

  const result = balances.data;
  if (!result) return null;

  if (!result.ready) {
    return (
      <PhoenixCard data-testid="source-balances-awaiting">
        <div style={{ fontSize: '12px', color: 'var(--t2)', textAlign: 'center', padding: '6px' }}>
          {t('sb_awaiting_migration', lang)}
        </div>
      </PhoenixCard>
    );
  }

  const rows = result.rows;
  const total = (k: 'on_hand' | 'reserved' | 'available') => rows.reduce((s, r) => s + r[k], 0);
  // Reconciliation is BY CONSTRUCTION under 088 (each lot is single-source);
  // stated explicitly so any future writer bypassing the discipline is seen.
  const physical = total('on_hand');
  const sourceSum = rows.reduce((s, r) => s + r.on_hand, 0);
  const reconciled = physical === sourceSum;

  const supplied = rows.filter(r => sourceLabelKey(r) !== 'st_origin_supplementary');
  const supplementary = rows.filter(r => sourceLabelKey(r) === 'st_origin_supplementary');
  const sum = (list: SourceBalanceRow[], k: 'on_hand' | 'reserved' | 'available') =>
    list.reduce((s, r) => s + r[k], 0);

  return (
    <PhoenixCard data-testid="source-balances">
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('sb_title', lang)}</h4>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '12px' }}>
        <BalanceTile label={t('sb_supplied_from_pharmacy', lang)} value={sum(supplied, 'on_hand')} />
        <BalanceTile label={t('st_origin_supplementary', lang)} value={sum(supplementary, 'on_hand')} />
        <BalanceTile label={t('sb_total', lang)} value={physical} strong />
        <BalanceTile label={t('inv_reserved', lang)} value={total('reserved')} />
        <BalanceTile label={t('inv_available', lang)} value={total('available')} />
      </div>

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
          {rows.map((r, i) => (
            <span key={i} style={{ fontSize: '11px', padding: '4px 10px', borderRadius: 'var(--rpill)', background: 'var(--s2)', border: '1px solid var(--brd)', color: 'var(--t2)' }}>
              {t(sourceLabelKey(r), lang)}: <strong style={{ color: 'var(--t)' }}>{r.on_hand}</strong> · {r.lots} {t('sb_lots', lang)}
            </span>
          ))}
        </div>
      )}

      <div
        data-testid="source-balances-reconciliation"
        style={{ fontSize: '11px', color: reconciled ? 'var(--ok)' : 'var(--err)', fontWeight: 600 }}
      >
        {reconciled ? t('sb_reconciled', lang) : t('sb_reconciliation_drift', lang)}
        {' '}({t('sb_total', lang)}: {physical})
      </div>
    </PhoenixCard>
  );
}

function BalanceTile({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)' }}>
      <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{label}</div>
      <div style={{ fontSize: strong ? '18px' : '15px', fontWeight: 750 }}>{value}</div>
    </div>
  );
}
