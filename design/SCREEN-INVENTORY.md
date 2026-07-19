# Phoenix Total Redesign — Screen Inventory

Derived directly from the live routing registry — **not invented**:
- Route dispatch: `src/app/AuthenticatedApp.tsx` (`screenContent()` switch, cases 3–17) + auth gate.
- Public anon route: `src/app/App.tsx` (`?qid`/`?token` → `PublicQrScreen`).
- Nav registry + role gating: `src/shared/ui/PhoenixSidebar.tsx` (`NAV_ITEMS`, `SECONDARY_ITEMS`, role predicates).

Legend for **Design state**:
- ✅ consumes the `nexus-*` / `phoenix-*` production system.
- ◐ partially styled — needs a redesign pass (hierarchy / states / mobile).
- ⛔ hero surface blocked on missing master images (`design/phoenix-source/*`).

## Auth surfaces (pre-shell)

| # | Screen | Component | Role gate | Design state |
|---|--------|-----------|-----------|--------------|
| — | Login | `features/auth/LoginScreen.tsx` | anon | ⛔ realistic-phoenix background (master image) — CSS scene present |
| — | Phoenix welcome | `features/auth/PhoenixWelcomeExperience.tsx` | session, once/tab | ⛔ WebGL rebirth + texture (master image) — CSS/SVG placeholder present |
| — | Reset password | `features/auth/ResetPasswordScreen.tsx` | recovery link | ◐ |
| — | Public QR | `features/qr/PublicQrScreen.tsx` | anon (`?qid`) | ◐ |

## App shell + navigation (`src/shared/ui/`)

`PhoenixAppShell` composes: `PhoenixSidebar`, `PhoenixTopbar`, `PhoenixMobileDrawer`, `PhoenixMobileBottomNav`, `CommandPalette`, `PhoenixToast`, `PhoenixOrgScope`. Parity contract: sidebar = drawer = command palette (same items, order, labels, icons, role gates).

## Primary navigation screens (`AuthenticatedApp` switch)

| # | Screen | Component | Nav / role gate |
|---|--------|-----------|-----------------|
| 11 | Institutions | `features/institutions/InstitutionScreen.tsx` | `nav_institutions` |
| 12 | Status Center (landing) | `features/status/StatusCenterScreen.tsx` | `nav_status_center` |
| 9 | Reports + global material search | `features/reports/ReportsScreen.tsx` | `nav_reports` — **super_admin only** |
| 13 | Inter-institution alerts | `features/alerts/InterInstitutionAlertsScreen.tsx` | `nav_inter_alerts` |
| 14 | User management | `features/users/UserManagementScreen.tsx` | `users.view` / super_admin |
| 17 | Network management | `features/network/NetworkManagementScreen.tsx` | `users.edit_scope` / super_admin |
| 3 | Availability editor | `features/editor/EditorScreen.tsx` | `nav_editor` |
| 15 | My account | `features/account/MyAccountScreen.tsx` | secondary |

## Routed-but-nav-hidden screens (routes fully live; entries hidden intentionally)

| # | Screen | Component | Note |
|---|--------|-----------|------|
| 4 | Registry | `features/registry/RegistryScreen.tsx` | `UI-LEGACY-PAGES-NAV-HIDE-A` |
| 5 | Mesh | `features/mesh/MeshScreen.tsx` | — |
| 6 | QR center | `features/qr/QrScreen.tsx` | `nav_qr_audit` hidden |
| 7 | Health | `features/health/HealthScreen.tsx` | — |
| 8 | Intake (frozen) | `features/health/IntakeFrozenScreen.tsx` | route retained |
| 10 | Mobile command | `features/mesh/MobileCommandScreen.tsx` | — |
| 16 | Status editor | `features/status/StatusEditorScreen.tsx` | `nav_status_editor` hidden |

## Sub-surfaces (dialogs / drawers / panels / sections)

- Status: `AdjustQuantityModal`, `MovementHistoryModal`, `MovementReportSection`, `OutletAvailabilityReportModal`, `OutletMaterialGroups`, `ReactivateMaterialModal`, `InternalAlertsSection`.
- Institutions: `AvailabilityItemDetailsModal`.
- Network: `DirectSupplyOperations` (central→institution direct forward + return), `NetworkTopologyStage` (WebGL twin).
- Inventory: `InventoryIntelligencePanel`, `InventoryIntelligenceSummary`, `InventoryReasonDialog`, `InventoryThresholdModal`.
- Reports: `AuditLogSection`, `GlobalMaterialSearchPanel`.
- Admin: `AvailabilityCleanupWizard`.
- Platform: `PlatformBroadcastAdminPanel`, `PlatformBroadcastGate`.
- Shared UI states: `PhoenixLoadingState`, `PhoenixEmptyState`, `PhoenixErrorState`, `PhoenixDialog`, `PhoenixToast`, `MobilePrintFallbackModal`.

## Per-screen redesign checklist (applied to every row above)

Header hierarchy · filters · actions · table/card/list · loading · skeleton · empty ·
error · denied · offline · success feedback · confirm dialog · mobile layout ·
keyboard/focus · AR/EN · RTL/LTR · light/dark · print (where applicable).

## Blocked items (gate — do not fabricate)

1. **Master source images** (`design/phoenix-source/phoenix-login-master-4k.png`,
   `phoenix-welcome-keyframe-master-4k.png`, `phoenix-welcome-clean-plate-master-4k.png`,
   `phoenix-dashboard-reference-master-4k.png`, `phoenix-babil-map-master-4k.png`,
   `phoenix-app-icon-master-2048.png`, wordmark/mark SVGs) — not present in repo.
   Gates: Login photo, WebGL welcome texture, PWA icon regeneration.
2. **Draft PR** — `gh` token invalid; cannot open/push. Work proceeds locally.

## Guardrails held (unchanged)

migrations 001–077 · RLS/RBAC · RPC signatures · no service_role/auth.admin in
frontend · no direct table writes · no invented data · no `warehouse_supply_routes`
operational dependency.
