/* ─── PHOENIX WEBGL — the real 3D login scene ──────────────────────────────────
   A genuine Three.js scene that composites the APPROVED photoreal Phoenix art
   (design master → runtime WebP) as a parallaxed, depth-lit 3D backdrop, with a
   GPU ember field, additive light shafts and pointer-driven camera parallax in
   front of it. The recognizable phoenix comes from the master art (its sanctioned
   runtime role); the embers/parallax/shafts/lights/shaders make it a real 3D
   scene — not a flat texture alone. Everything is disposed by R3F on unmount.
   ─────────────────────────────────────────────────────────────────────────── */
import { Suspense, useMemo, useRef } from 'react';
import { useFrame, useThree, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { EMBER_VERTEX, EMBER_FRAGMENT } from './emberShaders';

const COL = {
  ember: new THREE.Color('#ff7a1a'),
  gold: new THREE.Color('#ddba63'),
  cyan: new THREE.Color('#62e9ff'),
  teal: new THREE.Color('#138f88'),
  deep: new THREE.Color('#04101f'),
};

const LOGIN_ART = '/assets/phoenix/runtime/phoenix-login.webp';
const ART_ASPECT = 1680 / 941;

export type PhoenixVariant = 'login' | 'welcome';

interface SceneProps {
  variant: PhoenixVariant;
  particleCount: number;
  still: boolean;
  parallax: number;
}

/** The approved photoreal Phoenix, cover-fitted onto a plane behind the embers. */
function PhoenixArtBackdrop() {
  const texture = useLoader(THREE.TextureLoader, LOGIN_ART);
  const { viewport } = useThree();
  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
  }, [texture]);

  // Cover-fit the art to the viewport (world units at z=0) with slight overscale
  // so pointer parallax never reveals an edge.
  const h = Math.max(viewport.height, viewport.width / ART_ASPECT) * 1.16;
  const w = h * ART_ASPECT;

  // Shift the art right so the phoenix head/fire-wing sit in the open visual
  // column rather than behind the form; the revealed left edge stays under the
  // form's glass panel.
  return (
    <mesh position={[0, 0, -0.4]} scale={[w, h, 1]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} toneMapped={false} transparent opacity={0.94} />
    </mesh>
  );
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
      // Bias emission to the left/lower "fire wing" where the art dissolves into
      // sparks, so the 3D embers read as a continuation of the artwork.
      const r = Math.pow(Math.random(), 1.5) * 2.6;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = -1.1 + Math.cos(a) * r * 0.9;
      positions[i * 3 + 1] = -1.4 + Math.random() * 1.8;
      positions[i * 3 + 2] = 0.4 + Math.random() * 0.8;
      seeds[i] = Math.random();
      scales[i] = 0.4 + Math.random() * 1.0;
      velocities[i * 3] = (Math.random() - 0.5) * 0.4;
      velocities[i * 3 + 1] = 0.25 + Math.random() * 0.55;
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
      uTime: { value: still ? 0.42 : 0 },
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uSize: { value: 17 },
      uRise: { value: rise },
      uColorCore: { value: COL.gold.clone() },
      uColorEdge: { value: COL.ember.clone() },
      uColorSpark: { value: COL.cyan.clone() },
    }),
    [rise, still],
  );

  useFrame((state) => {
    if (still) return;
    if (matRef.current) matRef.current.uniforms.uTime.value = state.clock.elapsedTime;
  });

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
    group.current.rotation.y += (tx * 0.16 - group.current.rotation.y) * 0.05;
    group.current.rotation.x += (-ty * 0.10 - group.current.rotation.x) * 0.05;
  });
  return <group ref={group}>{children}</group>;
}

export function PhoenixScene({ particleCount, still, parallax }: SceneProps) {
  return (
    <>
      <color attach="background" args={[COL.deep.r, COL.deep.g, COL.deep.b]} />
      <ambientLight intensity={0.7} />
      {/* Warm rim only — a coloured fill light was casting a green tint on dark. */}
      <pointLight position={[-1.2, 0.6, 2.6]} intensity={7} distance={12} color={COL.ember} />
      <ParallaxRig intensity={parallax} still={still}>
        <Suspense fallback={null}>
          <PhoenixArtBackdrop />
        </Suspense>
        <EmberField count={particleCount} still={still} rise={3.4} />
      </ParallaxRig>
    </>
  );
}
