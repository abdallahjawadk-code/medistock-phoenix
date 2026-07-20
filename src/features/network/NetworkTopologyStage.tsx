import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import type { NetworkWarehouse, SupplyRoute } from './network.service';
import type { InventorySeverity, InventorySignalType } from '@/features/inventory/inventory-intelligence.service';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { computeTwin2dLayout } from './twinLayout';
import { resolveEffects, shouldRenderWebGL } from '@/shared/webgl';
import { useRenderActive } from '@/shared/webgl/useRenderActive';

// Three.js is code-split: the 2D map and the rest of the screen never pay for
// the WebGL bundle unless the 3D tab is actually rendered.
const NetworkTwin3DScene = lazy(() =>
  import('@/shared/webgl/NetworkTwin3DScene').then(m => ({ default: m.NetworkTwin3DScene })),
);

type Lang = 'ar' | 'en';
type NodeKind = 'central' | 'institution' | 'outlet';
type Position = [number, number, number];

/** Aggregated real inventory-alert state for one node (from RLS-scoped data). */
export interface NodeAlert {
  severity: InventorySeverity;
  count: number;
  topSignal: InventorySignalType;
}

interface TopologyNode {
  id: string;
  label: string;
  kind: NodeKind;
  active: boolean;
  position: Position;
  alert?: NodeAlert;
}

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

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  active: boolean;
  /** 'direct' = a real supply route; 'outlet' = a warehouse→outlet attachment. */
  kind: 'direct' | 'outlet';
}

/**
 * Read-only contract consumed by the Three.js cinematic scene
 * (src/shared/webgl/NetworkTwin3DScene.tsx). x/y are normalised 0..100 and are
 * derived from the SAME deterministic, collision-free tiered layout that drives
 * the 2D SVG map (twinLayout.ts), so both views place the network identically.
 *
 * The scene never fetches: it renders exactly the RLS-scoped topology passed in.
 */
export interface TwinSceneNode {
  id: string;
  label: string;
  kind: NodeKind;
  active: boolean;
  x: number;
  y: number;
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
  routes: SupplyRoute[];
  outlets: DistributionPoint[];
  organizationName?: string;
  /** Real per-node inventory alerts, keyed by warehouse/outlet id (RLS-scoped). */
  alerts?: Map<string, NodeAlert>;
}

function labelOf(item: { name: string; name_ar: string }, lang: Lang) {
  return lang === 'ar' ? (item.name_ar || item.name) : (item.name || item.name_ar);
}

function stableAngle(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return (Math.abs(hash) % 360) * Math.PI / 180;
}

const SEVERITY_RANK: Record<InventorySeverity, number> = { high: 0, medium: 1, low: 2 };

export function NetworkTopologyStage({ lang, warehouses, routes, outlets, organizationName, alerts }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // null = not yet probed. A hard false (no GL context, or a lost context)
  // permanently forces the 2D safe view for this mount.
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true);
  // Adjacent 3D (WebGL) / 2D (SVG map) views. When WebGL is unavailable the 2D
  // map becomes the safe fallback and the 3D tab is disabled.
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [zoom, setZoom] = useState(1);

  // Central effects policy: device tiering, reduced-motion, Save-Data and the
  // DPR ceiling all come from the shared resolver rather than being re-derived
  // here. deviceProfile() already caps dprCap at 1.5 for every tier.
  const effects = useMemo(() => resolveEffects(), []);
  // Pause the render loop whenever the twin is offscreen, the tab is hidden or
  // the window is blurred — no GPU work for a twin nobody is looking at.
  const renderActive = useRenderActive(viewportRef);

  // The scene fades in only once its first frame has actually rendered
  // (.nexus-twin__webgl is opacity:0 until data-ready="true"), so the terrain
  // is never briefly covered by an empty canvas.
  const [sceneReady, setSceneReady] = useState(false);
  const handleSceneReady = useCallback(() => setSceneReady(true), []);
  const selectNode = useCallback((id: string) => setSelectedId(id), []);
  // A lost GL context is terminal for this mount: drop to the deterministic 2D
  // map rather than attempting a restore, so the twin can never sit blank.
  const handleContextLost = useCallback(() => setWebglReady(false), []);

  const topology = useMemo(() => {
    const warehousePositions = new Map<string, Position>();
    const centrals = warehouses.filter(w => w.warehouseKind === 'central');
    const institutions = warehouses.filter(w => w.warehouseKind === 'institution');

    centrals.forEach((warehouse, index) => {
      const angle = centrals.length <= 1 ? Math.PI / 2 : (index / centrals.length) * Math.PI * 2;
      warehousePositions.set(warehouse.id, [Math.cos(angle) * .28, .44 + Math.sin(angle) * .10, .18]);
    });

    institutions.forEach((warehouse, index) => {
      const angle = (index / Math.max(institutions.length, 1)) * Math.PI * 2 - Math.PI / 2;
      warehousePositions.set(warehouse.id, [Math.cos(angle) * .82, Math.sin(angle) * .55 - .05, Math.sin(angle * 1.7) * .18]);
    });

    const nodes: TopologyNode[] = warehouses.map(warehouse => ({
      id: warehouse.id,
      label: labelOf(warehouse, lang),
      kind: warehouse.warehouseKind,
      active: warehouse.status === 'active',
      position: warehousePositions.get(warehouse.id) ?? [0, 0, 0],
      alert: alerts?.get(warehouse.id),
    }));

    outlets.forEach((outlet, index) => {
      const parent = outlet.warehouseId ? warehousePositions.get(outlet.warehouseId) : undefined;
      const angle = stableAngle(outlet.id) + index * .19;
      const base = parent ?? [0, -.25, 0] as Position;
      nodes.push({
        id: outlet.id,
        label: labelOf(outlet, lang),
        kind: 'outlet',
        active: outlet.status === 'active',
        position: [
          base[0] + Math.cos(angle) * .21,
          base[1] + Math.sin(angle) * .17,
          base[2] + Math.cos(angle * 1.4) * .08,
        ],
        alert: alerts?.get(outlet.id),
      });
    });

    const nodeIds = new Set(nodes.map(node => node.id));
    const edges: TopologyEdge[] = routes
      .filter(route => nodeIds.has(route.sourceWarehouseId) && nodeIds.has(route.targetWarehouseId))
      .map(route => ({
        id: route.id,
        source: route.sourceWarehouseId,
        target: route.targetWarehouseId,
        active: route.isActive,
        kind: 'direct' as const,
      }));

    outlets.forEach(outlet => {
      if (outlet.warehouseId && nodeIds.has(outlet.warehouseId)) {
        edges.push({
          id: `outlet-${outlet.id}`,
          source: outlet.warehouseId,
          target: outlet.id,
          active: outlet.status === 'active',
          kind: 'outlet' as const,
        });
      }
    });

    return { nodes, edges };
  }, [warehouses, routes, outlets, lang, alerts]);

  // 2D layout of the same real topology onto an SVG plane. Uses a deterministic
  // tiered layout (central → institution → outlet, evenly spread per tier) so
  // nodes and labels never overlap regardless of density — see twinLayout.ts.
  const view2d = useMemo(() => {
    const { positions, width: SW, height: SH } = computeTwin2dLayout(
      topology.nodes.map(node => ({ id: node.id, kind: node.kind })),
    );
    const nodes = topology.nodes.flatMap(node => {
      const p = positions.get(node.id);
      if (!p) return [];
      return [{ ...node, sx: p.x, sy: p.y, labelAbove: p.labelAbove }];
    });
    const edges = topology.edges.flatMap(edge => {
      const s = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!s || !target) return [];
      return [{ ...edge, x1: s.x, y1: s.y, x2: target.x, y2: target.y }];
    });
    return { nodes, edges, SW, SH };
  }, [topology]);

  // The Three.js scene consumes the SAME deterministic layout as the 2D map,
  // normalised to the 0..100 space the scene expects. Reusing twinLayout keeps
  // the two views spatially consistent and inherits its collision-free tiering,
  // so a dense network never overlaps in 3D either.
  const scene3d = useMemo(() => {
    const nodes: TwinSceneNode[] = view2d.nodes.map(node => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      active: node.active,
      x: (node.sx / view2d.SW) * 100,
      y: (node.sy / view2d.SH) * 100,
      alert: node.alert,
    }));
    const present = new Set(nodes.map(node => node.id));
    const edges: TwinSceneEdge[] = topology.edges
      .filter(edge => present.has(edge.source) && present.has(edge.target))
      .map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        active: edge.active,
        kind: edge.kind,
      }));
    return { nodes, edges };
  }, [view2d, topology.edges]);

  // WebGL unknown (null) or ok (true) keeps 3D selectable; a hard false forces
  // the 2D safe view. The user's explicit tab choice wins while 3D is viable.
  const canUse3D = webglReady !== false;
  const effectiveView: '3d' | '2d' = canUse3D ? view : '2d';
  const show3D = effectiveView === '3d';

  // WebGL support probe. The Three.js scene owns its own renderer, so this is a
  // cheap capability check only — no program, buffers or draw calls here. The
  // scene reports a lost context back through onContextLost, which latches
  // webglReady=false and drops us to the 2D map for the rest of this mount.
  useEffect(() => {
    if (!show3D || webglReady !== null) return;
    setWebglReady(shouldRenderWebGL({ allowReducedData: true }) && effects.webglAllowed);
  }, [show3D, webglReady, effects.webglAllowed]);

  const selected = topology.nodes.find(node => node.id === selectedId) ?? null;
  const activeRoutes = topology.edges.filter(edge => edge.active).length;
  const alertedNodes = topology.nodes
    .filter(node => node.alert)
    .sort((a, b) => SEVERITY_RANK[a.alert!.severity] - SEVERITY_RANK[b.alert!.severity]);
  const criticalCount = alertedNodes.filter(node => node.alert!.severity === 'high').length;
  const alertText = (a: NodeAlert) =>
    `${SEVERITY_LABEL[a.severity][lang]} · ${SIGNAL_LABEL[a.topSignal][lang]}${a.count > 1 ? ` ×${a.count}` : ''}`;

  // 2D node fill mirrors the identity tiers used by the WebGL pass and the legend.
  const svg2dFill = (node: TopologyNode, isSel: boolean): string => {
    if (!node.active) return 'var(--muted, var(--t2))';
    if (isSel) return 'var(--gold)';
    if (node.kind === 'central') return 'var(--ember)';
    if (node.kind === 'institution') return 'var(--p)';
    return 'var(--teal)';
  };
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <section className="nexus-topology" aria-label={lang === 'ar' ? 'التوأم الرقمي لشبكة المخزون' : 'Inventory network digital twin'}>
      <header className="nexus-topology__header">
        <div>
          <div className="nexus-topology__kicker">
            <span />
            {lang === 'ar' ? 'WEBGL · قراءة حيّة' : 'WEBGL · LIVE READ'}
          </div>
          <h3>{lang === 'ar' ? 'التوأم الرقمي لشبكة الإمداد' : 'Supply network digital twin'}</h3>
          <p>
            {organizationName || (lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'Babil Health · Pharmacy Department')}
          </p>
        </div>
        <div className="nexus-topology__actions">
          <div className="nexus-topology__viewtabs" role="tablist" aria-label={lang === 'ar' ? 'نمط العرض' : 'View mode'}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveView === '3d'}
              disabled={!canUse3D}
              onClick={() => setView('3d')}
            >
              {lang === 'ar' ? 'ثلاثي الأبعاد' : '3D'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveView === '2d'}
              onClick={() => setView('2d')}
            >
              {lang === 'ar' ? 'خريطة ثنائية' : '2D map'}
            </button>
          </div>
          {show3D ? (
            <button
              type="button"
              className="nexus-control nexus-topology__motion"
              onClick={() => setMotionEnabled(value => !value)}
              aria-pressed={motionEnabled}
            >
              <PhoenixIcon name="network" size={17} />
              <span>{motionEnabled ? (lang === 'ar' ? 'الحركة مفعّلة' : 'Motion on') : (lang === 'ar' ? 'الحركة متوقفة' : 'Motion off')}</span>
            </button>
          ) : (
            <div className="nexus-topology__zoom" role="group" aria-label={lang === 'ar' ? 'تكبير الخريطة' : 'Map zoom'}>
              <button type="button" aria-label={lang === 'ar' ? 'تصغير' : 'Zoom out'} onClick={() => setZoom(z => Math.max(0.6, +(z - 0.2).toFixed(2)))}>−</button>
              <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" aria-label={lang === 'ar' ? 'تكبير' : 'Zoom in'} onClick={() => setZoom(z => Math.min(2, +(z + 0.2).toFixed(2)))}>+</button>
            </div>
          )}
        </div>
      </header>

      <div className="nexus-topology__viewport" data-view={effectiveView} ref={viewportRef}>
        {show3D && (
          <div className="nexus-twin" data-ready={sceneReady} data-webgl={webglReady ? 'on' : 'probing'}>
            {/* Static terrain backdrop. A plain <img>/<picture> served from a
                normal static URL — deliberately not a WebGL texture and not
                dependent on any service worker, so the twin renders identically
                with or without one. */}
            <picture className="nexus-twin__terrain" aria-hidden="true">
              <source srcSet="/assets/phoenix/runtime/phoenix-babil-terrain.avif" type="image/avif" />
              <img src="/assets/phoenix/runtime/phoenix-babil-terrain.webp" alt="" draggable={false} />
            </picture>
            <div className="nexus-twin__terrain-light" aria-hidden="true" />
            {webglReady && scene3d.nodes.length > 0 && (
              <Suspense fallback={<div className="nexus-twin__scene-loading" aria-hidden="true"><span /></div>}>
                <NetworkTwin3DScene
                  nodes={scene3d.nodes}
                  edges={scene3d.edges}
                  selectedId={selectedId}
                  motionEnabled={motionEnabled && !reducedMotion}
                  continuous={effects.continuous && renderActive}
                  dprCap={effects.profile.dprCap}
                  antialias={effects.profile.antialias}
                  onSelect={selectNode}
                  onReady={handleSceneReady}
                  onContextLost={handleContextLost}
                />
              </Suspense>
            )}
          </div>
        )}

        {!show3D && topology.nodes.length > 0 && (
          <svg
            className="nexus-topology__map"
            viewBox={`0 0 ${view2d.SW} ${view2d.SH}`}
            role="application"
            aria-label={lang === 'ar' ? 'خريطة شبكة الإمداد ثنائية الأبعاد' : 'Supply network 2D map'}
          >
            <g transform={`translate(${view2d.SW / 2} ${view2d.SH / 2}) scale(${zoom}) translate(${-view2d.SW / 2} ${-view2d.SH / 2})`}>
              {view2d.edges.map(edge => (
                <line
                  key={edge.id}
                  x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
                  stroke={edge.active ? 'var(--teal)' : 'var(--brd)'}
                  strokeWidth={edge.active ? 2 : 1.2}
                  strokeDasharray={edge.active ? undefined : '5 5'}
                  opacity={edge.active ? 0.7 : 0.4}
                />
              ))}
              {view2d.nodes.map(node => {
                const isSel = node.id === selectedId;
                const r = node.kind === 'outlet' ? 9 : node.kind === 'central' ? 15 : 12;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.sx} ${node.sy})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedId(current => current === node.id ? null : node.id)}
                  >
                    {node.alert && (
                      <circle
                        r={r + 6}
                        fill="none"
                        stroke={node.alert.severity === 'high' ? 'var(--danger, var(--err))' : node.alert.severity === 'medium' ? 'var(--warn)' : 'var(--gold)'}
                        strokeWidth={2}
                        className={reducedMotion ? undefined : 'nexus-topology__map-pulse'}
                      />
                    )}
                    <circle
                      r={isSel ? r + 3 : r}
                      fill={svg2dFill(node, isSel)}
                      stroke="var(--s)"
                      strokeWidth={2}
                      opacity={node.active ? 1 : 0.55}
                    />
                    <text
                      y={node.labelAbove ? -r - 8 : r + 16}
                      textAnchor="middle"
                      fill="var(--t)"
                      fontSize="12"
                      fontWeight="600"
                    >
                      {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {webglReady === false && (
          <div className="nexus-topology__fallback nexus-topology__fallback--corner">
            <PhoenixIcon name="network" size={16} />
            <span>{lang === 'ar' ? 'العرض الآمن (خريطة ثنائية)؛ WebGL غير مدعوم.' : 'Safe view (2D map); WebGL unavailable.'}</span>
          </div>
        )}
        {topology.nodes.length === 0 && (
          <div className="nexus-topology__fallback">
            <PhoenixIcon name="warehouse" size={28} />
            <span>{lang === 'ar' ? 'لا توجد عقد شبكية لعرضها بعد.' : 'No network nodes to display yet.'}</span>
          </div>
        )}
        <div className="nexus-topology__telemetry" aria-live="polite">
          <span>{topology.nodes.length} {lang === 'ar' ? 'عقدة' : 'nodes'}</span>
          <span>{activeRoutes} {lang === 'ar' ? 'رابط فعّال' : 'active links'}</span>
          {criticalCount > 0 && (
            <span className="nexus-topology__telemetry-alert">
              <PhoenixIcon name="warning" size={13} /> {criticalCount} {lang === 'ar' ? 'تنبيه حرج' : 'critical'}
            </span>
          )}
          <span className={webglReady ? 'is-live' : ''}>{webglReady ? 'GPU LIVE' : 'SAFE MODE'}</span>
        </div>
      </div>

      <div className="nexus-topology__legend">
        <span><i data-kind="central" />{lang === 'ar' ? 'مخزن قسم الصيدلة' : 'Pharmacy Department warehouse'}</span>
        <span><i data-kind="institution" />{lang === 'ar' ? 'مذخر مؤسسة' : 'Institution store'}</span>
        <span><i data-kind="outlet" />{lang === 'ar' ? 'منفذ' : 'Outlet'}</span>
      </div>

      <div className="nexus-topology__nodes" aria-label={lang === 'ar' ? 'عقد الشبكة' : 'Network nodes'}>
        {topology.nodes.slice(0, 12).map(node => (
          <button
            type="button"
            key={node.id}
            data-active={selectedId === node.id}
            data-alert={node.alert ? node.alert.severity : undefined}
            aria-label={
              node.alert
                ? `${node.label} — ${lang === 'ar' ? 'تنبيه' : 'alert'}: ${alertText(node.alert)}`
                : node.label
            }
            onClick={() => setSelectedId(current => current === node.id ? null : node.id)}
          >
            <span data-kind={node.kind} />
            <b>{node.label}</b>
            {node.alert ? (
              <small className="nexus-topology__node-alert">
                <PhoenixIcon name="warning" size={12} /> {alertText(node.alert)}
              </small>
            ) : (
              <small>{node.active ? (lang === 'ar' ? 'فعّال' : 'Active') : (lang === 'ar' ? 'غير فعّال' : 'Inactive')}</small>
            )}
          </button>
        ))}
      </div>

      {selected && (
        <div className="nexus-topology__selection" data-alert={selected.alert ? selected.alert.severity : undefined}>
          <PhoenixIcon name={selected.kind === 'outlet' ? 'outlet' : selected.kind === 'central' ? 'warehouse' : 'institutions'} size={18} />
          <strong>{selected.label}</strong>
          <span>{selected.active ? (lang === 'ar' ? 'متصل بالشبكة' : 'Connected to network') : (lang === 'ar' ? 'العقدة غير فعّالة' : 'Node inactive')}</span>
          {selected.alert && (
            <span className="nexus-topology__selection-alert">
              <PhoenixIcon name="warning" size={14} /> {alertText(selected.alert)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
