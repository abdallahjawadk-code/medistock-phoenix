# Phoenix Nexus W2 — Screen and State Map

This map is the visual implementation boundary for W2. It is derived from the
current `master` runtime graph at `2af7f87719258f70a557577472fbe5f63ed34dd6`.
W2 changes presentation only: existing screen numbers, handlers, services,
RPC calls, permission predicates, `ScreenAuthzGuard`, RLS and RBAC contracts
remain authoritative.

## Authenticated screen matrix

| Screen | Current source | Operational surface | W2 visual coverage | Authorization boundary |
| --- | --- | --- | --- | --- |
| 3 | `EditorScreen.tsx` | Availability editor | page stage, form fields, material rows, action bars, validation/loading/error states | existing screen guard + existing mutation path |
| 4 | `RegistryScreen.tsx` | Registry | page stage, cards, search/filter controls, responsive records | existing screen guard + service contracts |
| 5 | `MeshScreen.tsx` | Institution mesh | command cards, route affordances, responsive action layout | existing navigation visibility and handlers |
| 6 | `QrScreen.tsx` | QR center | QR cards, scanner/generator surfaces, trust states, mobile layout | existing QR permissions and handlers |
| 7 | `HealthScreen.tsx` | Health/status view | status cards, indicators, empty/loading/error states | existing read services |
| 8 | `IntakeFrozenScreen.tsx` | Frozen intake notice | restrained blocked/frozen state and recovery navigation | existing frozen workflow |
| 9 | `ReportsScreen.tsx` | Reports | report tabs, audit/search panels, export controls, dense tables | super-admin visibility remains unchanged |
| 10 | `MobileCommandScreen.tsx` | Mobile command view | touch-first command cards and safe-area layout | existing navigation handlers |
| 11 | `InstitutionScreen.tsx` | Institutions, stores and outlets | organization cards, nested stores/outlets, dialogs, destructive-state emphasis | existing scoped permissions and RPCs |
| 12 | `StatusCenterScreen.tsx` | Real-data landing/status dashboard | operational hero, live status matrix, quick actions, alerts, activity, filters, tables, reports and intelligence | existing `item_availability` reads and permission-gated actions |
| 13 | `InterInstitutionAlertsScreen.tsx` | Inter-institution alerts/exchange | alert lifecycle, filters, severity cards and response dialogs | existing alert permissions and lifecycle service |
| 14 | `UserManagementScreen.tsx` | Users, roles and scopes | identity cards, role/scope panels, forms and dialogs | existing granular permission predicates and scoped RPCs |
| 15 | `MyAccountScreen.tsx` | Account | profile/security surfaces and read-only identity details | authenticated user only |
| 16 | `StatusEditorScreen.tsx` | Status editor | editor controls and canonical status presentation | existing availability permissions |
| 17 | `NetworkManagementScreen.tsx` | Warehouses, routes and scopes | live network twin, tabs, cards, forms and scope assignments | existing super-admin / `users.edit_scope` gates |

Screen 12 remains the current real-data landing screen. W2 does not restore the
retired screen 2 or introduce a second dashboard route.

## Global and anonymous surfaces

- Login, password reset and cinematic welcome.
- Anonymous public QR result page.
- Desktop sidebar, topbar, command palette, mobile drawer and bottom navigation.
- PWA install prompt and platform broadcast gate.
- Shared cards, buttons, inputs, selects, badges, toasts, dialogs, empty,
  loading, error and access-denied states.

## Modal and edge-state coverage

- Quantity adjustment, material reactivation and movement history.
- Outlet availability report and mobile print fallback.
- Inventory threshold and reason dialogs.
- Availability cleanup wizard and platform broadcast administration.
- Institution material details and institution/network editing surfaces.
- Loading, empty, error, disabled, frozen, removed, expired, near-expiry,
  low-stock, missing, surplus, inactive and permission-denied states.

## Responsive and accessibility matrix

- Viewports: 360×800, 390×844, 768×1024, 1366×768 and 1920×1080.
- Arabic/RTL and English/LTR.
- Day and night themes.
- Keyboard focus, touch targets, horizontal data-table containment and safe areas.
- `prefers-reduced-motion`, WebGL safe mode, forced-colors and print fallbacks.

## Explicit non-goals

- No migration, SQL, schema, data or auth changes.
- No RPC signature or service behavior changes.
- No RLS/RBAC mode or permission-key changes.
- No OCR, WhatsApp alerting or thermal-camera functionality.
