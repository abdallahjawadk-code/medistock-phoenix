/* ─── PHOENIX WEBGL — ember particle GLSL ──────────────────────────────────────
   Vertex + fragment source for the rising-ember point cloud. Uses THREE built-in
   uniforms/attributes (position, projectionMatrix, modelViewMatrix) injected by
   ShaderMaterial, plus our custom per-particle attributes and time/colour
   uniforms. No texture sampling — the glow is procedural, so there is no runtime
   image dependency and nothing to download.
   ─────────────────────────────────────────────────────────────────────────── */

export const EMBER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uRise;

  attribute float aSeed;
  attribute float aScale;
  attribute vec3  aVelocity;

  varying float vLife;
  varying float vSeed;

  void main() {
    // Each ember loops on its own phase so the field never "restarts" visibly.
    float speed = 0.06 + aScale * 0.05;
    float life  = fract(aSeed + uTime * speed);
    vLife = life;
    vSeed = aSeed;

    vec3 pos = position;
    pos.y += life * uRise * (0.7 + aScale * 0.8);

    float phase = life * 6.28318 + aSeed * 12.0;
    pos.x += sin(phase) * (0.16 + aScale * 0.12);
    pos.z += cos(phase * 0.87) * (0.13 + aScale * 0.10);
    pos += aVelocity * life;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Fade in at birth, out near end of life; scale with perspective distance.
    float fade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.68, 1.0, life));
    gl_PointSize = uSize * aScale * uPixelRatio * fade * (260.0 / max(-mv.z, 0.1));
  }
`;

export const EMBER_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uColorCore;
  uniform vec3 uColorEdge;
  uniform vec3 uColorSpark;

  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float glow = smoothstep(0.5, 0.0, d);
    float core = smoothstep(0.20, 0.0, d);

    vec3 col = mix(uColorEdge, uColorCore, core);
    // A minority of embers flash cyan at their hot core (ion sparks).
    float spark = step(0.92, fract(vSeed * 97.31)) * core;
    col = mix(col, uColorSpark, spark);

    float alpha = glow * (1.0 - smoothstep(0.62, 1.0, vLife)) * 0.9;
    gl_FragColor = vec4(col * (0.55 + core * 0.9), alpha);
  }
`;

/** Soft radial halo behind the core — additive gradient, no texture. */
export const HALO_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const HALO_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3  uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = distance(vUv, vec2(0.5));
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, a * a * uIntensity);
  }
`;
