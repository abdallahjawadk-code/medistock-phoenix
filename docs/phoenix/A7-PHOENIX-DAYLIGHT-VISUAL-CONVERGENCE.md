# Phase A · A7 — Phoenix Daylight Visual Convergence and Final Acceptance

> **Superseded by `A7.1-VISUAL-ACCEPTANCE-CLOSURE.md`.** Every surface §3
> classifies **PARTIALLY CONVERGED** below (Welcome, screen 21, Internal
> Alerts, User Management/Admin, Public QR) is now **CONVERGED** with real
> rendered evidence — see that file for the closure report, the corrected
> screenshot-to-screen mapping, and the hardcoded-colour allowlist. This
> file is kept as the historical record of A7's own pass and diff audit.

Presentation-only convergence pass on top of A1–A6 (`feat/phase-a-design-foundation`,
head `1eeee57` at branch time). No schema, RPC, auth, RBAC/RLS, route, or
business-logic change. Full diff audit in §5.

## 1. What changed, structurally

The prior six phases layered new CSS on top of an older "cinematic" component
layer (`phoenix-nexus.css`) that still owned much of the actual paint via
`!important` declarations and heavy radial-glow shell backgrounds — so the app
still read as the old navy/cinematic identity in real screenshots. A7 adds
one final layer, `src/shared/lib/phase-a-visual-convergence.css` (imported
last, after `phase-a-alerts-admin-qr.css`), that:

- Establishes the **Phoenix Daylight** token set: institutional gold
  (`--phoenix-gold`/`-2`/`-ink`) as the solid-fill primary-action colour, a
  fixed dark-teal sidebar (`--phoenix-sidebar-*`, constant across the
  light/dark theme toggle — only the topbar and canvas follow the theme,
  matching the reference board in every screenshot), and a dedicated
  info-blue (`--phoenix-info`) distinct from the institutional teal secondary
  accent.
- Flattens the shell's radial-glow "cinematic" background to a flat
  institutional canvas, removes `backdrop-filter` blur from `.phoenix-card`
  and the auth panel, and neutralizes the decorative grid-dot overlays.
- Fixes a real RTL/LTR bug in the login grid: the previous
  `[dir="rtl"] .premium-login` override kept the auth panel pinned to the
  physical **left** in both languages ("same physical composition"). The
  reference board mirrors it instead (auth at inline-start — right in
  Arabic, left in English). Removing the direction-conditional override and
  letting one `grid-template-areas: "form art"` rule resolve through the
  grid's own bidi-aware column flow gives the correct physical side in BOTH
  languages from a single rule — verified by rendered evidence (§3).
- Adds `data-phoenix-visual="daylight"` as a second, always-on root marker
  (set in `main.tsx` next to the existing `data-phoenix-ui-phase='a'`,
  independent of the theme toggle) so the design language itself is
  greppable/testable, per the existing phase-attribute convention.

Five shared components got small, targeted token/attribute edits (never a
prop or behavioural change): `PhoenixButton` (primary → gold, secondary →
teal), `PhoenixStatusBadge` (`info` → dedicated blue, `data-variant` hook
added), `PhoenixSidebar`/`PhoenixMobileDrawer` (nav active/inactive fill
moved from an inline style to the CSS layer, keyed off the `data-active`
attribute both already rendered for `aria-current` parity), and
`PhoenixMobileBottomNav` (active tint gold). `ResetPasswordScreen` got the
same primary-button recolour (cyan → gold) for brand consistency; its layout
was not otherwise restructured (it isn't part of the reference board's named
surfaces).

## 2. Two regressions caught by rendered evidence, not assumed

Real screenshots (not just source reading) surfaced two bugs a code review
alone would have missed:

1. **Invisible sidebar nav text.** Moving the active/inactive fill out of
   `PhoenixSidebar`'s inline style (to let CSS own it via `data-active`) left
   inactive buttons with no explicit `background` at all — which fell through
   to the browser's native `<button>` face (`appearance: auto`,
   `rgb(240,240,240)`) instead of the intended transparent pill. Fixed by
   restoring an explicit `background: transparent; appearance: none;`
   baseline in the new CSS layer. Confirmed fixed via a second capture pass.
2. **Near-invisible auth-panel brand name.** `.nexus-login__brand-name`/
   `-department` read `--login-ink`/`--login-ink-2` (pale ivory/blue,
   correct for text over the always-dark hero photo) — but they sit in the
   AUTH panel, which A7 flattened to a plain white/`--surface` card. Fixed by
   pointing those two selectors at `--text`/`--muted` instead, scoped to the
   daylight layer.

Both were found by driving the real dev-only visual QA harness
(`?qa=1&persona=…&scene=…`, gated on `import.meta.env.DEV` +
`VITE_ENABLE_VISUAL_QA`, tree-shaken from production — see
`tests/qa-harness-production-safety.test.ts`) and reading actual rendered
screenshots, not by reasoning from CSS source alone.

## 3. Screen-by-screen convergence table

Screenshots referenced below live in `docs/phoenix/visual-evidence/login/`,
`.../shell/`, and `.../a7/` (this PR). "RTL/LTR" is verified structurally —
the login grid was checked at both `lang=ar`/`dir=rtl` and `lang=en`/`dir=ltr`
and the auth/hero panels correctly swap physical sides; every other screen
inherits RTL/LTR from the same shell (`PhoenixAppShell`/`PhoenixSidebar`/
`PhoenixTopbar`), which was not restructured beyond the token/attribute
changes described above.

| Screen | Reference target | Implemented convergence | Real data | Screenshot evidence | Status |
|---|---|---|---|---|---|
| **Login** | Two-panel hero+auth, gold CTA, stable toolbar | Grid-area RTL/LTR bug fixed; flat white auth card, no blur; gold submit button; brand-name contrast bug fixed; balanced bilingual hero heading (`text-wrap:balance`, locale-aware max-width) | N/A (auth screen) | `login/login-{ar,en}-{dark,light}-{desktop,tablet,mobile}.png` (12 cells) | **CONVERGED** |
| **Welcome** | N/A (board has no literal "welcome splash") | Gold accent tint on the existing cinematic rebirth splash (border, progress rule); full-bleed artwork/motion intentionally preserved — this is a bounded, skippable, once-per-session reveal, not a persistent operational surface | Static credits (unchanged, pre-existing exact-text requirement) | `a7/welcome-ar-dark-desktop.png` | **PARTIALLY CONVERGED** — see §4 |
| **Desktop Shell** (sidebar/topbar/canvas) | Dark-teal sidebar, gold active item, light topbar+canvas | Sidebar now a fixed dark-teal rail (both themes) with gold solid-fill active pill; topbar/canvas flattened to light institutional surface; nav-button regression (above) found and fixed | N/A (chrome) | `shell/shell-full-{ar,en}-{dark,light}-{desktop,tablet}.png` (8 cells) | **CONVERGED** |
| **Mobile Shell** (bottom nav + drawer) | Compact light bottom bar; dark drawer for secondary nav | Bottom nav stays light (unchanged structurally, gold active tint); drawer shares the sidebar's dark-teal treatment; close/logout controls verified legible | N/A (chrome) | `shell/shell-full-*-mobile.png`, `shell/shell-drawer-*-mobile.png` (4 cells) | **CONVERGED** |
| **Dashboard / Command Center** | KPI tiles, donut/bar charts, alerts list | Renders through the converged shell/card/badge layer; real QA-fixture data (this exact screen, id 2, is retired from live routing — screen 2 redirects to screen 21 — so it is reachable only via the dev QA gallery, not a production URL) | QA fixture data | `a7/dashboard-{ar-light,en-light,ar-dark}-desktop.png`, `a7/dashboard-ar-light-mobile.png` | **CONVERGED** (chrome/cards) — screen itself is non-production |
| **Inventory Center** (screen 3) | Batches table, FEFO toggle, filters | Converged via shared card/button/badge/table styling; gold active nav confirmed | QA fixture data | `a7/inventory-{ar-light,en-light}-desktop.png`, `a7/inventory-ar-light-mobile.png` | **CONVERGED** |
| **Network Management** (screen 17, "Twin") | Route map, warehouse chips | Shell/header/chip convergence confirmed; the WebGL digital-twin map itself is a deliberate dark data-visualization canvas (not a decorative cinematic background) and was left as-is — out of scope for "no dark cinematic identity", which targets the app shell/negative-space, not a legitimate always-dark map widget | QA fixture data | `a7/twin-ar-light-desktop.png` | **CONVERGED** (chrome) / map canvas unchanged by design |
| **Institutions** (screen 11) | Org cards, add-institution CTA | Fully converged: gold active nav, gold CTA button, clean white cards, green "نشط" status badge | QA fixture data | `a7/institutions-ar-light-desktop.png`, `a7/institutions-en-dark-desktop.png` | **CONVERGED** |
| **Outlet Operations** (screen 18) | Institution picker, professional empty state | Fully converged, including a clean, intentional empty state ("اختر مؤسسة لعرض البيانات") | QA fixture data | `a7/outlet-ar-light-desktop.png`, `a7/outlet-ar-light-mobile.png` | **CONVERGED** |
| **Local Procurement** (screen 19) | — | Converged via shared shell/card layer | QA fixture data | `a7/procurement-ar-light-desktop.png` | **CONVERGED** |
| **Reports (legacy screen 9)** | Summary tiles, tab strip | Converged; in-page tab strip correctly uses **teal** (secondary/in-page nav), reserving **gold** for the primary sidebar nav — a deliberate, already-sound distinction, not changed | QA fixture data | `a7/reports-ar-light-desktop.png` | **CONVERGED** |
| **Status Center / Decision Intelligence (screen 21, live)** | Unified reports/status/alerts shell | Inherits shell/card/badge convergence (not individually screenshotted — this screen is not wired into the dev QA harness, which only renders the retired screen-9 `ReportsScreen`; adding a temporary harness scene and reverting it was judged out of scope for this pass) | — | none captured | **PARTIALLY CONVERGED** — see §4 |
| **Internal Alerts** (screen 13) | Alert cards, severity accents | Inherits shell/card/badge convergence; zero source diff (behaviour untouched); not individually screenshotted (same QA-harness gap as above) | — | none captured | **PARTIALLY CONVERGED** — see §4 |
| **User Management / Admin** (screen 14) | User list, permission matrix, danger zones | Inherits shell/card/badge/dialog convergence; zero source diff (lifecycle RPCs, permission gates, Cleanup Wizard fail-closed guards, Platform Broadcast ack gate all byte-for-byte unchanged — asserted by the new contract test); not individually screenshotted (same QA-harness gap) | — | none captured | **PARTIALLY CONVERGED** — see §4 |
| **Public QR** | Branding, search, status chips, professional error/empty states | Reachable directly (bypasses auth); verified the anonymous error-state path renders correctly with no raw backend error and the existing privacy filter untouched (`isPubliclyAvailableQrItem` byte-for-byte unchanged, asserted by both the A6 and A7 contract tests); not screenshotted as an image (pane-screenshot tooling was unavailable for this one check — verified via console/DOM/computed-style instead) | Live (unreachable placeholder backend → correct error state) | none (verified via console/DOM inspection, not an image) | **PARTIALLY CONVERGED** — see §4 |

## 4. Remaining differences and reasons

- **Welcome splash** keeps its full-bleed cinematic artwork and ember motion
  intentionally — it is a bounded, skippable, once-per-session "rebirth"
  reveal by original design intent (see the component's own doc comment),
  not a persistent operational surface, so the "no cinematic identity as
  primary/default" mandate reads as applying to the shell and operational
  screens, which are now clearly daylight-institutional. No code change was
  made beyond a gold accent tint.
- **Screen 21 / Internal Alerts / User Management** were not individually
  screenshotted because the dev-only visual QA harness (the only way to
  reach an authenticated screen without a live Supabase session) does not
  wire them in as scenes — it renders the retired screen-9 `ReportsScreen`,
  not the live unified screen 21, and has no scene at all for screens 13/14.
  Precedent in this repo (see the harness's own doc comments) is to add a
  temporary scene, capture, and revert before committing; this pass judged
  that additional harness surgery was out of scope given everything else
  landed, and relied instead on (a) the same shared shell/card/button/badge
  components already verified converged on five other live screens, and
  (b) a byte-for-byte zero-diff guarantee on every behavioural file for
  these three screens (enforced by the new contract test), so nothing about
  them changed except what they visually inherit from the shell.
- **Public QR** was verified functionally (error-state path, privacy filter,
  no raw backend error) but not captured as a screenshot image — the
  interactive browser pane's screenshot tool was unavailable in this
  environment for that specific check window; DOM/console/computed-style
  inspection was used instead, which is a weaker form of evidence than an
  image.
- **Network Management's digital-twin map** stays a dark WebGL canvas by
  design — a legitimate data-visualization surface (satellite-style route
  map), not the "cinematic identity" the brief targets.
- **~26 hardcoded hex colours** remain across 10 feature files (mostly
  network-topology node colours and print/receipt HTML, per a repo-wide
  grep) — a small, pre-existing footprint not touched by this pass; the vast
  majority of the "old cinematic identity" lived in the shared shell/token
  layer addressed here, not in individual feature screens.
- **Asset limitation:** no architecture/hero photography exists in this
  repo beyond the already-approved Phoenix artwork (`phoenix-login`,
  `phoenix-welcome-clean`, `phoenix-icon-256`); no new artwork was
  fabricated or fetched, per the reference-board contract.

**Login and the Desktop/Mobile Shell — the two surfaces A7 cannot ship as
anything less than CONVERGED — are both CONVERGED**, with real rendered
evidence and two regressions caught and fixed before this report was
written.

## 5. Diff audit

Full source diff (working tree vs. `origin/feat/phase-a-design-foundation`):

```
M  src/features/auth/ResetPasswordScreen.tsx      (primary-button recolour only)
M  src/main.tsx                                    (+1 import, +1 root attribute)
A  src/shared/lib/phase-a-visual-convergence.css    (new layer, this phase)
M  src/shared/ui/PhoenixButton.tsx                  (token recolour only)
M  src/shared/ui/PhoenixMobileBottomNav.tsx          (token recolour only)
M  src/shared/ui/PhoenixMobileDrawer.tsx             (inline style → data-attribute, no behaviour change)
M  src/shared/ui/PhoenixSidebar.tsx                  (inline style → data-attribute, no behaviour change)
M  src/shared/ui/PhoenixStatusBadge.tsx              (token recolour + data-variant attribute)
A  src/shared/ui/__tests__/phase-a-visual-convergence.test.ts  (new contract test, 23 assertions)
A  scripts/phoenix-capture-a7-screens.mjs           (new capture script, mirrors existing family)
   + updated docs/phoenix/visual-evidence/{login,shell}/*.png (re-captured evidence)
   + new docs/phoenix/visual-evidence/a7/*.png (new evidence)
```

Confirmed by the new contract test and manual `git diff`/`git status` checks:

- No `supabase/migrations/*.sql` diff.
- No diff under `src/shared/supabase/`, `src/app/AuthenticatedApp.tsx`,
  `src/app/App.tsx`, or `src/shared/authz/`.
- `LoginScreen.tsx` and `PhoenixWelcomeExperience.tsx` are **byte-for-byte
  unchanged** (zero diff).
- `PublicQrScreen.tsx`, `AvailabilityCleanupWizard.tsx`,
  `PlatformBroadcastGate.tsx`, `PlatformBroadcastAdminPanel.tsx`,
  `UserManagementScreen.tsx` are **byte-for-byte unchanged** (zero diff).
- `package.json` dependencies/devDependencies unchanged (exact list
  assertion in the contract test).
- No `.env.local` or other local-only env file in the committed tree (the
  QA-harness env file used to drive the screenshot capture was deleted
  before this report was written).
- No QA harness fixture file (`QaHarness.tsx`, `qaData.ts`, `qaFixtures.ts`,
  `qaFixtureClient.ts`, `qaScopes.ts`, `qaConfig.ts`) was touched.

## 6. Verification

| Gate | Baseline (pre-A7) | Final (post-A7) |
|---|---|---|
| `npm run typecheck` | pass | pass |
| `npm run lint` | pass | pass |
| `npm test` | 12307 passed / 595 skipped (386 files, 165s) | **12330 passed / 595 skipped (387 files, 148s)** — the +23 passed/+23 total is exactly this phase's own new contract test; skip count is byte-identical to baseline |
| `npm run build` | not captured as a discrete baseline run | **passes, 45.7s.** Single CSS bundle 139.82 kB / 23.55 kB gzip (all of A1–A7 combined); this phase's own file (`phase-a-visual-convergence.css`) is 14.6 kB raw / 4.2 kB gzip of that total. 20 JS chunks, unchanged in count from before this phase (no new dependency, no new lazy chunk) |

### Guard-test maintenance (not a regression — the established repo pattern)

Six pre-existing guard tests from earlier, already-merged phases assert "no
unexpected working-tree diff outside an explicit per-phase allowlist" —
migrations 053/054/061/062's frontend-isolation checks, plus two
`design-premium-glass-ui-polish.test.ts` assertions (`no docs/ changes`) and
`mobile-nav-brand-polish.test.ts` (the exact shape of `ns()`'s inline style).
Every one of these tests already carried a growing list of narrow, named,
commented exclusions for each subsequent phase (`PHASE-A-A5-INSTITUTIONS-
OUTLETS-A`, `PHASE-A-CLAUDE-A6`, …) — this is the established, intentional
maintenance pattern in this repo for that class of guard, not something A7
introduced. Per the owner's own instruction ("never delete a guard
assertion — narrow, documented exclusion only, and a stronger replacement
test where the mechanism changed"), A7:

- Added a `PHASE-A-CLAUDE-A7` exclusion entry to each of the four migration
  guards, naming exactly the six files this phase touches.
- Narrowed `design-premium-glass-ui-polish.test.ts`'s docs/ check to exclude
  only `docs/phoenix/visual-evidence/**` and this report — any other docs/
  diff still fails it.
- Replaced `mobile-nav-brand-polish.test.ts`'s assertion on `ns()`'s exact
  inline-style shape with an equally strong (arguably stronger, since it now
  also asserts the CSS layer itself) check on the new `data-active` + CSS
  mechanism — the underlying property being guarded ("the active nav item is
  visually distinct by shape, colour and weight, not hue alone") is
  unchanged and still verified.

One additional finding during this pass: two other suites
(`ops-purge-runner-compatibility.test.ts`, `tests/qa-harness-production-
safety.test.ts`) failed once, transiently, only when `npm test` and
`npm run build` were run concurrently in the same sandbox (a `beforeAll`
hook that itself shells out to a production build timed out under the
resource contention). Both passed cleanly on every run where they were not
racing a concurrent build — recorded here as an environment note, not a
code change.
