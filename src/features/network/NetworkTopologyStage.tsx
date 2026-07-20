import { useEffect, useMemo, useRef, useState } from 'react';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import type { NetworkWarehouse, SupplyRoute } from './network.service';
import type { InventorySeverity, InventorySignalType } from '@/features/inventory/inventory-intelligence.service';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { computeTwin2dLayout } from './twinLayout';

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

// Identity tier mapping (mandate): central = Ember/Gold, institution = Ion Cyan
// (#62E9FF), outlet = Medical Teal (#138F88). Alert state is conveyed by the
// pulsing ring + DOM icon/text, never by colour alone.
function nodeColor(node: TopologyNode, selected: boolean): [number, number, number] {
  if (!node.active) return [.36, .45, .52];
  if (selected) return [1, .72, .24];
  if (node.kind === 'central') return [.96, .44, .14];
  if (node.kind === 'institution') return [.38, .914, 1.0];
  return [.075, .561, .533];
}

/** Ring colour by severity: high = danger red, medium = amber, low = gold. */
function alertRingColor(sev: InventorySeverity): [number, number, number] {
  if (sev === 'high') return [.95, .27, .32];
  if (sev === 'medium') return [.97, .66, .22];
  return [.87, .73, .39];
}

const SEVERITY_RANK: Record<InventorySeverity, number> = { high: 0, medium: 1, low: 2 };

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    attribute float aSize;
    varying vec3 vColor;
    uniform float uRotation;
    uniform vec2 uTilt;
    uniform float uAspect;
    uniform float uSizeScale;

    void main() {
      float cy = cos(uRotation + uTilt.x);
      float sy = sin(uRotation + uTilt.x);
      float cx = cos(uTilt.y);
      float sx = sin(uTilt.y);
      vec3 p = vec3(
        aPosition.x * cy - aPosition.z * sy,
        aPosition.y,
        aPosition.x * sy + aPosition.z * cy
      );
      p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
      float depth = max(2.8, 4.25 - p.z);
      float perspective = 3.55 / depth;
      gl_Position = vec4((p.x * perspective) / max(uAspect, .6), p.y * perspective, 0.0, 1.0);
      gl_PointSize = aSize * perspective * uSizeScale;
      vColor = aColor;
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 vColor;
    uniform float uPointMode;

    void main() {
      float alpha = .56;
      if (uPointMode > 1.5) {
        // Alert ring/halo: bright annulus, hollow centre — a pulsing alert cue.
        vec2 center = gl_PointCoord - vec2(.5);
        float radius = length(center);
        if (radius > .5) discard;
        alpha = smoothstep(.28, .42, radius) * (1.0 - smoothstep(.42, .5, radius));
        alpha *= .85;
      } else if (uPointMode > .5) {
        vec2 center = gl_PointCoord - vec2(.5);
        float radius = length(center);
        if (radius > .5) discard;
        alpha = 1.0 - smoothstep(.32, .5, radius);
        alpha = max(alpha, .24);
      }
      gl_FragColor = vec4(vColor, alpha);
    }
  `);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function NetworkTopologyStage({ lang, warehouses, routes, outlets, organizationName, alerts }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true);
  // Adjacent 3D (WebGL) / 2D (SVG map) views. When WebGL is unavailable the 2D
  // map becomes the safe fallback and the 3D tab is disabled.
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [zoom, setZoom] = useState(1);

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
      }));

    outlets.forEach(outlet => {
      if (outlet.warehouseId && nodeIds.has(outlet.warehouseId)) {
        edges.push({
          id: `outlet-${outlet.id}`,
          source: outlet.warehouseId,
          target: outlet.id,
          active: outlet.status === 'active',
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

  // WebGL unknown (null) or ok (true) keeps 3D selectable; a hard false forces
  // the 2D safe view. The user's explicit tab choice wins while 3D is viable.
  const canUse3D = webglReady !== false;
  const effectiveView: '3d' | '2d' = canUse3D ? view : '2d';
  const show3D = effectiveView === '3d';

  useEffect(() => {
    if (!show3D) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      setWebglReady(false);
      return undefined;
    }

    const program = createProgram(gl);
    if (!program) {
      setWebglReady(false);
      return undefined;
    }

    setWebglReady(true);
    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    const colorLocation = gl.getAttribLocation(program, 'aColor');
    const sizeLocation = gl.getAttribLocation(program, 'aSize');
    const rotationLocation = gl.getUniformLocation(program, 'uRotation');
    const tiltLocation = gl.getUniformLocation(program, 'uTilt');
    const aspectLocation = gl.getUniformLocation(program, 'uAspect');
    const pointModeLocation = gl.getUniformLocation(program, 'uPointMode');
    const sizeScaleLocation = gl.getUniformLocation(program, 'uSizeScale');
    const pointBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();
    const alertBuffer = gl.createBuffer();
    if (!pointBuffer || !lineBuffer || !alertBuffer || positionLocation < 0 || colorLocation < 0 || sizeLocation < 0) {
      gl.deleteProgram(program);
      setWebglReady(false);
      return undefined;
    }

    const byId = new Map(topology.nodes.map(node => [node.id, node]));
    const pointData: number[] = [];
    topology.nodes.forEach(node => {
      const color = nodeColor(node, node.id === selectedId);
      pointData.push(...node.position, ...color, node.id === selectedId ? 24 : node.kind === 'outlet' ? 12 : 17);
    });

    const lineData: number[] = [];
    topology.edges.forEach(edge => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return;
      const color: [number, number, number] = edge.active ? [.20, .69, .73] : [.28, .35, .4];
      lineData.push(...source.position, ...color, 1, ...target.position, ...color, 1);
    });

    // Alert halo/ring pass — one bigger vertex per alerted node, coloured by
    // severity. Drawn as a hollow pulsing ring so alerts read as more than a
    // colour (paired with the DOM icon+text list/detail for accessibility).
    const alertData: number[] = [];
    topology.nodes.forEach(node => {
      if (!node.alert) return;
      const color = alertRingColor(node.alert.severity);
      const base = node.kind === 'outlet' ? 26 : 34;
      alertData.push(...node.position, ...color, base);
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointData), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, alertBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(alertData), gl.STATIC_DRAW);

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let width = 1;
    let height = 1;
    let frame = 0;
    let disposed = false;
    let tiltX = 0;
    let tiltY = -.08;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const bindAttributes = (buffer: WebGLBuffer) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const stride = 7 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(colorLocation);
      gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
      gl.enableVertexAttribArray(sizeLocation);
      gl.vertexAttribPointer(sizeLocation, 1, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    };

    const draw = (time: number) => {
      if (disposed) return;
      resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform1f(rotationLocation, motionEnabled && !reducedMotion ? time * .000055 : .12);
      gl.uniform2f(tiltLocation, tiltX, tiltY);
      gl.uniform1f(aspectLocation, width / Math.max(height, 1));

      gl.uniform1f(sizeScaleLocation, 1);
      bindAttributes(lineBuffer);
      gl.uniform1f(pointModeLocation, 0);
      gl.drawArrays(gl.LINES, 0, lineData.length / 7);

      // Alert rings first (behind nodes), pulsing when motion is allowed.
      if (alertData.length > 0) {
        const pulse = motionEnabled && !reducedMotion ? 1 + Math.sin(time * 0.0045) * 0.16 : 1.12;
        gl.uniform1f(sizeScaleLocation, pulse);
        gl.uniform1f(pointModeLocation, 2);
        bindAttributes(alertBuffer);
        gl.drawArrays(gl.POINTS, 0, alertData.length / 7);
        gl.uniform1f(sizeScaleLocation, 1);
      }

      bindAttributes(pointBuffer);
      gl.uniform1f(pointModeLocation, 1);
      gl.drawArrays(gl.POINTS, 0, pointData.length / 7);

      // Keep animating while there are pulsing alert rings, even if idle motion
      // is off, so the pulse stays alive (unless the user asked for reduced motion).
      if ((motionEnabled || alertData.length > 0) && !reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tiltX = ((event.clientX - rect.left) / Math.max(rect.width, 1) - .5) * .24;
      tiltY = -(((event.clientY - rect.top) / Math.max(rect.height, 1) - .5) * .16);
      if (!motionEnabled || reducedMotion) draw(performance.now());
    };

    canvas.addEventListener('pointermove', onPointerMove);
    const observer = new ResizeObserver(() => {
      resize();
      if (!motionEnabled || reducedMotion) draw(performance.now());
    });
    observer.observe(canvas);
    draw(performance.now());

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(lineBuffer);
      gl.deleteBuffer(alertBuffer);
      gl.deleteProgram(program);
    };
  }, [topology, selectedId, motionEnabled, show3D]);

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

      <div className="nexus-topology__viewport" data-view={effectiveView}>
        {show3D && <canvas ref={canvasRef} className="nexus-topology__canvas" aria-hidden="true" />}

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
