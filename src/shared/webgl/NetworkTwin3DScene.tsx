import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import type { TwinSceneEdge, TwinSceneNode } from '@/features/network/NetworkTopologyStage';

interface Props {
  nodes: TwinSceneNode[];
  edges: TwinSceneEdge[];
  selectedId: string | null;
  motionEnabled: boolean;
  continuous: boolean;
  dprCap: number;
  antialias: boolean;
  onSelect: (id: string) => void;
  onReady: () => void;
  onContextLost: () => void;
}

type WorldNode = TwinSceneNode & { position: THREE.Vector3 };

function useWorldTopology(nodes: TwinSceneNode[], edges: TwinSceneEdge[]) {
  const viewport = useThree(state => state.viewport);
  return useMemo(() => {
    const worldNodes: WorldNode[] = nodes.map(node => ({
      ...node,
      position: new THREE.Vector3(
        (node.x / 100 - .5) * viewport.width,
        (.5 - node.y / 100) * viewport.height,
        node.kind === 'central' ? .42 : node.kind === 'institution' ? .3 : .2,
      ),
    }));
    const byId = new Map(worldNodes.map(node => [node.id, node]));
    const worldEdges = edges.flatMap(edge => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      return source && target ? [{ ...edge, sourceNode: source, targetNode: target }] : [];
    });
    return { worldNodes, worldEdges };
  }, [edges, nodes, viewport.height, viewport.width]);
}

function ReadySignal({ onReady }: { onReady: () => void }) {
  const sent = useRef(false);
  useFrame(() => {
    if (sent.current) return;
    sent.current = true;
    onReady();
  });
  return null;
}

function ContextLossGuard({ onContextLost }: { onContextLost: () => void }) {
  const gl = useThree(state => state.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    const handleLost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener('webglcontextlost', handleLost, false);
    return () => canvas.removeEventListener('webglcontextlost', handleLost, false);
  }, [gl, onContextLost]);
  return null;
}

function AnimatedRing({ color, radius, motionEnabled, speed = 1 }: {
  color: string;
  radius: number;
  motionEnabled: boolean;
  speed?: number;
}) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current || !motionEnabled) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 2.2 * speed) * .13;
    ring.current.scale.setScalar(pulse);
    ring.current.rotation.z = clock.elapsedTime * .14 * speed;
  });
  return (
    <mesh ref={ring} position={[0, 0, -.08]}>
      <torusGeometry args={[radius, .018, 8, 56]} />
      <meshBasicMaterial color={color} transparent opacity={.86} toneMapped={false} />
    </mesh>
  );
}

function MedicalCross({ color = '#b9fbff', scale = 1 }: { color?: string; scale?: number }) {
  return (
    <group position={[0, .02, .2]} scale={scale}>
      <mesh><boxGeometry args={[.08, .25, .035]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.8} /></mesh>
      <mesh><boxGeometry args={[.25, .08, .035]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.8} /></mesh>
    </group>
  );
}

function CentralBuilding() {
  return (
    <group rotation={[.2, -.28, -.02]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[.88, .52, .38]} />
        <meshStandardMaterial color="#5c5548" metalness={.72} roughness={.28} emissive="#7b3d10" emissiveIntensity={.18} />
      </mesh>
      <mesh position={[0, .31, .02]} castShadow>
        <boxGeometry args={[.68, .1, .3]} />
        <meshStandardMaterial color="#aa7b3d" metalness={.82} roughness={.2} emissive="#ff861d" emissiveIntensity={.7} />
      </mesh>
      {[-.29, -.1, .1, .29].map(offset => (
        <mesh key={offset} position={[offset, -.23, .205]}>
          <boxGeometry args={[.11, .14, .035]} />
          <meshStandardMaterial color="#081525" metalness={.55} roughness={.36} />
        </mesh>
      ))}
      <MedicalCross color="#ffe4a3" scale={.72} />
    </group>
  );
}

function InstitutionBuilding() {
  return (
    <group rotation={[.18, -.32, -.015]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[.52, .36, .3]} />
        <meshStandardMaterial color="#60798a" metalness={.58} roughness={.34} emissive="#0f8ca0" emissiveIntensity={.14} />
      </mesh>
      <mesh position={[0, .22, 0]} castShadow>
        <boxGeometry args={[.38, .09, .24]} />
        <meshStandardMaterial color="#91a8b4" metalness={.5} roughness={.32} />
      </mesh>
      {[-.16, 0, .16].map(offset => (
        <mesh key={offset} position={[offset, -.08, .165]}>
          <boxGeometry args={[.065, .09, .028]} />
          <meshStandardMaterial color="#6ff4ff" emissive="#43dff2" emissiveIntensity={1.25} toneMapped={false} />
        </mesh>
      ))}
      <MedicalCross />
    </group>
  );
}

function OutletBuilding() {
  return (
    <group rotation={[.17, -.28, 0]}>
      <mesh castShadow>
        <cylinderGeometry args={[.14, .18, .22, 6]} />
        <meshStandardMaterial color="#3b776f" metalness={.68} roughness={.28} emissive="#0e8d86" emissiveIntensity={.3} />
      </mesh>
      <mesh position={[0, .15, 0]}>
        <cylinderGeometry args={[.17, .14, .06, 6]} />
        <meshStandardMaterial color="#7ad6c4" metalness={.62} roughness={.24} />
      </mesh>
    </group>
  );
}

function FacilityNode({ node, selected, motionEnabled, onSelect }: {
  node: WorldNode;
  selected: boolean;
  motionEnabled: boolean;
  onSelect: () => void;
}) {
  const group = useRef<THREE.Group>(null);
  const scale = node.kind === 'central' ? 1.24 : node.kind === 'institution' ? .92 : .72;
  const identity = node.kind === 'central' ? '#ff9b31' : node.kind === 'institution' ? '#63eaff' : '#4dd2be';
  const alertColor = node.alert?.severity === 'high' ? '#ff4d56' : node.alert?.severity === 'medium' ? '#ff9d23' : '#e0bd59';

  useFrame(({ clock }) => {
    if (!group.current || !motionEnabled) return;
    group.current.position.z = node.position.z + Math.sin(clock.elapsedTime * 1.45 + node.x) * .018;
  });

  return (
    <group
      ref={group}
      position={node.position}
      scale={scale}
      onClick={event => { event.stopPropagation(); onSelect(); }}
      onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <mesh position={[0, -.2, -.08]} receiveShadow>
        <cylinderGeometry args={[node.kind === 'central' ? .58 : .36, node.kind === 'central' ? .7 : .46, .07, 32]} />
        <meshStandardMaterial color="#07111c" metalness={.82} roughness={.38} transparent opacity={.9} />
      </mesh>
      {node.kind === 'central' ? <CentralBuilding /> : node.kind === 'institution' ? <InstitutionBuilding /> : <OutletBuilding />}
      <AnimatedRing color={selected ? '#7dbbff' : identity} radius={node.kind === 'central' ? .72 : node.kind === 'institution' ? .48 : .31} motionEnabled={motionEnabled} speed={selected ? 1.45 : .8} />
      {node.alert && <AnimatedRing color={alertColor} radius={node.kind === 'central' ? .86 : node.kind === 'institution' ? .6 : .42} motionEnabled={motionEnabled} speed={1.65} />}
      <pointLight color={selected ? '#79b7ff' : identity} intensity={selected ? 2.8 : 1.3} distance={2.4} decay={2} position={[0, .12, .75]} />
    </group>
  );
}

function RouteGlow({ source, target, active, kind, motionEnabled, selected }: {
  source: WorldNode;
  target: WorldNode;
  active: boolean;
  kind: TwinSceneEdge['kind'];
  motionEnabled: boolean;
  selected: boolean;
}) {
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const curve = useMemo(() => {
    const midpoint = source.position.clone().lerp(target.position, .5);
    midpoint.z = Math.max(source.position.z, target.position.z) + (kind === 'direct' ? .2 : .08);
    return new THREE.QuadraticBezierCurve3(source.position, midpoint, target.position);
  }, [kind, source.position, target.position]);
  const color = selected ? '#ffad3d' : kind === 'direct' ? '#67eaff' : '#4ad2bd';

  useFrame(({ clock }) => {
    if (!material.current || !motionEnabled) return;
    material.current.emissiveIntensity = 1.25 + Math.sin(clock.elapsedTime * 2.4 + source.x) * .42;
  });

  return (
    <mesh>
      <tubeGeometry args={[curve, 36, selected ? .024 : kind === 'direct' ? .016 : .01, 7, false]} />
      <meshStandardMaterial
        ref={material}
        color={active ? color : '#52616c'}
        emissive={active ? color : '#202932'}
        emissiveIntensity={active ? 1.35 : .15}
        transparent
        opacity={active ? (selected ? .98 : .72) : .28}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function SupplyVehicle({ source, target, motionEnabled }: {
  source: WorldNode;
  target: WorldNode;
  motionEnabled: boolean;
}) {
  const vehicle = useRef<THREE.Group>(null);
  const curve = useMemo(() => {
    const midpoint = source.position.clone().lerp(target.position, .5);
    midpoint.z += .24;
    return new THREE.QuadraticBezierCurve3(source.position, midpoint, target.position);
  }, [source.position, target.position]);

  useFrame(({ clock }) => {
    if (!vehicle.current) return;
    const progress = motionEnabled ? (clock.elapsedTime * .055) % 1 : .62;
    const point = curve.getPointAt(progress);
    const tangent = curve.getTangentAt(progress);
    vehicle.current.position.copy(point);
    vehicle.current.position.z += .09;
    vehicle.current.rotation.z = Math.atan2(tangent.y, tangent.x);
  });

  return (
    <group ref={vehicle} scale={.38}>
      <mesh castShadow><boxGeometry args={[.42, .22, .18]} /><meshStandardMaterial color="#e8edf0" metalness={.38} roughness={.3} /></mesh>
      <mesh position={[-.13, .01, .11]}><boxGeometry args={[.12, .06, .02]} /><meshBasicMaterial color="#37bfe1" toneMapped={false} /></mesh>
      <mesh position={[-.13, .01, .135]}><boxGeometry args={[.035, .14, .018]} /><meshBasicMaterial color="#37bfe1" toneMapped={false} /></mesh>
      <pointLight color="#ffad3d" intensity={2.4} distance={1.4} decay={2} position={[.25, 0, .2]} />
    </group>
  );
}

function RadarSweep({ motionEnabled }: { motionEnabled: boolean }) {
  const sweep = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (sweep.current && motionEnabled) sweep.current.rotation.z = clock.elapsedTime * .12;
  });
  return (
    <mesh ref={sweep} position={[0, 0, -.2]}>
      <ringGeometry args={[2.1, 2.12, 96, 1, 0, Math.PI * 1.25]} />
      <meshBasicMaterial color="#45c9d8" transparent opacity={.12} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function SceneContent({ nodes, edges, selectedId, motionEnabled, onSelect }: Pick<Props, 'nodes' | 'edges' | 'selectedId' | 'motionEnabled' | 'onSelect'>) {
  const { worldNodes, worldEdges } = useWorldTopology(nodes, edges);
  const firstDelivery = worldEdges.find(edge => edge.kind === 'direct' && edge.active);

  return (
    <>
      <ambientLight intensity={.82} color="#a9c4d3" />
      <directionalLight castShadow position={[-3.5, 5.5, 8]} intensity={2.15} color="#ffe0b5" shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
      <directionalLight position={[5, -2, 5]} intensity={1.25} color="#58dcff" />
      <pointLight position={[0, 1.2, 4]} intensity={1.4} color="#2e8aa8" distance={12} />
      <RadarSweep motionEnabled={motionEnabled} />
      {worldEdges.map(edge => (
        <RouteGlow
          key={edge.id}
          source={edge.sourceNode}
          target={edge.targetNode}
          active={edge.active}
          kind={edge.kind}
          motionEnabled={motionEnabled}
          selected={edge.source === selectedId || edge.target === selectedId}
        />
      ))}
      {worldNodes.map(node => (
        <FacilityNode key={node.id} node={node} selected={node.id === selectedId} motionEnabled={motionEnabled} onSelect={() => onSelect(node.id)} />
      ))}
      {firstDelivery && <SupplyVehicle source={firstDelivery.sourceNode} target={firstDelivery.targetNode} motionEnabled={motionEnabled} />}
    </>
  );
}

export function NetworkTwin3DScene({ nodes, edges, selectedId, motionEnabled, continuous, dprCap, antialias, onSelect, onReady, onContextLost }: Props) {
  const handleCreated = (state: RootState) => {
    state.gl.setClearColor(0x000000, 0);
    state.gl.toneMapping = THREE.ACESFilmicToneMapping;
    state.gl.toneMappingExposure = 1.08;
    state.gl.outputColorSpace = THREE.SRGBColorSpace;
    state.camera.lookAt(0, 0, 0);
  };

  return (
    <div className="nexus-twin__webgl" aria-hidden="true">
      <Canvas
        orthographic
        shadows
        frameloop={motionEnabled && continuous ? 'always' : 'demand'}
        dpr={[1, dprCap]}
        camera={{ position: [0, 0, 10], zoom: 82, near: .1, far: 40 }}
        gl={{ alpha: true, antialias, powerPreference: 'high-performance' }}
        onCreated={handleCreated}
      >
        <ReadySignal onReady={onReady} />
        <ContextLossGuard onContextLost={onContextLost} />
        <SceneContent nodes={nodes} edges={edges} selectedId={selectedId} motionEnabled={motionEnabled && continuous} onSelect={onSelect} />
      </Canvas>
    </div>
  );
}
