# Phoenix Visual Replacement — Screen Map & Token Migration (Phase A)

**Design source:** `design-source/MediStock-Phoenix.dc.html` (imported from the
Claude Design project `مشروع ريبورث الفينيكس`, file `MediStock Phoenix.dc.html`).
**Rollback point:** git tag `pre-nexus-visual-replacement` → `227c84b`.
**Superseded source (kept for rollback only):** `design-source/MediStock-Babil.dc.html`.

The design reference is a 1440×900 self-contained mock covering 16 reference
screens. This repo has more production surfaces than the reference does. Per the
migration contract, **no production screen is deleted or merged** because the
reference omits it — every surface gets mapped to the new visual system.

---

## 1. Why a token-first migration is the right lever here

Nearly all screen styling in `src/` is inline `style={{ … }}` reading CSS custom
properties (`var(--p)`, `var(--s)`, `var(--t2)`, `var(--brd)`, …) rather than
hard-coded hex. Two files define those properties:

| File | Lines | Role |
| --- | --- | --- |
| `src/shared/lib/tokens.css` | 129 | Palette, scales, motion, z-index |
| `src/shared/lib/phoenix-nexus.css` | 2086 | Component/class layer |
| `src/shared/lib/global.css` | — | Imports both |

Because the semantic names are already centralised, redefining their **values**
propagates the new art direction to all 261 `.ts/.tsx` files at once — including
screens absent from the reference. That is what makes a *total* replacement
feasible without rewriting business logic. Screens then get individually
reviewed in Phase E for layout/structure fidelity, not just colour.

---

## 2. Art-direction delta

| Aspect | Old (`MediStock-Babil.dc.html`) | New (`MediStock-Phoenix.dc.html`) |
| --- | --- | --- |
| Default theme | Light | **Dark** |
| Dark background | `#040C17` | `#07111F` |
| Light background | `#F3F7FB` | `#F0F4F9` |
| Primary accent | Teal `#0D9488` | **Cyan `#62E9FF`** (light `#0E7EA6`) |
| Secondary accent | Blue `#3B82F6` | **Ember `#FF7A1A`** / **Gold `#DDBA63`** |
| Borders | Solid `#D6E0EC` / `#1D3854` | Translucent cyan `rgba(98,233,255,.14)` |
| Latin type | DM Sans Variable | **Inter** |
| Arabic type | Noto Sans Arabic Variable | **IBM Plex Sans Arabic** |
| Surface treatment | Glass + soft shadow | Layered `surface`/`surface2`/`field` + hero gradient |

### 2.1 Canonical new palette (verbatim from the design source)

Dark (`[data-theme="dark"]`):

```
--bg:#07111F      --surface:#0A1729   --surface2:#0E2036  --field:#081426
--line:rgba(98,233,255,.14)           --line2:rgba(221,186,99,.3)
--text:#F5F8FC    --muted:#8FA6BF
--cyan:#62E9FF    --cyanDim:#4FC3DF   --ember:#FF7A1A     --ember2:#FF9A4D
--gold:#DDBA63    --teal:#37B5AD
--ok:#2FBF8F      --warn:#FFB84D      --danger:#FF6B6B
--chip:rgba(98,233,255,.08)  --chipW:rgba(255,184,77,.12)  --chipD:rgba(255,107,107,.12)
--hover:rgba(98,233,255,.06) --shadow:0 14px 34px rgba(0,0,0,.4)
--heroGrad:linear-gradient(140deg,#0C1C33 0%,#081426 55%,#0A1020 100%)
```

Light (`[data-theme="light"]`):

```
--bg:#F0F4F9      --surface:#FFFFFF   --surface2:#F5F8FC  --field:#F7FAFD
--line:#D8E2EC    --line2:#E0D3B4     --text:#122335      --muted:#546B82
--cyan:#0E7EA6    --cyanDim:#0E7EA6   --ember:#C75B10     --ember2:#B25B0E
--gold:#8F7228    --teal:#0E8078
--ok:#0E8F5B      --warn:#A66E0A      --danger:#C43D3D
--chip:rgba(14,128,120,.08)  --chipW:rgba(166,110,10,.1)   --chipD:rgba(196,61,61,.1)
--hover:rgba(14,128,120,.06) --shadow:0 10px 26px rgba(18,35,53,.1)
--heroGrad:linear-gradient(140deg,#FFFFFF 0%,#F2F7FB 60%,#E9F1F8 100%)
```

### 2.2 Legacy → new token bridge

The legacy short names stay defined (so no screen breaks mid-migration) but are
re-pointed at the new palette. They are removed in Phase G once every consumer
has been converted to the canonical names.

| Legacy | New source | Notes |
| --- | --- | --- |
| `--bg` | `--bg` | value changes only |
| `--s` | `--surface` | |
| `--s2` | `--surface2` | |
| `--sh` | `--field` | legacy `--sh` was a surface, not a shadow |
| `--t` | `--text` | |
| `--t2` | `--muted` | |
| `--t3` | `--muted` @ reduced alpha | |
| `--p` | `--cyan` | primary accent flips teal → cyan |
| `--pd` | `--cyanDim` | |
| `--p2` | `--chip` | |
| `--sec` | `--ember` | |
| `--sec2` | `--chipW` | |
| `--ok` / `--ok2` | `--ok` / `--chip` | |
| `--warn` / `--warn2` | `--warn` / `--chipW` | |
| `--err` / `--err2` | `--danger` / `--chipD` | |
| `--info` / `--info2` | `--teal` / `--chip` | |
| `--brd` | `--line` | |
| `--skel` | `--surface2` | |
| `--focus-ring` | `--cyan` | |

Scales that are art-direction-neutral (`--sp-*`, `--r*`, `--z-*`, `--dur-*`,
`--ease-*`, `--touch-target`, `--sw`, `--tbh`, `--bnh`) are retained unchanged.

---

## 3. Reference screens in the design source

Derived from the design's `sc-if` render guards and `state.nav` / `state.phase`.

**Phases:** `login`, `welcome`, `app`
**Nav (14):** `dashboard`, `twin`, `inventory`, `movements`, `transfers`,
`returns`, `alerts`, `entry`, `institutions`, `users`, `reports`, `search`,
`audit`, `settings`

**State variants each screen must render:** populated, loading, empty, error,
denied, offline, stale.
**Effect modes:** `auto`, `cinematic`, `reduced`, `off` (plus `prefers-reduced-motion`).
**Locales:** `ar` (RTL, default) / `en` (LTR). **Themes:** dark (default) / light.

---

## 4. Production surface inventory → design mapping

Routing is a numeric `screen` switch in `src/app/AuthenticatedApp.tsx:82`, with
`src/app/App.tsx` handling the anonymous public-QR route. **Screen numbers,
routes, deep links and permission gates are authoritative and unchanged.**

### 4.1 Pre-auth / anonymous

| Surface | File | Design reference |
| --- | --- | --- |
| Login | `src/features/auth/LoginScreen.tsx` | `phase: 'login'` |
| Cinematic welcome | `src/features/auth/PhoenixWelcomeExperience.tsx` | `phase: 'welcome'` |
| Password reset | `src/features/auth/ResetPasswordScreen.tsx` | *(none)* → login art direction |
| Public QR (anon) | `src/features/qr/PublicQrScreen.tsx` | *(none)* → standalone card on `--heroGrad` |

### 4.2 Authenticated screens

| # | Surface | File | Design reference |
| --- | --- | --- | --- |
| 3 | Availability Editor | `src/features/editor/EditorScreen.tsx` | `entry` (manual entry form) |
| 4 | Registry *(nav-hidden, route live)* | `src/features/registry/RegistryScreen.tsx` | `inventory` |
| 5 | Mesh | `src/features/mesh/MeshScreen.tsx` | **`twin`** (Digital Twin) |
| 6 | QR *(nav-hidden, route live)* | `src/features/qr/QrScreen.tsx` | `audit` → QR tab |
| 7 | Health | `src/features/health/HealthScreen.tsx` | `settings` (diagnostics panel) |
| 8 | Intake (frozen) *(nav-hidden, route live)* | `src/features/health/IntakeFrozenScreen.tsx` | `entry` + denied/frozen state |
| 9 | Reports | `src/features/reports/ReportsScreen.tsx` | `reports` + `search` |
| 10 | Mobile Command | `src/features/mesh/MobileCommandScreen.tsx` | mobile `dashboard` |
| 11 | Institutions | `src/features/institutions/InstitutionScreen.tsx` | `institutions` |
| 12 | Status Center *(landing)* | `src/features/status/StatusCenterScreen.tsx` | `dashboard` + `inventory` + `movements` |
| 13 | Inter-institution Alerts | `src/features/alerts/InterInstitutionAlertsScreen.tsx` | `alerts` |
| 14 | User Management | `src/features/users/UserManagementScreen.tsx` | `users` |
| 15 | My Account | `src/features/account/MyAccountScreen.tsx` | `settings` |
| 16 | Status Editor *(nav-hidden, route live)* | `src/features/status/StatusEditorScreen.tsx` | `inventory` (edit mode) |
| 17 | Network Management | `src/features/network/NetworkManagementScreen.tsx` | `institutions` + `transfers` |

Screens 4, 6, 8, 16 are hidden from the sidebar but their routes remain wired
(`src/shared/ui/PhoenixSidebar.tsx:19`). They are migrated like any other screen.

### 4.3 Sub-surfaces with no direct reference screen

Styled from the primitive layer + nearest reference analogue:

| Surface | File | Nearest reference |
| --- | --- | --- |
| Direct supply operations | `src/features/network/DirectSupplyOperations.tsx` | `transfers` wizard |
| Network topology stage | `src/features/network/NetworkTopologyStage.tsx` | `twin` |
| Availability cleanup wizard | `src/features/admin/AvailabilityCleanupWizard.tsx` | `transfers` wizard |
| Availability item details | `src/features/institutions/AvailabilityItemDetailsModal.tsx` | `inventory` detail drawer |
| Inventory intelligence panel/summary | `src/features/inventory/InventoryIntelligence*.tsx` | `dashboard` alert intel |
| Inventory reason / threshold dialogs | `src/features/inventory/Inventory*Modal.tsx`, `InventoryReasonDialog.tsx` | confirm dialog |
| Adjust quantity | `src/features/status/AdjustQuantityModal.tsx` | `inventory` adjust action |
| Movement history / report | `src/features/status/Movement*.tsx` | `movements` |
| Outlet availability report | `src/features/status/OutletAvailabilityReportModal.tsx` | `reports` |
| Outlet material groups | `src/features/status/OutletMaterialGroups.tsx` | `inventory` |
| Reactivate material | `src/features/status/ReactivateMaterialModal.tsx` | confirm dialog |
| Internal alerts section | `src/features/status/InternalAlertsSection.tsx` | `alerts` |
| Audit log section | `src/features/reports/AuditLogSection.tsx` | `audit` |
| Global material search | `src/features/reports/GlobalMaterialSearchPanel.tsx` | `search` |
| Platform broadcast admin | `src/features/platform-broadcast/PlatformBroadcastAdminPanel.tsx` | `settings` |
| Mobile print fallback | `src/shared/ui/MobilePrintFallbackModal.tsx` | dialog |

### 4.4 Shared primitives (Phase B/C targets)

`PhoenixAppShell`, `PhoenixSidebar`, `PhoenixTopbar`, `PhoenixMobileBottomNav`,
`PhoenixMobileDrawer`, `PhoenixCard`, `PhoenixButton`, `PhoenixInput`,
`PhoenixSelect`, `PhoenixDialog`, `PhoenixToast`, `PhoenixStatusBadge`,
`PhoenixMetricCard`, `PhoenixEmptyState`, `PhoenixErrorState`,
`PhoenixLoadingState`, `PhoenixIcon`, `PhoenixMark`, `PhoenixOrgScope`,
`CommandPalette`, `CommandCenterActivityFeed`, `QuickActionGrid`,
`SmartFilterChips`, `ExpiryRiskBadge`, `MaterialTimeline`,
`WhatsAppContactButton`.

---

## 5. Approved assets

From `design/phoenix-source/` (also present in the design project's uploads):

- `phoenix-app-icon-master.png`
- `phoenix-login-master.png`
- `phoenix-welcome-keyframe-master.png`
- `phoenix-welcome-clean-plate-master.png`
- `phoenix-dashboard-reference-master.png`
- `phoenix-babil-map-master.png`

Runtime derivatives are generated into `public/assets/phoenix/runtime/` by
`npm run assets:phoenix`. No text is baked into runtime backgrounds; all copy is
live DOM so AR/EN and light/dark stay switchable.

---

## 6. Phase order & exit gates

| Phase | Scope | Exit gate |
| --- | --- | --- |
| A | Audit + screen map + safety tag | this document; tag exists |
| B | Tokens, typography, shared primitives, SVG icon family | typecheck + tests green |
| C | Shell, sidebar, topbar, mobile nav | every route still renders; nav contracts unchanged |
| D | Login, welcome, dashboard/landing | cinematic gates hold (lazy, 2D fallback, dispose) |
| E | Every screen family | all 15 authenticated + 4 anon surfaces reviewed |
| F | Responsive / a11y / performance QA | AR·EN × light·dark × desktop·mobile verified; lint, typecheck, tests, build pass |
| G | Remove obsolete visual code | no old-design values in the bundle; history retained for rollback |

Constraints held throughout: no business-logic, routing, Supabase, RPC, RLS/RBAC,
migration or schema changes; no mock data, `service_role`, `auth.admin`, or
direct stock-table writes; PR stays Draft; small independent commits, no amend,
rebase, force-push, DB apply or production deploy.
