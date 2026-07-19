# PHOENIX — Performance & Resilience Report

Measured evidence for the WebGL work on `feat/phoenix-total-cinematic-redesign`.
Numbers are from the production build (`npm run build`) and in-browser inspection
of the dev server; nothing here is estimated.

## Code-splitting / bundle (measured)

| Chunk | Size | gzip | Loaded when |
|-------|------|------|-------------|
| `react-three-fiber.esm-*.js` (three + fiber) | 820 KB | 221 KB | **only** on dynamic import of a Phoenix canvas |
| `PhoenixCanvas-*.js` (login scene) | 6.97 KB | 2.9 KB | lazy, on login when WebGL committed |
| `PhoenixWelcomeCanvas-*.js` (rebirth scene) | 5.89 KB | 2.6 KB | lazy, on welcome when WebGL committed |
| `index-*.js` (eager entry) | 165 KB | 45 KB | first paint |
| `AuthenticatedApp-*.js` | 492 KB | 114 KB | after auth |

**Verified lazy isolation:** the three chunk has **no static importer** in the
eager graph — `AuthenticatedApp` references it only as a `__vitePreload`
dependency string of the dynamically-imported canvas. So the 2D-fallback /
Save-Data / no-WebGL path never fetches three.js. Enforced by a source-scan test
(`premium-visual-system.test.ts`) that forbids `three`/`@react-three/fiber`
imports outside `src/shared/webgl/**`.

## Runtime resilience (verified in-browser, dev server)

- **WebGL 2.0 context** created on login (`getContext('webgl2')` → `WebGL 2.0
  (OpenGL ES 3.0 Chromium)`); canvas fills its container (1226×810 CSS · DPR 1.25
  → 1533×1012 buffer).
- **2D fallback coexists**: `.nexus-login__atmosphere` present beneath the canvas;
  form fully usable (RTL, all fields), **no console errors**.
- **DPR capped** at `[1, 2]` desktop / `[1, 1.5]` mobile (device-tiered).
- **Particle budget tiered**: 2600 desktop / 1400 low-power / 850 mobile.
- **Frameloop pauses** on `document.hidden` and when the canvas scrolls offscreen
  (IntersectionObserver) — confirmed: with the pane unfocused, rAF throttled to
  ~1 frame while `visibilityState` stayed `visible`, so the pause path is exactly
  the browser's own occlusion behaviour.
- **Context-loss** routes to the 2D fallback (`onContextLost` → `setFailed`),
  never a blank canvas.
- **prefers-reduced-motion** → single static composed frame (login) / short
  static welcome; **prefers-reduced-data / no-WebGL** → 2D fallback, three.js
  never fetched (unit-tested).
- **Disposal**: R3F disposes scene GPU resources on unmount; the raw-WebGL twin
  deletes its buffers/program and cancels its rAF on cleanup.
- **No Supabase impact**: the scenes are procedural/decorative and issue no
  queries; the twin reads existing RLS-scoped data already fetched by the screen
  (no new polling).

## Acceptance gates

| Gate | Status |
|------|--------|
| Three.js in a lazy chunk, not eager | ✅ verified (build + source test) |
| No three on screens that don't need it | ✅ isolated to `shared/webgl` |
| No raw master PNG in production bundle | ✅ scenes are procedural; no image shipped |
| DPR limited | ✅ `[1, ≤2]` |
| Pause on `document.hidden` / offscreen | ✅ |
| Functional fallback on WebGL failure | ✅ |
| `git diff --check` clean | ✅ |
| typecheck / build | ✅ exit 0 |
| lint (0 new warnings) | ✅ 0 new (3 pre-existing baseline) |

## Pending (honest — not yet measured)
- Sustained FPS capture (60 desktop / 30 mid-mobile) requires a foreground,
  composited tab; the preview pane throttles rAF when unfocused, so a real FPS
  number is not yet captured here. Structural/resilience proof is above.
- Memory-leak soak over repeated mount/unmount cycles — disposal is wired; a
  quantified heap-delta run is pending.
- 320 px horizontal-overflow sweep across all operational screens — pending the
  full-screen redesign phase.
