/* ─── PHOENIX WEBGL — rebirth scene (welcome) ──────────────────────────────────
   The real 3D rebirth choreography: a GPU point cloud that morphs from an ash
   cloud into a firebird silhouette while a core ignites and the camera dollies
   in and tilts up. Timeline is driven by a wall clock started at mount so it
   completes deterministically in ~durationMs and fires onDone once. All GPU
   resources are created in useMemo and disposed by R3F on unmount.
   ─────────────────────────────────────────────────────────────────────────── */
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { REBIRTH_VERTEX, REBIRTH_FRAGMENT } from './welcomeShaders';

const COL = {
  ember: new THREE.Color('#ff7a1a'),
  gold: new THREE.Color('#ddba63'),
  cyan: new THREE.Color('#62e9ff'),
  deep: new THREE.Color('#04101f'),
};

/** Build a firebird silhouette of `count` points (local space, +y up). */
function buildPhoenixTargets(count: number) {
  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  const jitter = () => (Math.random() - 0.5) * 0.14;

  for (let i = 0; i < count; i++) {
    const seg = Math.random();
    let x = 0;
    let y = 0;
    let z = jitter();

    if (seg < 0.28) {
      // Body / spine — curved column.
      const u = Math.random();
      y = -0.7 + u * 2.1;
      x = Math.sin(u * 2.2) * 0.16 + jitter();
    } else if (seg < 0.78) {
      // Wings — two symmetric upward-sweeping arcs.
      const side = Math.random() < 0.5 ? -1 : 1;
      const u = Math.random();
      x = side * (0.18 + u * 1.9);
      y = 0.35 + Math.sin(u * 1.5) * 1.35 - u * 0.25 + jitter();
      z = (Math.random() - 0.5) * 0.4;
    } else if (seg < 0.92) {
      // Tail — downward spreading plume.
      const u = Math.random();
      y = -0.7 - u * 1.5;
      x = (Math.random() - 0.5) * (0.4 + u * 0.9);
    } else {
      // Head / crest cluster.
      const u = Math.random();
      y = 1.35 + u * 0.4;
      x = Math.sin(u * 6.28) * 0.14 + jitter();
    }

    target[i * 3] = x;
    target[i * 3 + 1] = y;
    target[i * 3 + 2] = z;

    // Ash cloud origin — a loose sphere the bird condenses out of.
    const r = 1.6 + Math.random() * 2.2;
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    scatter[i * 3] = Math.sin(b) * Math.cos(a) * r;
    scatter[i * 3 + 1] = Math.cos(b) * r * 0.8;
    scatter[i * 3 + 2] = Math.sin(b) * Math.sin(a) * r * 0.7;

    seeds[i] = Math.random();
    scales[i] = 0.5 + Math.random() * 1.1;
  }
  return { target, scatter, seeds, scales };
}

interface Props {
  particleCount: number;
  durationMs: number;
  onDone: () => void;
}

export function PhoenixWelcomeScene({ particleCount, durationMs, onDone }: Props) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const start = useRef<number | null>(null);
  const done = useRef(false);
  const { camera } = useThree();

  const geometry = useMemo(() => {
    const { target, scatter, seeds, scales } = buildPhoenixTargets(particleCount);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(target, 3));
    g.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    g.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    return g;
  }, [particleCount]);

  const uniforms = useMemo(
    () => ({
      uProgress: { value: 0 },
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uSize: { value: 30 },
      uColorCore: { value: COL.gold.clone() },
      uColorEdge: { value: COL.ember.clone() },
      uColorSpark: { value: COL.cyan.clone() },
    }),
    [],
  );

  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime;
    const p = Math.min((state.clock.elapsedTime - start.current) / (durationMs / 1000), 1);

    if (matRef.current) matRef.current.uniforms.uProgress.value = p;

    // Core ignition: dark → blazing, growing as the bird forms.
    if (coreRef.current && coreMatRef.current) {
      const ignite = THREE.MathUtils.smoothstep(p, 0.05, 0.45);
      coreMatRef.current.emissiveIntensity = 0.2 + ignite * 2.6;
      const s = 0.15 + ignite * 0.55;
      coreRef.current.scale.setScalar(s);
      coreRef.current.rotation.y = p * 3.0;
    }

    // Camera: dolly in and tilt up as the phoenix rises.
    const ease = 1 - Math.pow(1 - p, 3);
    camera.position.z = THREE.MathUtils.lerp(8.2, 5.2, ease);
    camera.position.y = THREE.MathUtils.lerp(-0.5, 0.5, ease);
    camera.lookAt(0, THREE.MathUtils.lerp(-0.2, 0.55, ease), 0);

    if (p >= 1 && !done.current) {
      done.current = true;
      onDone();
    }
  });

  return (
    <>
      <color attach="background" args={[COL.deep.r, COL.deep.g, COL.deep.b]} />
      <fog attach="fog" args={['#030c17', 6, 16]} />
      <ambientLight intensity={0.3} color={COL.cyan} />
      <pointLight position={[0, 0.5, 2.5]} intensity={26} distance={14} color={COL.ember} />
      <pointLight position={[-2.6, 1.8, 1.6]} intensity={12} distance={11} color={COL.cyan} />

      <mesh ref={coreRef}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial
          ref={coreMatRef}
          color={COL.deep}
          emissive={COL.ember}
          emissiveIntensity={0.2}
          roughness={0.3}
          metalness={0.65}
          flatShading
        />
      </mesh>

      <points geometry={geometry}>
        <shaderMaterial
          ref={matRef}
          vertexShader={REBIRTH_VERTEX}
          fragmentShader={REBIRTH_FRAGMENT}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  );
}
