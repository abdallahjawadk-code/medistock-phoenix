/* ─── PHOENIX WEBGL — the real 3D scene ────────────────────────────────────────
   A genuine Three.js scene (not an image on a plane): a perspective camera with
   pointer parallax, real lights, an emissive icosahedron "phoenix core" that
   breathes and rotates, an additive halo, and a GPU-driven rising ember field
   with a custom GLSL ShaderMaterial. Everything is disposed on unmount.
   Consumed only through <PhoenixCanvas> (which owns DPR, frameloop, context-loss
   and the 2D fallback), so this module is pure scene content.
   ─────────────────────────────────────────────────────────────────────────── */
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  EMBER_VERTEX,
  EMBER_FRAGMENT,
  HALO_VERTEX,
  HALO_FRAGMENT,
} from './emberShaders';

const COL = {
  ember: new THREE.Color('#ff7a1a'),
  gold: new THREE.Color('#ddba63'),
  cyan: new THREE.Color('#62e9ff'),
  teal: new THREE.Color('#138f88'),
  deep: new THREE.Color('#071426'),
};

export type PhoenixVariant = 'login' | 'welcome';

interface SceneProps {
  variant: PhoenixVariant;
  particleCount: number;
  /** When true, animation is frozen to a single composed frame. */
  still: boolean;
  /** Pointer-parallax intensity (0 disables, e.g. touch / reduced-motion). */
  parallax: number;
}

/** Rising ember point cloud with a custom additive shader. */
function EmberField({ count, still, rise }: { count: number; still: boolean; rise: number }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const { size } = useThree();

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const scales = new Float32Array(count);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Emit from a disc around the origin, biased toward the centre column.
      const r = Math.pow(Math.random(), 1.6) * 3.4;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = -1.6 + Math.random() * 1.2;
      positions[i * 3 + 2] = Math.sin(a) * r * 0.7;
      seeds[i] = Math.random();
      scales[i] = 0.4 + Math.random() * 1.0;
      velocities[i * 3] = (Math.random() - 0.5) * 0.4;
      velocities[i * 3 + 1] = 0.2 + Math.random() * 0.5;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    g.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    g.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    return g;
  }, [count]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uSize: { value: 26 },
      uRise: { value: rise },
      uColorCore: { value: COL.gold.clone() },
      uColorEdge: { value: COL.ember.clone() },
      uColorSpark: { value: COL.cyan.clone() },
    }),
    [rise],
  );

  useFrame((state) => {
    if (still) return;
    if (matRef.current) matRef.current.uniforms.uTime.value = state.clock.elapsedTime;
  });

  // Compose one frame for the still (reduced-motion) path.
  useMemo(() => {
    if (still) uniforms.uTime.value = 0.42;
  }, [still, uniforms]);

  useMemo(() => {
    uniforms.uPixelRatio.value = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      2,
    );
  }, [size, uniforms]);

  return (
    <points geometry={geometry}>
      <shaderMaterial
        ref={matRef}
        vertexShader={EMBER_VERTEX}
        fragmentShader={EMBER_FRAGMENT}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** Emissive core that slowly rotates and "breathes". */
function PhoenixCore({ still }: { still: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const haloUniforms = useMemo(
    () => ({ uColor: { value: COL.ember.clone() }, uIntensity: { value: 0.9 } }),
    [],
  );

  useFrame((state, delta) => {
    if (still || !meshRef.current) return;
    meshRef.current.rotation.y += delta * 0.18;
    meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3) * 0.12;
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 1.4) * 0.04;
    meshRef.current.scale.setScalar(pulse);
  });

  return (
    <group>
      <mesh ref={meshRef}>
        <icosahedronGeometry args={[0.62, 1]} />
        <meshStandardMaterial
          color={COL.deep}
          emissive={COL.ember}
          emissiveIntensity={1.5}
          roughness={0.35}
          metalness={0.6}
          flatShading
        />
      </mesh>
      {/* Additive halo billboard behind the core. */}
      <mesh position={[0, 0, -0.6]}>
        <planeGeometry args={[4.4, 4.4]} />
        <shaderMaterial
          vertexShader={HALO_VERTEX}
          fragmentShader={HALO_FRAGMENT}
          uniforms={haloUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

/** Camera + group parallax driven by the pointer. */
function ParallaxRig({
  children,
  intensity,
  still,
}: {
  children: React.ReactNode;
  intensity: number;
  still: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!group.current) return;
    const tx = still ? 0 : state.pointer.x * intensity;
    const ty = still ? 0 : state.pointer.y * intensity;
    group.current.rotation.y += (tx * 0.35 - group.current.rotation.y) * 0.05;
    group.current.rotation.x += (-ty * 0.22 - group.current.rotation.x) * 0.05;
  });
  return <group ref={group}>{children}</group>;
}

export function PhoenixScene({ variant, particleCount, still, parallax }: SceneProps) {
  const rise = variant === 'welcome' ? 4.6 : 3.4;
  return (
    <>
      <color attach="background" args={[COL.deep.r, COL.deep.g, COL.deep.b]} />
      <fog attach="fog" args={['#04101f', 5, 13]} />
      <ambientLight intensity={0.35} color={COL.cyan} />
      <pointLight position={[0, 0.4, 2.2]} intensity={22} distance={12} color={COL.ember} />
      <pointLight position={[-2.4, 1.6, 1.5]} intensity={10} distance={10} color={COL.cyan} />
      <pointLight position={[2.2, -1.2, 1.0]} intensity={6} distance={9} color={COL.teal} />
      <ParallaxRig intensity={parallax} still={still}>
        <PhoenixCore still={still} />
        <EmberField count={particleCount} still={still} rise={rise} />
      </ParallaxRig>
    </>
  );
}
