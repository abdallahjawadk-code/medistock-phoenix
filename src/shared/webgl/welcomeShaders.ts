/* ─── PHOENIX WEBGL — rebirth (welcome) GLSL ───────────────────────────────────
   Timeline-driven morph shader for the ~5.2s rebirth: particles start as a
   dispersed ash cloud (aScatter), burst outward, then re-form into the phoenix
   target (position) while igniting and rising. All driven by a single uProgress
   uniform so the choreography is deterministic and disposable. No textures.
   ─────────────────────────────────────────────────────────────────────────── */

export const REBIRTH_VERTEX = /* glsl */ `
  uniform float uProgress;
  uniform float uPixelRatio;
  uniform float uSize;

  attribute vec3  aScatter;
  attribute float aSeed;
  attribute float aScale;

  varying float vGlow;
  varying float vSeed;

  void main() {
    // Per-particle staggered re-formation so the bird assembles organically.
    float stagger = aSeed * 0.22;
    float reform  = smoothstep(0.34 + stagger, 0.82, uProgress);

    // Mid-sequence outward burst (peaks around p≈0.25) applied to the ash cloud.
    float burst = sin(clamp(uProgress, 0.0, 0.5) * 6.28318);
    vec3 ash = aScatter * (1.0 + burst * 0.55);

    float t = uProgress * 6.28318;
    float scatterAmt = 1.0 - reform;
    ash.x += sin(t + aSeed * 10.0) * 0.22 * scatterAmt;
    ash.y += cos(t * 0.8 + aSeed * 7.0) * 0.22 * scatterAmt;
    ash.z += sin(t * 0.6 + aSeed * 5.0) * 0.18 * scatterAmt;

    vec3 formed = position;
    vec3 p = mix(ash, formed, reform);

    // The formed bird lifts and settles in the final third.
    p.y += smoothstep(0.6, 1.0, uProgress) * 0.6;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    vGlow = reform;
    vSeed = aSeed;
    float born = smoothstep(0.04, 0.2, uProgress);
    gl_PointSize = uSize * aScale * uPixelRatio * (0.45 + reform * 0.9) * born *
                   (300.0 / max(-mv.z, 0.1));
  }
`;

export const REBIRTH_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorSpark;
  uniform float uProgress;

  varying float vGlow;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float glow = smoothstep(0.5, 0.0, d);
    float core = smoothstep(0.2, 0.0, d);

    vec3 col = mix(uColorEdge, uColorCore, core);
    // Cyan ion sparks intensify as the phoenix stabilises.
    float spark = step(0.9, fract(vSeed * 97.31)) * core * smoothstep(0.6, 1.0, uProgress);
    col = mix(col, uColorSpark, spark);

    float alpha = glow * (0.45 + vGlow * 0.55);
    gl_FragColor = vec4(col * (0.6 + core + vGlow * 0.4), alpha);
  }
`;
