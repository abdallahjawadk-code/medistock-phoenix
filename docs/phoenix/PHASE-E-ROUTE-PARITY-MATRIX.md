# Phase E — Operational Route Parity Matrix

Branch: `feat/phoenix-redesign-phase-e-operational` (base `ff35bf0`, canonical Phase-D).

Surgical completion: the approved Phase A–D Phoenix system (tokens, typography,
shell, primitives, spacing, motion, a11y) is the authoritative reference. Every
route preserves its screen number, navigation, deep-link, hooks, services,
handlers, calculations, Supabase/RPC contracts and permission gates. No backend,
migration, RLS, RBAC or Auth change. No availability-writer semantics change
(P6 owns the Inventory Intake conversion).

## Live route inventory (authoritative — `src/app/AuthenticatedApp.tsx`)

| # | Screen component | Family | Legacy signal at start | Status |
|---|---|---|---|---|
| 3 | EditorScreen (Availability Editor) | E1 | 4 emoji | ✅ emoji→SVG; states verified |
| 4 | RegistryScreen | E2 | 3 emoji | ⏳ |
| 5 | MeshScreen | E3 | 1 emoji | ⏳ |
| 6 | QrScreen | E7 | 22 emoji, 34 color-literals (classify QR-module vs legacy) | ⏳ |
| 7 | HealthScreen | E4 | 4 emoji | ⏳ |
| 8 | IntakeFrozenScreen | E2 | 9 emoji | ⏳ |
| 9 | ReportsScreen | E6 | 6 emoji | ⏳ |
| 10 | MobileCommandScreen | E3 | 1 emoji | ⏳ |
| 11 | InstitutionScreen | E5 | 46 emoji, 12 color-literals | ⏳ |
| 12 | StatusCenterScreen | E1 | 27 emoji | ✅ emoji→SVG; a11y 44px; states |
| 13 | InterInstitutionAlertsScreen | E4 | 9 emoji | ⏳ |
| 14 | UserManagementScreen | E5 | 3 emoji | ⏳ |
| 15 | MyAccountScreen | E7 | 0 emoji | ⏳ |
| 16 | StatusEditorScreen | E1 | 5 emoji | ✅ emoji→SVG; +loading/error state |
| 17 | NetworkManagementScreen | E5 | twin done (Phase D); chrome 5 emoji | ⏳ chrome only |

Non-nav / sub-surfaces tracked per family: modals (AdjustQuantity, Reactivate,
MovementHistory, OutletAvailabilityReport, AvailabilityItemDetails), sections
(InternalAlerts, MovementReport, AuditLog, InventoryIntelligence panels),
DirectSupplyOperations, GlobalMaterialSearchPanel, PublicQrScreen (anon route),
PlatformBroadcast admin.

## Legend
✅ complete (parity + zero residual legacy) · ⏳ pending · ◐ code-complete, evidence pending.

## Notes
- Print-HTML color literals (`color:#111`, `th{background:#eee}` in StatusCenter
  / MovementReport / StatusEditor print generators) are **legitimate** — print
  documents cannot read app CSS custom properties and must be black-on-white for
  paper. Not legacy; retained.
- WebGL/GL material colors in `network` twin scene and QR-module colors are
  functional, not presentational tokens — classified per family, not blindly
  tokenized.

## Family log
- **E1** (`7f2a2d1`) — Status Center, Status Editor, Availability Editor +
  OutletAvailabilityReportModal + MovementHistoryModal. 36 emoji → Phoenix SVG
  icons; QuickActionGrid / SmartFilterChips / PhoenixStatusBadge / PhoenixEmptyState
  upgraded to the canonical `PhoenixIconName` icon contract; sub-44px chips and
  view-toggles raised to 44×44; StatusEditor gained a real loading + error state.
  Availability write semantics untouched.
