# Phoenix Redesign — Screen Compliance Matrix

**Methodology (honest):** ratings below come from **code review** of each screen's
JSX (visual hierarchy, layout, component usage, state coverage) plus runtime
verification of the surfaces reachable **without a user session**. The 39
post-auth screens **cannot be pixel-verified** yet — `.env.local` carries the
anon key only, so a dev/test session is required to render them for the
mandated desktop/mobile × light/dark × AR/EN × loading/empty/error/denied
capture. Post-auth rows are therefore rated **code-complete / visual-pending**,
never falsely marked PASS.

Ratings: **PASS** · **NEEDS POLISH** · **NEEDS REDESIGN** · **BLOCKED** ·
**VISUAL-PENDING** (code meets bar; needs a session to confirm pixels).

## Anon surfaces (runtime-verifiable now)

| Screen | Rating | Notes |
|--------|--------|-------|
| Login | BLOCKED (hero) | Structure/RTL/brand/states render correctly (verified via read_page). Cinematic realistic-phoenix background needs `design/phoenix-source/phoenix-login-master-4k.png` (not on disk). |
| Public QR | VISUAL-PENDING | Anon-reachable; capture with Playwright next. |
| Reset password | VISUAL-PENDING | Recovery-link gated; harness/route needed to reach. |

## Hero cinematic (image-blocked)

| Screen | Rating | Notes |
|--------|--------|-------|
| Phoenix welcome | NEEDS REDESIGN + BLOCKED | Currently flat `PhoenixMark` SVG (PR#34 defect). Target = realistic phoenix (attached) via image + WebGL rebirth. Needs `phoenix-welcome-keyframe/clean-plate-master-4k.png` on disk. Sequencing/skip/fallback/reduced-motion scaffolding exists. |

## Dashboard / Digital Twin

| Screen | Rating | Notes |
|--------|--------|-------|
| Digital Twin (`NetworkTopologyStage`) | NEEDS POLISH | **Already real WebGL** on real RLS data (shaders, DPR cap, fallback, 2D node list, cleanup). Directive names Three.js → optional port to @react-three/fiber v8 (installed) + higher visual fidelity (volumetric nodes, GPU ember particles, richer edges). Not a rebuild-from-zero. |

## Primary operational screens (VISUAL-PENDING — need dev session)

State coverage measured from source (empty / error / loading / denied handlers present):

| # | Screen | loc | States (e/r/l/d) | Rating |
|---|--------|-----|------------------|--------|
| 11 | InstitutionScreen | 2136 | 5/6/20/27 | VISUAL-PENDING — rich states; confirm hierarchy/mobile |
| 12 | StatusCenterScreen (landing) | 1158 | 0/2/2/10 | VISUAL-PENDING — **empty-state coverage looks thin**, verify |
| 9 | ReportsScreen + global search | 209 | 5/5/5/2 | VISUAL-PENDING |
| 13 | InterInstitutionAlertsScreen | 905 | 4/5/6/13 | VISUAL-PENDING |
| 14 | UserManagementScreen | 1244 | 4/2/5/63 | VISUAL-PENDING — heavy permission gating |
| 17 | NetworkManagementScreen | 492 | 6/4/4/6 | VISUAL-PENDING (hosts the twin) |
| 3 | EditorScreen (availability) | 689 | 3/0/0/7 | VISUAL-PENDING — **no explicit error/loading handlers**, verify |
| 15 | MyAccountScreen | 326 | 0/0/0/0 | VISUAL-PENDING — **no state handlers**, verify if needed |

## Routed-but-hidden + sub-surfaces

Dialogs/panels (`AdjustQuantityModal`, `MovementHistoryModal`, `DirectSupplyOperations`,
`InventoryIntelligencePanel`, `GlobalMaterialSearchPanel`, `AuditLogSection`,
`AvailabilityCleanupWizard`, etc.) and hidden routes (Registry, Mesh, QR center,
Health, Intake-frozen, Mobile command, Status editor): **VISUAL-PENDING** — all
consume the design system per code; require a session to rate.

## Immediate concrete actions (unblocked)

1. Playwright harness → capture Login + Public QR (anon) with reduced-motion +
   QA-only freeze CSS + network idle.
2. StatusCenterScreen, EditorScreen, MyAccountScreen: audit + add any missing
   empty/error/loading states (code-level, no session needed to *write*).
3. Digital Twin: port to @react-three/fiber v8 + raise visual fidelity.

## Blocked on user

- **Dev/test session** → unblocks visual rating + Visual QA capture for all
  post-auth screens (the bulk of the matrix).
- **Master hero images** in `design/phoenix-source/` → Login + Welcome.
- **gh token** → open Draft PR.
