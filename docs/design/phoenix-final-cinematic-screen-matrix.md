# Phoenix Nexus Final Cinematic — screen and state matrix

Screen 12 (Status Center) remains the real landing screen. Screen 2 is retired and must not be restored. Authorization is inherited from the existing routing and permission predicates; this document does not redefine access.

| Surface | Component | Access contract | Required states | Visual system status |
|---|---|---|---|---|
| Login | `LoginScreen` | Anonymous | default, invalid credentials, unavailable config, submitting | W1 cinematic identity; exact supervision copy corrected in PR #31 |
| Password recovery | `ResetPasswordScreen` | Recovery session | verifying, ready, validation, expired/no session, success | Final-cinematic recovery shell and source SVG icons |
| Welcome | `PhoenixWelcomeExperience` | Authenticated, once/session | motion, skip, reduced motion | W1 cinematic Phoenix scene retained |
| 3 Availability Editor | `EditorScreen` | Existing availability predicates | no scope, denied, create/edit, validation, preview, busy, success/error | Screen-aware header, organization context, shared forms/states |
| 4 Registry | `RegistryScreen` | Existing reachable legacy route only | no scope, loading, error, empty/no results, results | Screen-aware registry, search and SVG state icons |
| 5 Mesh | `MeshScreen` | Existing internal route | loading, error, empty, healthy/warn, selection | Screen-aware network map; current live reads preserved |
| 6 QR Audit | `QrScreen` | Existing QR/admin predicates | no scope, loading/error, summaries, filters, empty, disabled/risk | Secure QR identity, source SVG metrics/notices |
| Public QR | `PublicQrScreen` | Anonymous token route | loading, invalid token, empty, no available items, search/no results, availability/expiry | Dedicated cinematic public shell; no internal errors exposed |
| 7 Health | `HealthScreen` | Existing route | operational, safe mode, frozen, expanded modules, recovery clear | Operational command hierarchy and SVG health states |
| 8 Intake Frozen | `IntakeFrozenScreen` | Existing route | frozen-only contract | Protected/frozen cinematic surface; blocked workflows remain disabled |
| 9 Reports | `ReportsScreen` | `super_admin` / existing guard | no scope, loading/error/empty, summary, stock, missing, global search | Verified-report header and responsive tabular surfaces |
| 10 Mobile Command | `MobileCommandScreen` | Existing internal route | loading/error, metrics, institution status | Purpose-built mobile executive surface |
| 11 Institutions | `InstitutionScreen` | Existing org/user predicates | list, add, detail, warehouses, outlets, QR, dialogs, safe archive flows | Institution-network header and shared state system |
| 12 Status Center | `StatusCenterScreen` | Authenticated landing | role tabs, summaries, filters, table/outlet views, intelligence, exports, modals | W2 operational landing with real services preserved |
| 13 Inter-institution Alerts | `InterInstitutionAlertsScreen` | Existing alert predicates | loading/error/forbidden/empty, severity, grouping, lifecycle actions | Signals command surface; advisory/no-transfer notice retained |
| 14 Users and Scopes | `UserManagementScreen` | `users.view` / existing predicates | denied, list/search/filter, create, detail, role/permission/scopes, sensitive confirmations | RBAC presentation layer only; permission logic unchanged |
| 15 My Account | `MyAccountScreen` | Authenticated | account details, password/contact/preferences, busy/error/success | Secure identity surface; existing contact workflows unchanged |
| 16 Status Editor | `StatusEditorScreen` | Existing hidden/reachable contract | no scope, filters, empty, table, export/print | Operations-ledger visual treatment |
| 17 Network Management | `NetworkManagementScreen` | super / `users.edit_scope` | denied, tabs, empty/loading/error, dialogs, topology | W2 live network command surface and WebGL twin |
| Shared navigation | Shell/sidebar/drawer/bottom nav/palette | Existing predicates | active, hover/focus, mobile drawer, logout | W1/W2 deterministic SVG identity; no gated-item leakage |
| Shared overlays | Dialogs/toasts/permission gates/print fallback | Existing callers | focus, Escape, success/warn/error/denied, mobile | W2 shared presentation and accessible source icons |

## QA dimensions

Every reachable surface must be checked in Arabic/RTL and English/LTR, light and dark, keyboard navigation, reduced motion where animated, and at 360×800, 390×844, 768×1024, 1024×768 and 1440×900. WebGL additionally requires unavailable/context-loss/safe-mode behavior. A row is not finally accepted until its real rendered screenshots and console/network checks are attached to the QA report for the tested SHA.
