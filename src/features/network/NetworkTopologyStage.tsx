import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import type { NetworkWarehouse } from './network.service';
import type { InventorySeverity, InventorySignalType } from '@/features/inventory/inventory-intelligence.service';
import { resolveEffects } from '@/shared/webgl/effectsMode';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

type Lang = 'ar' | 'en';
export type TwinNodeKind = 'central' | 'institution' | 'outlet';
type ViewMode = 'three-d' | 'two-d';

/** Aggregated real inventory-alert state for one node (from RLS-scoped data). */
export interface NodeAlert {
  severity: InventorySeverity;
  count: number;
  topSignal: InventorySignalType;
}

/** Screen-space coordinates deliberately match the approved raised-map plate. */
export interface TwinSceneNode {
  id: string;
  label: string;
  kind: TwinNodeKind;
  active: boolean;
  x: number;
  y: number;
  parentId?: string;
  alert?: NodeAlert;
}

export interface TwinSceneEdge {
  id: string;
  source: string;
  target: string;
  active: boolean;
  kind: 'direct' | 'outlet';
}

interface Props {
  lang: Lang;
  warehouses: NetworkWarehouse[];
  outlets: DistributionPoint[];
  organizationName?: string;
  /** Real per-node inventory alerts, keyed by warehouse/outlet id (RLS-scoped). */
  alerts?: Map<string, NodeAlert>;
}

const NetworkTwin3DScene = lazy(() =>
  import('./NetworkTwin3DScene').then(module => ({ default: module.NetworkTwin3DScene })),
);

const SIGNAL_LABEL: Record<InventorySignalType, { ar: string; en: string }> = {
  missing: { ar: 'مفقود', en: 'Missing' },
  low_stock: { ar: 'شحيح', en: 'Low stock' },
  surplus: { ar: 'فائض', en: 'Surplus' },
  near_expiry: { ar: 'قريب النفاذ', en: 'Near expiry' },
  expired: { ar: 'منتهٍ', en: 'Expired' },
};

const SEVERITY_LABEL: Record<InventorySeverity, { ar: string; en: string }> = {
  high: { ar: 'حرج', en: 'Critical' },
  medium: { ar: 'متوسط', en: 'Elevated' },
  low: { ar: 'منخفض', en: 'Low' },
};

const KIND_LABEL: Record<TwinNodeKind, { ar: string; en: string }> = {
  central: { ar: 'مستودع مركزي', en: 'Central warehouse' },
  institution: { ar: 'مذخر مؤسسة صحية', en: 'Institution warehouse' },
  outlet: { ar: 'منفذ صرف', en: 'Dispensing outlet' },
};

const INSTITUTION_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [25, 29], [68, 28], [76, 48], [66, 69], [42, 73], [20, 58], [48, 23], [82, 35],
];

const OUTLET_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-5, 10], [7, 9], [-8, -3], [9, -2], [-2, 13], [4, -10],
];

function labelOf(item: { name: string; name_ar: string }, lang: Lang) {
  return lang === 'ar' ? (item.name_ar || item.name) : (item.name || item.name_ar);
}

function stableIndex(id: string, modulo: number) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % Math.max(modulo, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function compileTopology(
  warehouses: NetworkWarehouse[],
  outlets: DistributionPoint[],
  lang: Lang,
  alerts?: Map<string, NodeAlert>,
) {
  const centrals = warehouses.filter(warehouse => warehouse.warehouseKind === 'central');
  const institutions = warehouses.filter(warehouse => warehouse.warehouseKind === 'institution');
  const positions = new Map<string, { x: number; y: number }>();

  centrals.forEach((warehouse, index) => {
    const spread = (index - (centrals.length - 1) / 2) * 7;
    positions.set(warehouse.id, { x: 50 + spread, y: 52 + Math.abs(spread) * .12 });
  });

  institutions.forEach((warehouse, index) => {
    const base = INSTITUTION_POSITIONS[index % INSTITUTION_POSITIONS.length];
    const ring = Math.floor(index / INSTITUTION_POSITIONS.length);
    positions.set(warehouse.id, {
      x: clamp(base[0] + ring * 2.4, 14, 85),
      y: clamp(base[1] + (ring % 2 === 0 ? -2 : 2), 17, 78),
    });
  });

  const nodes: TwinSceneNode[] = warehouses.map(warehouse => {
    const position = positions.get(warehouse.id) ?? { x: 50, y: 50 };
    return {
      id: warehouse.id,
      label: labelOf(warehouse, lang),
      kind: warehouse.warehouseKind,
      active: warehouse.status === 'active',
      x: position.x,
      y: position.y,
      alert: alerts?.get(warehouse.id),
    };
  });

  outlets.forEach((outlet, index) => {
    const parent = outlet.warehouseId ? positions.get(outlet.warehouseId) : undefined;
    const base = parent ?? { x: 50, y: 63 };
    const offset = OUTLET_OFFSETS[(stableIndex(outlet.id, OUTLET_OFFSETS.length) + index) % OUTLET_OFFSETS.length];
    nodes.push({
      id: outlet.id,
      label: labelOf(outlet, lang),
      kind: 'outlet',
      active: outlet.status === 'active',
      x: clamp(base.x + offset[0], 12, 88),
      y: clamp(base.y + offset[1], 15, 82),
      parentId: outlet.warehouseId ?? undefined,
      alert: alerts?.get(outlet.id),
    });
  });

  // W077 direct topology: the visual relationship is central → institution,
  // then institution → outlet. It intentionally does not read or expose the
  // retired warehouse_supply_routes compatibility table.
  const edges: TwinSceneEdge[] = [];
  if (centrals.length > 0) {
    institutions.forEach((institution, index) => {
      const central = centrals[index % centrals.length];
      edges.push({
        id: `direct-${central.id}-${institution.id}`,
        source: central.id,
        target: institution.id,
        active: central.status === 'active' && institution.status === 'active',
        kind: 'direct',
      });
    });
  }

  const nodeIds = new Set(nodes.map(node => node.id));
  outlets.forEach(outlet => {
    if (outlet.warehouseId && nodeIds.has(outlet.warehouseId)) {
      edges.push({
        id: `outlet-${outlet.id}`,
        source: outlet.warehouseId,
        target: outlet.id,
        active: outlet.status === 'active',
        kind: 'outlet',
      });
    }
  });

  return { nodes, edges };
}

function nodeIcon(kind: TwinNodeKind) {
  if (kind === 'central') return 'warehouse' as const;
  if (kind === 'institution') return 'hospital' as const;
  return 'outlet' as const;
}

function NodeStatus({ node, lang }: { node: TwinSceneNode; lang: Lang }) {
  return (
    <span className="nexus-twin__node-status">
      <i />
      {node.active ? (lang === 'ar' ? 'متصل' : 'Connected') : (lang === 'ar' ? 'غير فعّال' : 'Inactive')}
    </span>
  );
}

function NodeLabel({ node, selected, lang, onSelect }: {
  node: TwinSceneNode;
  selected: boolean;
  lang: Lang;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="nexus-twin__node-label premium-focus-ring"
      data-kind={node.kind}
      data-selected={selected}
      data-alert={node.alert?.severity}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${node.label} — ${node.active ? (lang === 'ar' ? 'متصل' : 'Connected') : (lang === 'ar' ? 'غير فعّال' : 'Inactive')}`}
    >
      <span className="nexus-twin__node-icon"><PhoenixIcon name={nodeIcon(node.kind)} size={15} /></span>
      <span>
        <b>{node.label}</b>
        <NodeStatus node={node} lang={lang} />
      </span>
      {node.alert && <PhoenixIcon name="warning" size={14} className="nexus-twin__node-warning" />}
    </button>
  );
}

function SelectionPanel({ node, lang, onClose, onShow2D }: {
  node: TwinSceneNode;
  lang: Lang;
  onClose: () => void;
  onShow2D: () => void;
}) {
  const alertText = node.alert
    ? `${SEVERITY_LABEL[node.alert.severity][lang]} · ${SIGNAL_LABEL[node.alert.topSignal][lang]}`
    : (lang === 'ar' ? 'لا توجد تنبيهات مفتوحة' : 'No open alerts');

  return (
    <aside className="nexus-twin__selection-panel" aria-label={lang === 'ar' ? 'تفاصيل العقدة المختارة' : 'Selected node details'}>
      <button type="button" className="nexus-twin__panel-close premium-focus-ring" onClick={onClose} aria-label={lang === 'ar' ? 'إغلاق التفاصيل' : 'Close details'}>
        <PhoenixIcon name="close" size={16} />
      </button>
      <div className="nexus-twin__panel-visual" data-kind={node.kind}>
        <span className="nexus-twin__panel-building"><PhoenixIcon name={nodeIcon(node.kind)} size={35} /></span>
        <span className="nexus-twin__panel-scan" />
      </div>
      <div className="nexus-twin__panel-heading">
        <span className="nexus-twin__panel-kind">{KIND_LABEL[node.kind][lang]}</span>
        <h4>{node.label}</h4>
        <NodeStatus node={node} lang={lang} />
      </div>
      <dl>
        <div><dt>{lang === 'ar' ? 'حالة الاتصال' : 'Connection'}</dt><dd>{node.active ? (lang === 'ar' ? 'مستقر' : 'Stable') : (lang === 'ar' ? 'متوقف' : 'Offline')}</dd></div>
        <div><dt>{lang === 'ar' ? 'التنبيهات' : 'Alerts'}</dt><dd data-alert={node.alert?.severity}>{node.alert?.count ?? 0}</dd></div>
        <div><dt>{lang === 'ar' ? 'أعلى إشارة' : 'Top signal'}</dt><dd>{alertText}</dd></div>
      </dl>
      <button type="button" className="nexus-twin__panel-action premium-focus-ring" onClick={onShow2D}>
        <PhoenixIcon name="network" size={15} />
        {lang === 'ar' ? 'تحديدها في خريطة 2D' : 'Locate in 2D map'}
      </button>
    </aside>
  );
}

function TwoDTopology({ nodes, selectedId, lang, onSelect }: {
  nodes: TwinSceneNode[];
  selectedId: string | null;
  lang: Lang;
  onSelect: (id: string) => void;
}) {
  const centrals = nodes.filter(node => node.kind === 'central');
  const institutions = nodes.filter(node => node.kind === 'institution');
  const outlets = nodes.filter(node => node.kind === 'outlet');

  const nodeButton = (node: TwinSceneNode) => (
    <button
      type="button"
      key={node.id}
      className="nexus-twin-2d__node premium-focus-ring"
      data-kind={node.kind}
      data-selected={selectedId === node.id}
      data-alert={node.alert?.severity}
      onClick={() => onSelect(node.id)}
    >
      <PhoenixIcon name={nodeIcon(node.kind)} size={18} />
      <span><b>{node.label}</b><NodeStatus node={node} lang={lang} /></span>
      {node.alert && <small><PhoenixIcon name="warning" size={12} /> {node.alert.count}</small>}
    </button>
  );

  return (
    <div className="nexus-twin-2d" aria-label={lang === 'ar' ? 'خريطة الشبكة ثنائية الأبعاد' : 'Two-dimensional network map'}>
      <div className="nexus-twin-2d__hint">
        <PhoenixIcon name="info" size={15} />
        {lang === 'ar' ? 'عرض تخطيطي سريع يحافظ على الاختيار نفسه؛ الربط مباشر ولا يعتمد على مسارات توريد يدوية.' : 'Fast schematic view with the same selection; links are direct and route-free.'}
      </div>
      <div className="nexus-twin-2d__central">{centrals.map(nodeButton)}</div>
      <div className="nexus-twin-2d__spine" aria-hidden="true"><span /></div>
      <div className="nexus-twin-2d__institutions">
        {institutions.map(institution => (
          <section key={institution.id} className="nexus-twin-2d__branch">
            {nodeButton(institution)}
            <div className="nexus-twin-2d__outlets">
              {outlets.filter(outlet => outlet.parentId === institution.id).map(nodeButton)}
            </div>
          </section>
        ))}
      </div>
      {institutions.length === 0 && nodes.length > 0 && (
        <div className="nexus-twin-2d__orphans">{outlets.map(nodeButton)}</div>
      )}
    </div>
  );
}

export function NetworkTopologyStage({ lang, warehouses, outlets, organizationName, alerts }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('three-d');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [webglFailed, setWebglFailed] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [effects] = useState(() => resolveEffects());
  const [motionEnabled, setMotionEnabled] = useState(() => effects.continuous);
  const topology = useMemo(
    () => compileTopology(warehouses, outlets, lang, alerts),
    [warehouses, outlets, lang, alerts],
  );

  useEffect(() => {
    if (selectedId && topology.nodes.some(node => node.id === selectedId)) return;
    const preferred = topology.nodes.find(node => node.kind === 'institution' && node.active)
      ?? topology.nodes.find(node => node.kind === 'central' && node.active)
      ?? topology.nodes[0];
    setSelectedId(preferred?.id ?? null);
  }, [selectedId, topology.nodes]);

  const selected = topology.nodes.find(node => node.id === selectedId) ?? null;
  const activeLinks = topology.edges.filter(edge => edge.active).length;
  const criticalCount = topology.nodes.filter(node => node.alert?.severity === 'high').length;
  const real3D = effects.webglAllowed && !webglFailed;

  const selectNode = (id: string) => setSelectedId(current => current === id ? null : id);
  const setMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'three-d') setSceneReady(false);
  };

  return (
    <section className="nexus-topology" aria-label={lang === 'ar' ? 'التوأم الرقمي لشبكة المخزون' : 'Inventory network digital twin'}>
      <header className="nexus-topology__header">
        <div>
          <div className="nexus-topology__kicker"><span />{lang === 'ar' ? 'بيانات حيّة · مشهد تشغيلي' : 'LIVE DATA · OPERATIONAL SCENE'}</div>
          <h3>{lang === 'ar' ? 'التوأم الرقمي التشغيلي' : 'Operational digital twin'}</h3>
          <p>{organizationName || (lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'Babil Health Directorate · Pharmacy Department')}</p>
        </div>
        <button
          type="button"
          className="nexus-control nexus-topology__motion premium-focus-ring"
          onClick={() => setMotionEnabled(value => !value)}
          aria-pressed={motionEnabled}
          disabled={!real3D || viewMode === 'two-d'}
        >
          <PhoenixIcon name={motionEnabled ? 'sparkle' : 'ban'} size={16} />
          <span>{motionEnabled ? (lang === 'ar' ? 'الحركة مفعّلة' : 'Motion on') : (lang === 'ar' ? 'الحركة متوقفة' : 'Motion off')}</span>
        </button>
      </header>

      <div className="nexus-topology__toolbar">
        <div className="nexus-topology__view-tabs" role="tablist" aria-label={lang === 'ar' ? 'نوع عرض التوأم الرقمي' : 'Digital twin view'}>
          <button type="button" role="tab" aria-selected={viewMode === 'three-d'} onClick={() => setMode('three-d')} className="premium-focus-ring">
            <PhoenixIcon name="globe" size={16} /> {lang === 'ar' ? 'مجسم 3D' : '3D model'}
          </button>
          <button type="button" role="tab" aria-selected={viewMode === 'two-d'} onClick={() => setMode('two-d')} className="premium-focus-ring">
            <PhoenixIcon name="network" size={16} /> {lang === 'ar' ? 'خريطة 2D' : '2D map'}
          </button>
        </div>
        <div className="nexus-topology__readout" aria-live="polite">
          <span><i className="is-live" />{topology.nodes.length} {lang === 'ar' ? 'عقدة حيّة' : 'live nodes'}</span>
          <span>{activeLinks} {lang === 'ar' ? 'ربط مباشر' : 'direct links'}</span>
          {criticalCount > 0 && <span className="is-alert"><PhoenixIcon name="warning" size={13} /> {criticalCount} {lang === 'ar' ? 'حرج' : 'critical'}</span>}
        </div>
      </div>

      {viewMode === 'three-d' ? (
        <div className="nexus-twin" data-ready={sceneReady} data-webgl={real3D ? 'on' : 'fallback'}>
          <div className="nexus-twin__map-plane" style={{ transform: `scale(${zoom})` }}>
            <picture className="nexus-twin__terrain" aria-hidden="true">
              <source srcSet="/assets/phoenix/runtime/phoenix-babil-terrain.avif" type="image/avif" />
              <img src="/assets/phoenix/runtime/phoenix-babil-terrain.webp" alt="" draggable={false} />
            </picture>
            <div className="nexus-twin__terrain-light" aria-hidden="true" />
            {real3D && topology.nodes.length > 0 && (
              <Suspense fallback={<div className="nexus-twin__scene-loading"><span /></div>}>
                <NetworkTwin3DScene
                  nodes={topology.nodes}
                  edges={topology.edges}
                  selectedId={selectedId}
                  motionEnabled={motionEnabled}
                  continuous={effects.continuous}
                  dprCap={effects.dprCap}
                  antialias={effects.antialias}
                  onSelect={selectNode}
                  onReady={() => setSceneReady(true)}
                  onContextLost={() => setWebglFailed(true)}
                />
              </Suspense>
            )}
            <div className="nexus-twin__labels">
              {topology.nodes.slice(0, 16).map(node => (
                <NodeLabel key={node.id} node={node} selected={selectedId === node.id} lang={lang} onSelect={() => selectNode(node.id)} />
              ))}
            </div>
          </div>

          <div className="nexus-twin__cinematic-vignette" aria-hidden="true" />
          {!real3D && topology.nodes.length > 0 && (
            <div className="nexus-twin__safe-mode"><PhoenixIcon name="info" size={14} /> {lang === 'ar' ? 'الخريطة السينمائية الآمنة فعّالة؛ WebGL متوقف على هذا الجهاز.' : 'Cinematic safe map active; WebGL is unavailable on this device.'}</div>
          )}
          {topology.nodes.length === 0 && (
            <div className="nexus-twin__empty"><PhoenixIcon name="warehouse" size={30} /><span>{lang === 'ar' ? 'لا توجد عقد ضمن النطاق الحالي.' : 'No nodes are available in the current scope.'}</span></div>
          )}

          {selected && <SelectionPanel node={selected} lang={lang} onClose={() => setSelectedId(null)} onShow2D={() => setMode('two-d')} />}

          <div className="nexus-twin__legend" aria-label={lang === 'ar' ? 'مفتاح الخريطة' : 'Map legend'}>
            {(Object.keys(KIND_LABEL) as TwinNodeKind[]).map(kind => (
              <span key={kind} data-kind={kind}><i /><PhoenixIcon name={nodeIcon(kind)} size={13} />{KIND_LABEL[kind][lang]}</span>
            ))}
          </div>

          <div className="nexus-twin__controls">
            <button type="button" onClick={() => setZoom(value => clamp(value - .06, .9, 1.14))} aria-label={lang === 'ar' ? 'تصغير' : 'Zoom out'} className="premium-focus-ring">−</button>
            <button type="button" onClick={() => setZoom(1)} aria-label={lang === 'ar' ? 'إعادة ضبط التكبير' : 'Reset zoom'} className="premium-focus-ring"><PhoenixIcon name="refresh" size={16} /></button>
            <button type="button" onClick={() => setZoom(value => clamp(value + .06, .9, 1.14))} aria-label={lang === 'ar' ? 'تكبير' : 'Zoom in'} className="premium-focus-ring">+</button>
          </div>
          <div className="nexus-twin__gpu-state"><span className={real3D && sceneReady ? 'is-live' : ''} />{real3D ? (sceneReady ? 'GPU LIVE' : 'GPU STARTING') : 'SAFE 2D'}</div>
        </div>
      ) : (
        <TwoDTopology nodes={topology.nodes} selectedId={selectedId} lang={lang} onSelect={selectNode} />
      )}
    </section>
  );
}
