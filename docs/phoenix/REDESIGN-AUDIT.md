# PHOENIX HEALTH SUPPLY NEXUS — Redesign Audit (Phase 0)

> Ground-truth audit taken **before** any redesign edit on branch
> `feat/phoenix-total-cinematic-redesign`. Every claim here is verified against
> the working tree, `origin/master`, the routing registry, and the source-image
> manifest — nothing is assumed from filenames or memory.

## 1. Repository truth

| Fact | Verified value |
|------|----------------|
| Current branch | `feat/phoenix-total-cinematic-redesign` |
| HEAD | `f9e9b41` |
| `origin/master` | `e1f83f6` |
| Ahead of master by | 6 commits (design tokens, a11y shell, screen inventory, QA harness, WebGL deps + fixture client) |
| Working tree | clean except untracked `premium-preview.html`, `supabase/.temp/` — **preserved, not touched** |
| Stash | `stash@{0}: On master: paused Service-D inter-org exchange service work` — **preserved** |
| GitHub auth | `gh` logged in as `abdallahjawadk-code` (scope `repo`) |
| Baseline `tsc --noEmit` | **PASS (exit 0)** before edits |

### Open design PRs
- **PR #35** (`feat/phoenix-hero-runtime`, DRAFT, mergeable): adds AVIF/WebP runtime
  images for login/welcome + minor `LoginScreen`/`PhoenixWelcomeExperience`/CSS
  edits. **This is a 2D fallback layer only — NOT WebGL, NOT the final cinematic
  design.** Treated as fallback source, not merged standalone.
- **PR #34** (`feat/w2-cinematic-phoenix-welcome`, DRAFT): CSS/SVG welcome. Not real WebGL.

## 2. The binding verdict — confirmed by code, not opinion

**There is currently zero real WebGL / Three.js / R3F rendering in the application.**

- `three@^0.169.0` + `@react-three/fiber@^8.18.0` are installed (React-18 compatible),
  but the **only** references in `src/` are the dependency **contract test**
  (`tests/webgl-deps-contract.test.ts`). No `<Canvas>`, no `useThree`, no
  `three` import in any runtime `.tsx`.
- `src/features/network/NetworkTopologyStage.tsx` (labelled "WebGL twin" in the
  inventory) uses a **raw 2D `HTMLCanvasElement`** (`canvasRef`) — it is a 2D
  canvas, not WebGL.
- Login / Welcome are **CSS + SVG** scenes (auroras, orbits, CSS particles).

Per the mandate, none of the following count as "WebGL complete" and none are
present as real 3D: image-in-div, CSS transforms, animated SVG, 2D canvas,
flat texture on a plane, particles without a scene/camera/geometry.

**Conclusion:** the redesign's central deliverable (real cinematic 3D) is
genuinely missing and must be built. This is the top priority of this branch.

## 3. Source images — verified, not assumed

Canonical path `design/phoenix-source/`. **All six SHA-256 digests match
`asset-manifest.json` exactly.** Actual pixel dimensions are **1672 × 941**
(NOT 4K — filenames carry no `-4k` suffix and none will be described as 4K).

| File | Role | Runtime use |
|------|------|-------------|
| `phoenix-login-master.png` | text-free login plate | derive AVIF/WebP runtime |
| `phoenix-welcome-clean-plate-master.png` | text-free welcome plate | derive WebGL texture + 2D fallback |
| `phoenix-welcome-keyframe-master.png` | baked-text reference **only** | ❌ never a runtime texture |
| `phoenix-dashboard-reference-master.png` | dashboard art reference | ❌ never a data source |
| `phoenix-babil-map-master.png` | symbolic, non-GIS | ❌ never authoritative geography |
| `phoenix-app-icon-master.png` (2048²) | PWA/app icon source | derive platform icon sizes |

## 4. Per-screen audit & decision

Screens are enumerated from the **live routing** (`AuthenticatedApp.tsx` switch,
`PhoenixSidebar` nav registry, `App.tsx` public route) — see
`design/SCREEN-INVENTORY.md`. Decision key: **PASS** (system-compliant, polish
only) / **POLISH** (states/mobile/RTL gaps) / **REDESIGN** (hero/3D rebuild).

### Auth surfaces
| Screen | Current | Target | Key gaps | Decision |
|--------|---------|--------|----------|----------|
| Login | CSS/SVG scene + form | cinematic WebGL Phoenix + 2D fallback | no real 3D; needs runtime textures, form-always-usable proof across AR/EN·RTL/LTR·light/dark·mobile | **REDESIGN** |
| Welcome | CSS orbit + timers | ~5.2s WebGL rebirth, skip, reduced-motion path, full disposal | no real 3D; clean-plate texture unused | **REDESIGN** |
| Reset password | tokenised form | same, verified states | loading/error/expired-link states | **POLISH** |
| Public QR | tokenised | same | empty/error/denied, mobile | **POLISH** |

### Operational screens (all consume `nexus-*`/`phoenix-*`; audited for states)
| # | Screen | Decision | Primary gaps to close |
|---|--------|----------|-----------------------|
| 12 | Status Center (landing) | POLISH | mobile overflow @320, empty/denied clarity |
| 11 | Institutions | POLISH | responsive table→card, detail modal RTL |
| 17 | Network management | POLISH→REDESIGN | `NetworkTopologyStage` is 2D canvas; upgrade to real twin |
| 14 | Users | POLISH | permission matrix mobile, focus mgmt |
| 13 | Inter-institution alerts | POLISH | non-colour severity, empty states |
| 9 | Reports / global search (super_admin) | POLISH | large-table virtualisation, Excel affordance |
| 3 | Availability editor | POLISH | long-Arabic overflow, keyboard nav |
| 15 | My account | POLISH | mobile layout |
| 2/Dashboard | (removed from nav) | REDESIGN | rebuild as live RLS Digital Twin landing |
| 4–8,10,16 | Registry/Mesh/QR/Health/Intake/Mobile cmd/Status editor | POLISH | state coverage, mobile, RTL |

### Cross-cutting (shared UI)
- `PhoenixLoadingState` / `PhoenixEmptyState` / `PhoenixErrorState` / `PhoenixDialog`
  / `PhoenixToast` — PASS as a system; audit each screen's **denied/offline** path.
- Icon system: `PhoenixIcon` catalog present; emoji-as-icon ratchet test exists
  (`tests/…emoji-free`). **Decision: keep ratchet green, extend catalog as needed.**

## 5. Before/after evidence protocol
Screenshots captured under `docs/phoenix/shots/<screen>/{before,after}-<config>.png`;
matrix tracked in `VISUAL-QA-MATRIX.md`. No screen is marked PASS without a shot
or a documented DOM measurement. Performance gates in `PERFORMANCE-REPORT.md`.

## 6. Guardrails honoured (no exceptions this branch)
No migrations, no `db push`/repair, no RLS/RBAC/Auth edits, no `service_role` in
the client, no direct inventory writes, no changes to `001–077`, no OCR/AI/WhatsApp,
no production seed data. Design wraps the working system; it does not reinterpret it.

---
_Status: Phase 0 complete. Proceeding to the design system + real WebGL engine._
