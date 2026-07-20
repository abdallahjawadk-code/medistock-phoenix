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
| 3 | EditorScreen (Availability Editor) | E1 | 4 emoji | ✅ emoji→SVG; states |
| 4 | RegistryScreen | E2 | 3 emoji | ✅ emoji→SVG |
| 5 | MeshScreen | E3 | 1 emoji | ✅ emoji→SVG |
| 6 | QrScreen | E7 | 22 emoji, 34 color-literals | ✅ emoji→SVG; ~30 colors→tokens (QR-module/print kept) |
| 7 | HealthScreen | E4 | 4 emoji | ✅ emoji→SVG |
| 8 | IntakeFrozenScreen | E2 | 9 emoji | ✅ emoji→SVG; rgba→token (stays frozen for P6) |
| 9 | ReportsScreen | E6 | 6 emoji | ✅ emoji→SVG |
| 10 | MobileCommandScreen | E3 | 1 emoji | ✅ emoji→SVG |
| 11 | InstitutionScreen | E5 | 46 emoji, 12 color-literals | ✅ 47 emoji→SVG (12 colors functional QR/print — kept) |
| 12 | StatusCenterScreen | E1 | 27 emoji | ✅ emoji→SVG; a11y 44px; states |
| 13 | InterInstitutionAlertsScreen | E4 | 9 emoji | ✅ emoji→SVG |
| 14 | UserManagementScreen | E5 | 3 emoji | ✅ emoji→SVG |
| 15 | MyAccountScreen | E7 | 0 emoji | ✅ already clean (no change needed) |
| 16 | StatusEditorScreen | E1 | 5 emoji | ✅ emoji→SVG; +loading/error state |
| 17 | NetworkManagementScreen | E5 | twin done (Phase D); chrome 5 emoji | ✅ chrome emoji→SVG |

Sub-surfaces completed: OutletAvailabilityReportModal, MovementHistoryModal
(E1), DirectSupplyOperations (E3), InventoryIntelligencePanel/Summary (E4),
AvailabilityItemDetailsModal (E5), AuditLogSection/GlobalMaterialSearchPanel
(E6), PublicQrScreen + DashboardScreen (E7). Shared primitives upgraded to the
canonical PhoenixIconName contract: QuickActionGrid, SmartFilterChips,
PhoenixStatusBadge, PhoenixEmptyState, PhoenixMetricCard (via resolveEmojiIcon).

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

## Result
**Zero emoji operational icons and zero legacy presentational color literals
remain across `src/features`** (verified by full-tree scan). The only surviving
color literals are functional: QR-code module colors (must stay dark-on-light to
scan) and print-document CSS (black-on-white for paper). Deferred, non-blocking
consistency item: a `--scrim` token for modal backdrops (`rgba(0,0,0,.45)`),
which is theme-agnostic and consistent today.

## Family log
- **E1** (`7f2a2d1`) — Status/Status-Editor/Availability-Editor + modals: 36
  emoji → SVG; QuickActionGrid/SmartFilterChips/PhoenixStatusBadge/PhoenixEmptyState
  → canonical `PhoenixIconName`; 38px chips/toggles → 44×44; StatusEditor gained
  loading+error states. Availability write semantics untouched.
- **E2** (`34b1841`) — RegistryScreen + IntakeFrozenScreen (stays frozen for P6):
  emoji → SVG; an rgba() border → color-mix token.
- **E3** (`3fbb7b4`) — DirectSupplyOperations, MeshScreen, MobileCommandScreen:
  supply/dispatch/receipt emoji + status glyphs → SVG.
- **E4** (`2b4b234`) — InterInstitutionAlerts, HealthScreen, InventoryIntelligence
  panel/summary: emoji → SVG; resolveEmojiIcon now passes clean names through.
- **E5** (`0e6a29f`) — InstitutionScreen (47 emoji), UserManagement,
  NetworkManagement chrome, AvailabilityItemDetailsModal → SVG. Institution's 12
  color literals confirmed functional (QR/print) and retained.
- **E6** (`3f3bde8`, `59aca9c`) — ReportsScreen, AuditLogSection,
  GlobalMaterialSearchPanel: emoji → SVG.
- **E7** (`e674c5b`, `063c94b`) — QrScreen (22 emoji → SVG, ~30 semantic colors →
  ok/warn/err tokens), PublicQrScreen, DashboardScreen (24 emoji + 2 colors).
  MyAccount already clean.

## Verification
typecheck ✅ · lint ✅ (0 errors, 3 warnings, ceiling 4) · build ✅ · full suite
8966 passed / 13 failed (the known Windows-CRLF source-scan set, green on Linux
CI). No new regressions; two source-scan tests updated to assert the stronger
44px a11y target and the tokenized QR risk-border (intent preserved, not weakened).
