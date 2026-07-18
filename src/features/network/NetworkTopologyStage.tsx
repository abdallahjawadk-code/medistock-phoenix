import { useEffect, useMemo, useRef, useState } from 'react';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import type { NetworkWarehouse, SupplyRoute } from './network.service';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

type Lang = 'ar' | 'en';
type NodeKind = 'central' | 'institution' | 'outlet';
type Position = [number, number, number];

interface TopologyNode {
  id: string;
  label: string;
  kind: NodeKind;
  active: boolean;
  position: Position;
}

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
}

function labelOf(item: { name: string; name_ar: string }, lang: Lang) {
  return lang === 'ar' ? (item.name_ar || item.name) : (item.name || item.name_ar);
}

function stableAngle(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return (Math.abs(hash) % 360) * Math.PI / 180;
}

function nodeColor(node: TopologyNode, selected: boolean): [number, number, number] {
  if (!node.active) return [.36, .45, .52];
  if (selected) return [1, .72, .24];
  if (node.kind === 'central') return [.96, .44, .14];
  if (node.kind === 'institution') return [.08, .75, .62];
  return [.28, .79, .94];
}

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
      gl_PointSize = aSize * perspective;
      vColor = aColor;
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 vColor;
    uniform float uPointMode;

    void main() {
      float alpha = .56;
      if (uPointMode > .5) {
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

export function NetworkTopologyStage({ lang, warehouses, routes, outlets, organizationName }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true);

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
  }, [warehouses, routes, outlets, lang]);

  useEffect(() => {
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
    const pointBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();
    if (!pointBuffer || !lineBuffer || positionLocation < 0 || colorLocation < 0 || sizeLocation < 0) {
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

    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointData), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.STATIC_DRAW);

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let width = 1;
    let height = 1;
    let frame = 0;
    let disposed = false;
    let tiltX = 0;
    let tiltY = -.08;
    let pageVisible = !document.hidden;
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
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
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

      bindAttributes(lineBuffer);
      gl.uniform1f(pointModeLocation, 0);
      gl.drawArrays(gl.LINES, 0, lineData.length / 7);

      bindAttributes(pointBuffer);
      gl.uniform1f(pointModeLocation, 1);
      gl.drawArrays(gl.POINTS, 0, pointData.length / 7);

      if (motionEnabled && !reducedMotion && pageVisible) frame = window.requestAnimationFrame(draw);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tiltX = ((event.clientX - rect.left) / Math.max(rect.width, 1) - .5) * .24;
      tiltY = -(((event.clientY - rect.top) / Math.max(rect.height, 1) - .5) * .16);
      if (!motionEnabled || reducedMotion) draw(performance.now());
    };

    const onPointerLeave = () => {
      tiltX = 0;
      tiltY = -.08;
      if (!motionEnabled || reducedMotion) draw(performance.now());
    };

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      if (!pageVisible) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      draw(performance.now());
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
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
      canvas.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(lineBuffer);
      gl.deleteProgram(program);
    };
  }, [topology, selectedId, motionEnabled]);

  const selected = topology.nodes.find(node => node.id === selectedId) ?? null;
  const activeRoutes = topology.edges.filter(edge => edge.active).length;
  const selectedEdges = selected
    ? topology.edges.filter(edge => edge.source === selected.id || edge.target === selected.id)
    : [];
  const selectedActiveEdges = selectedEdges.filter(edge => edge.active).length;
  const selectedKindLabel = selected?.kind === 'central'
    ? (lang === 'ar' ? 'مخزن قسم الصيدلة' : 'Pharmacy warehouse')
    : selected?.kind === 'institution'
      ? (lang === 'ar' ? 'مذخر مؤسسة' : 'Institution store')
      : (lang === 'ar' ? 'منفذ' : 'Outlet');

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
        <button
          type="button"
          className="nexus-control nexus-topology__motion"
          onClick={() => setMotionEnabled(value => !value)}
          aria-pressed={motionEnabled}
        >
          <PhoenixIcon name="network" size={17} />
          <span>{motionEnabled ? (lang === 'ar' ? 'الحركة مفعّلة' : 'Motion on') : (lang === 'ar' ? 'الحركة متوقفة' : 'Motion off')}</span>
        </button>
      </header>

      <div className="nexus-topology__viewport">
        <canvas ref={canvasRef} className="nexus-topology__canvas" aria-hidden="true" />
        {webglReady === false && (
          <div className="nexus-topology__fallback">
            <PhoenixIcon name="network" size={28} />
            <span>{lang === 'ar' ? 'العرض الآمن متاح؛ WebGL غير مدعوم في هذا الجهاز.' : 'Safe view active; WebGL is unavailable on this device.'}</span>
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
          <span className={webglReady ? 'is-live' : ''}>{webglReady ? 'GPU LIVE' : 'SAFE MODE'}</span>
        </div>
      </div>

      <div className="nexus-topology__legend">
        <span><i data-kind="central" />{lang === 'ar' ? 'مخزن قسم الصيدلة' : 'Pharmacy Department warehouse'}</span>
        <span><i data-kind="institution" />{lang === 'ar' ? 'مذخر مؤسسة' : 'Institution store'}</span>
        <span><i data-kind="outlet" />{lang === 'ar' ? 'منفذ' : 'Outlet'}</span>
      </div>

      <div className="nexus-topology__nodes" aria-label={lang === 'ar' ? 'عقد الشبكة' : 'Network nodes'}>
        {topology.nodes.map(node => (
          <button
            type="button"
            key={node.id}
            data-active={selectedId === node.id}
            aria-pressed={selectedId === node.id}
            aria-label={`${node.label} · ${node.active ? (lang === 'ar' ? 'فعّال' : 'Active') : (lang === 'ar' ? 'غير فعّال' : 'Inactive')}`}
            onClick={() => setSelectedId(current => current === node.id ? null : node.id)}
            onFocus={() => setSelectedId(node.id)}
            onPointerEnter={() => setSelectedId(node.id)}
          >
            <span data-kind={node.kind} />
            <b>{node.label}</b>
            <small>{node.active ? (lang === 'ar' ? 'فعّال' : 'Active') : (lang === 'ar' ? 'غير فعّال' : 'Inactive')}</small>
          </button>
        ))}
      </div>

      {selected && (
        <div className="nexus-topology__selection">
          <PhoenixIcon name={selected.kind === 'outlet' ? 'outlet' : selected.kind === 'central' ? 'warehouse' : 'institutions'} size={18} />
          <strong>{selected.label}</strong>
          <span className="nexus-topology__selection-status">{selected.active ? (lang === 'ar' ? 'متصل بالشبكة' : 'Connected to network') : (lang === 'ar' ? 'العقدة غير فعّالة' : 'Node inactive')}</span>
          <dl>
            <div>
              <dt>{lang === 'ar' ? 'النوع' : 'Type'}</dt>
              <dd>{selectedKindLabel}</dd>
            </div>
            <div>
              <dt>{lang === 'ar' ? 'الروابط' : 'Links'}</dt>
              <dd>{selectedEdges.length}</dd>
            </div>
            <div>
              <dt>{lang === 'ar' ? 'الفعّالة' : 'Active'}</dt>
              <dd>{selectedActiveEdges}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
