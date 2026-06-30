# MediStock-Babil Page Task Map, Duplicate Review, and Material Alerts Audit

**Task:** PAGE-TASK-MAP-DUPLICATE-REVIEW-AND-MATERIAL-ALERTS-AUDIT-A  
**Date:** 2026-06-30  
**Author:** Claude Sonnet 4.6 (analysis only — no code changes)  
**Branch:** master  
**Project:** medistock-phoenix  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope and Constraints](#2-scope-and-constraints)
3. [Project Verification](#3-project-verification)
4. [Full Route / Page Inventory](#4-full-route--page-inventory)
5. [Page-by-Page Task Map](#5-page-by-page-task-map)
6. [Workflow Map](#6-workflow-map)
7. [Duplicate / Overlap Analysis](#7-duplicate--overlap-analysis)
8. [Proposed Navigation Cleanup](#8-proposed-navigation-cleanup)
9. [Material Alerts — Proposed Operating Model](#9-material-alerts--proposed-operating-model)
10. [Current Alert Implementation Review](#10-current-alert-implementation-review)
11. [Recommended Alert Architecture](#11-recommended-alert-architecture)
12. [Comprehensive Improvement Roadmap](#12-comprehensive-improvement-roadmap)
13. [Risks and Open Questions](#13-risks-and-open-questions)
14. [Recommended Next Implementation Phases](#14-recommended-next-implementation-phases)
15. [Final Summary Table](#15-final-summary-table)

---

## 1. Executive Summary

MediStock-Babil Phoenix V2 is a bilingual (Arabic / English) medical supply availability management system for the MASAR Health Network. It serves multiple hospitals in Babil governorate by tracking drug and material availability at distribution points and exposing public QR-scannable availability pages.

**The application currently has 18 distinct screens** (including 2 public/unauthenticated), organized into a screen-number routing system (`setScreen(n)`) rather than URL-based routing. Navigation is controlled through `PhoenixSidebar` and `PhoenixMobileBottomNav`.

**Key findings:**

1. **6 significant duplicate or overlapping page pairs** exist. The most urgent are: Dashboard ↔ Mesh View (duplicate institution status cards), Reports ↔ Status Editor (overlapping material tables), and MobileCommandScreen ↔ Dashboard (same data, different layout).

2. **Material alerts are entirely frontend-computed** at render time from raw database reads. There is no persistent alert engine, no acknowledgement, and no automated expiry detection. The `near_expiry` condition is manually assigned by staff — the system does not auto-detect expiring materials from the `expiry_date` field.

3. **System Health screen shows fully hardcoded demo data.** It is not connected to any real Supabase data source. This is misleading if treated as real operational monitoring.

4. **The Intake module is correctly frozen** with a proper safety screen. It must remain frozen.

5. **The highest-priority privacy risk** is that the public QR page calls `getPublicQrPayload` via an RPC — but whether that RPC correctly enforces RLS on batch numbers, prices, and internal notes needs explicit verification. The current `qr_no_expose` UI label is a promise, not a guarantee.

6. **Dashboard exchange-alert cards navigate to Screen 12 (Status Center)** but logically they should navigate to Screen 13 (Inter-Institution Alerts). This is a UX mismatch.

---

## 2. Scope and Constraints

**What was analyzed:**
- All 18 TypeScript/TSX screen files in `src/features/**` and routing in `src/app/App.tsx`
- Sidebar and mobile nav configuration in `src/shared/ui/PhoenixSidebar.tsx`
- Permission matrix in `src/shared/lib/permissions.ts`
- All i18n strings in `src/shared/i18n/strings.ts`
- All service files in `src/shared/supabase/services/`
- Alert logic in `src/features/status/exchange-alerts.ts` and `src/features/alerts/inter-institution-alerts.service.ts`
- Database schema from `supabase/migrations/001` through `026`
- Role definitions in `src/shared/lib/roles.ts` and `types.ts`

**What was NOT done (by design):**
- No code changes
- No SQL or migrations
- No RLS changes
- No permission changes
- No deployment actions
- No `npm audit fix`

---

## 3. Project Verification

```
pwd:     /c/Users/abdal/OneDrive/Desktop/phoenix
remote:  https://github.com/abdallahjawadk-code/medistock-phoenix.git (origin)
branch:  master
package: medistock-phoenix v2.0.0 — "MediStock-Babil Phoenix V2 — Clean rebuild"
HEAD:    8c44aae — Add interactive QR preview and print for ports
```

**Verification gates:**
- `npm run lint`:  ✅ PASS (0 errors, 0 warnings)
- `npm run build`: ✅ PASS (202 modules, built in 2.23s)
- `npm test`:      ✅ PASS (17 test files, 1812 tests)
- `npm audit`:     ⚠ 5 vulnerabilities (3 moderate, 1 high, 1 critical) — NOT fixed (prohibited by task)

---

## 4. Full Route / Page Inventory

The application uses a **screen-number SPA routing** model, not URL routing. The root URL (`/`) renders the main app shell. The only URL-based differentiation is the `?qid=` or `?token=` query parameter which triggers the public QR view, and the password-recovery mode detected from the Supabase auth event.

| Screen # | Route / Trigger | Component | Status |
|----------|----------------|-----------|--------|
| PUBLIC | `/?qid={token}` or `/?token={token}` | `PublicQrScreen` | Existing |
| AUTH | `/` (no session) | `LoginScreen` | Existing |
| AUTH | `/` (password recovery event) | `ResetPasswordScreen` | Existing |
| 2 | Default authenticated | `DashboardScreen` | Existing |
| 3 | Sidebar nav | `EditorScreen` | Existing |
| 4 | Sidebar nav | `RegistryScreen` | Existing |
| 5 | Sidebar nav | `MeshScreen` | Existing |
| 6 | Sidebar nav | `QrScreen` | Existing |
| 7 | Sidebar nav | `HealthScreen` | Placeholder (hardcoded data) |
| 8 | Sidebar nav (frozen) | `IntakeFrozenScreen` | Frozen/disabled |
| 9 | Sidebar nav | `ReportsScreen` | Partial |
| 10 | Secondary nav | `MobileCommandScreen` | Partial |
| 11 | Sidebar nav | `InstitutionScreen` | Existing |
| 12 | Sidebar nav | `StatusCenterScreen` | Existing |
| 13 | Sidebar nav | `InterInstitutionAlertsScreen` | Existing |
| 14 | Sidebar nav | `UserManagementScreen` | Existing |
| 15 | Secondary nav | `MyAccountScreen` | Existing |
| 16 | Sidebar nav | `StatusEditorScreen` | Existing |

**Total: 18 screens** (16 authenticated + 2 public/pre-auth)

---

## 5. Page-by-Page Task Map

### 5.1 PublicQrScreen — عرض توفر الدواء العام

| Field | Value |
|-------|-------|
| Route | `/?qid={publicId}` or `/?token={publicId}` |
| Component | `src/features/qr/PublicQrScreen.tsx` |
| Arabic Name | توفر الأدوية العام |
| English Name | Public Drug Availability |
| Access | Anonymous — no authentication required |
| Main Purpose | Allow any citizen/patient to scan a QR code at a hospital dispensary and view the current drug availability status |
| Key User Tasks | View list of items; Filter by name (search); Toggle Arabic/English language |
| Data Read | Calls `getPublicQrPayload(publicId)` → `supabase.rpc('get_public_qr_payload', {p_public_id})` |
| Data Write | None (read-only public page) |
| Supabase Tables | `qr_tokens`, `qr_targets`, `item_availability` (via RPC) |
| Required Permissions | None (anonymous) |
| User Roles | Any person with a QR code |
| Status | **Existing** — works, but privacy guarantee depends on RPC correctness |
| Notes | ⚠ Privacy risk: batch_number, price, supply_type, internal notes must NOT be returned by the RPC. This must be verified at the RPC layer, not just the UI layer. The current UI label "لا كشف لبيانات الدُفعات" is a UI promise, not a DB enforcement. |

---

### 5.2 LoginScreen — تسجيل الدخول

| Field | Value |
|-------|-------|
| Route | `/` (unauthenticated) |
| Component | `src/features/auth/LoginScreen.tsx` |
| Arabic Name | تسجيل الدخول |
| English Name | Sign In |
| Access | Public |
| Main Purpose | Authenticate users via Supabase Auth (email/password or local username) |
| Key User Tasks | Enter credentials; Request password reset link |
| Data Read | Supabase Auth session check |
| Data Write | Supabase Auth signIn |
| Required Permissions | None |
| Status | **Existing** |
| Notes | Supports both email-based login and local username mode (migration 016). |

---

### 5.3 ResetPasswordScreen — إعادة تعيين كلمة المرور

| Field | Value |
|-------|-------|
| Route | `/` (password recovery Supabase event) |
| Component | `src/features/auth/ResetPasswordScreen.tsx` |
| Arabic Name | إعادة تعيين كلمة المرور |
| English Name | Reset Password |
| Access | Semi-public (requires password recovery token in session) |
| Main Purpose | Allow user to set a new password after clicking reset link from email |
| Key User Tasks | Enter and confirm new password |
| Data Write | `supabase.auth.updateUser({ password })` |
| Status | **Existing** |

---

### 5.4 DashboardScreen (Screen 2) — لوحة القيادة المركزية

| Field | Value |
|-------|-------|
| Screen # | 2 |
| Component | `src/features/dashboard/DashboardScreen.tsx` |
| Arabic Name | لوحة القيادة المركزية |
| English Name | Central Dashboard |
| Main Purpose | Single command overview: infrastructure metrics, status report summaries, exchange alert preview, institution health cards, and quick-action navigation |
| Key User Tasks | View system metrics; Click institution card → navigate to Screen 11; Click exchange alert → navigate to Screen 12 (⚠ WRONG — should be 13); Use quick-action buttons |
| Data Read | `getDashboardMetrics()`, `getInstitutionOverviews()`, `getStatusReportCounts()`, `getStatusReports({activeOnly:true})` |
| Derived | `generateExchangeAlerts()` computed client-side from status reports |
| Supabase Tables | `organizations`, `warehouses`, `distribution_points`, `qr_tokens`, `item_availability`, `institution_item_status_reports` |
| Required Permissions | `dashboard.view` |
| User Roles | All authenticated roles |
| Status | **Existing** |
| Notes | ⚠ BUG: Exchange alert cards call `onNavigate(12)` (Status Center) but should call `onNavigate(13)` (Inter-Institution Alerts). ⚠ Dashboard fetches ALL `item_availability` conditions without pagination — may be slow for large datasets. |

---

### 5.5 EditorScreen (Screen 3) — محرر التوفر

| Field | Value |
|-------|-------|
| Screen # | 3 |
| Component | `src/features/editor/EditorScreen.tsx` |
| Arabic Name | محرر التوفر |
| English Name | Availability Editor |
| Main Purpose | Manual single-record entry/update for material availability at a specific distribution point |
| Key User Tasks | Select institution (super_admin can switch); Select distribution point; Enter scientific name, trade name, dosage form, concentration, price, quantity, condition, national code, expiry date, supply type, notes; Confirm and submit |
| Data Read | `getPointsByOrg()`, `getOrganizations()`, `getOrganization()` |
| Data Write | `upsertAvailability()` — upserts into `item_availability` on `(distribution_point_id, scientific_name)` |
| Supabase Tables | `distribution_points`, `organizations`, `item_availability` |
| Required Permissions | `availability.manage` |
| User Roles | `hospital_admin`, `warehouse_manager`, `point_operator` |
| Status | **Existing** |
| Notes | 'expired' is not an available condition choice here (per design); only 4 options. `near_expiry` and `surplus` are merged into a single option. No batch-level listing or review of existing records on this screen. |

---

### 5.6 RegistryScreen (Screen 4) — سجل العناصر

| Field | Value |
|-------|-------|
| Screen # | 4 |
| Component | `src/features/registry/RegistryScreen.tsx` |
| Arabic Name | سجل العناصر |
| English Name | Item Registry |
| Main Purpose | View the institution-local item list (local_items mapped to central_items). Read-only view with search. |
| Key User Tasks | Search items; View item details (local code, category, manufacturer, status) |
| Data Read | `getLocalItems(orgId)` — joins `local_items` + `central_items` |
| Supabase Tables | `local_items`, `central_items` |
| Required Permissions | `organizations.view` or authenticated |
| User Roles | All roles |
| Status | **Partial** — displays items but has NO add/edit/delete functionality from this screen. |
| Notes | The `QuickAvailForm` in InstitutionScreen uses `getLocalItems()` to populate item dropdown. The Registry is a read-only view. Item creation is not implemented on this screen. |

---

### 5.7 MeshScreen (Screen 5) — عرض الشبكة

| Field | Value |
|-------|-------|
| Screen # | 5 |
| Component | `src/features/mesh/MeshScreen.tsx` |
| Arabic Name | عرض الشبكة |
| English Name | Mesh View |
| Main Purpose | Visual overview of all institutions in the network, with availability health indicators. Clicking an institution card shows a detail side-panel. |
| Key User Tasks | Click institution to view its available/low/missing counts and health percentage; Navigate to editor or QR screen from detail panel |
| Data Read | `getInstitutionOverviews()` |
| Supabase Tables | `organizations`, `item_availability` |
| Required Permissions | `organizations.view` |
| User Roles | All roles |
| Status | **Partial** — shows institution grid with health dots; side panel navigates to other screens but does not go to institution detail directly (navigates to screen 3 or 6, not 11) |
| Notes | ⚠ DUPLICATE with DashboardScreen Section 3 (Institution Status Cards). Both render identical `getInstitutionOverviews()` data with the same available/low/missing breakdown. Differences: Mesh has an expand/select side panel; Dashboard has the full metrics at top. The core institution status card is the same. |

---

### 5.8 QrScreen (Screen 6) — مركز QR

| Field | Value |
|-------|-------|
| Screen # | 6 |
| Component | `src/features/qr/QrScreen.tsx` |
| Arabic Name | مركز QR |
| English Name | QR Center |
| Main Purpose | Admin view of all QR tokens for the active organization: list active/disabled tokens, disable (revoke) active tokens. |
| Key User Tasks | View all QR tokens with their public URLs and scan stats; Disable an active QR token |
| Data Read | `getQrTokensByOrg(orgId)` |
| Data Write | `disableQrToken(id)` |
| Supabase Tables | `qr_tokens`, `qr_targets` |
| Required Permissions | `qr.view`, `qr.revoke` |
| User Roles | `super_admin`, `hospital_admin`, `warehouse_manager` |
| Status | **Existing** |
| Notes | ⚠ OVERLAP with InstitutionScreen: QR tokens are also created, revoked, and regenerated within InstitutionScreen (Screen 11) port cards. QrScreen provides a flat list view; InstitutionScreen provides port-contextualized QR management. The QR Center adds "disable" but not "generate" or "regenerate." QR generation only happens in InstitutionScreen. |

---

### 5.9 HealthScreen (Screen 7) — صحة النظام

| Field | Value |
|-------|-------|
| Screen # | 7 |
| Component | `src/features/health/HealthScreen.tsx` |
| Arabic Name | صحة النظام |
| English Name | System Health |
| Main Purpose | Intended to show real-time health of system modules, bridge uptime, latency, and event log |
| Key User Tasks | View module health indicators; Expand module cards for details |
| Data Read | **None — all data is hardcoded** |
| Supabase Tables | None |
| Status | **Placeholder** — all data is static demo values. No real Supabase queries exist. Module "uptime" (99.8%, 96.2%), "latency" (42ms), "QR Active" (4/4), "Scans/day" (~127), and the event log are all hardcoded constants. |
| Notes | ⚠ HIGH RISK: This screen appears to show real system status but is entirely fabricated. Any operator who relies on this screen for operational decisions will be misled. Should be either connected to real data or clearly marked as "Demo / Not Connected." |

---

### 5.10 IntakeFrozenScreen (Screen 8) — الإدخال (مجمد)

| Field | Value |
|-------|-------|
| Screen # | 8 |
| Component | `src/features/health/IntakeFrozenScreen.tsx` |
| Arabic Name | الإدخال |
| English Name | Intake (Frozen) |
| Main Purpose | Safety screen showing the Intake module is intentionally disabled |
| Blocked Workflows | Excel Import, OCR Scan, CSV Upload, Doc Intelligence, Smart Intake, Smart Manual |
| Data Read | None |
| Data Write | None |
| Status | **Frozen / Disabled — must remain disabled** |
| Notes | Screen correctly redirects to EditorScreen (Screen 3) as the approved alternative. Safe as-is. |

---

### 5.11 ReportsScreen (Screen 9) — التقارير

| Field | Value |
|-------|-------|
| Screen # | 9 |
| Component | `src/features/reports/ReportsScreen.tsx` |
| Arabic Name | التقارير |
| English Name | Reports |
| Main Purpose | Read-only reporting dashboard with tabs: Summary, Low Stock, Missing, Comparison, Audit Log |
| Key User Tasks | Switch report tabs; View low-stock item list; View missing items; View institution comparison; View audit log |
| Data Read | `getDashboardMetrics()`, `getInstitutionOverviews()`, `getLowStockItems()`, `getAuditLog()` |
| Supabase Tables | `item_availability`, `organizations`, `audit_log` |
| Required Permissions | `availability.view` |
| User Roles | All roles |
| Status | **Partial** — tabs exist; Low Stock and Missing pull real data; Comparison and Audit tabs need review for completeness |
| Notes | ⚠ OVERLAP with StatusEditorScreen (Screen 16): both show material lists filtered by status. See duplicate analysis §7. |

---

### 5.12 MobileCommandScreen (Screen 10) — العرض المحمول

| Field | Value |
|-------|-------|
| Screen # | 10 |
| Component | `src/features/mesh/MobileCommandScreen.tsx` |
| Arabic Name | العرض المحمول |
| English Name | Mobile View |
| Main Purpose | Compact mobile-optimized command center: SVG ring chart of availability score, institution status mini-list, and quick navigation buttons |
| Key User Tasks | View availability percentage ring; Tap institution row; Navigate to QR screen |
| Data Read | `getDashboardMetrics()`, `getInstitutionOverviews()` |
| Supabase Tables | `item_availability`, `organizations` |
| Required Permissions | `dashboard.view` |
| Status | **Partial** |
| Notes | ⚠ DUPLICATE with DashboardScreen: uses identical data sources (`getDashboardMetrics`, `getInstitutionOverviews`) and shows a subset of dashboard information in a compact layout. Since the app already has a responsive design (isMobile checks), this screen may be redundant. The main sidebar collapses to bottom nav on mobile via `PhoenixMobileBottomNav`. |

---

### 5.13 InstitutionScreen (Screen 11) — إدارة المؤسسات

| Field | Value |
|-------|-------|
| Screen # | 11 |
| Component | `src/features/institutions/InstitutionScreen.tsx` |
| Arabic Name | إدارة المؤسسات |
| English Name | Institutions |
| Main Purpose | The most feature-rich screen. Manages organizations, their users, distribution ports, QR lifecycle, port availability, and cleanup wizards. |
| Key User Tasks | List all organizations (super_admin); View organization details; Add/edit organization; Assign/change user roles; View/add/edit/archive distribution points; Generate/revoke/regenerate QR codes; Preview and print QR; Add quick availability items; Clear port items; Archive organization |
| Data Read | `getOrganizations()`, `getOrganization()`, `getProfilesByOrg()`, `getPointsByOrg()`, `getQrForPoint()`, `getAvailabilityByPoint()`, `getLocalItems()`, `getEntityPurgeImpact()`, `getOrgDeleteImpact()` |
| Data Write | `createOrganization()`, `updateOrganization()`, `updateProfileRole()`, `createDistributionPoint()`, `createQrForTarget()`, `disableQrToken()`, `regenerateQrForPoint()`, `archiveEntity()`, `upsertAvailability()`, `clearPortAvailability()`, `archiveOrganization()` |
| Supabase Tables | `organizations`, `profiles`, `warehouses`, `distribution_points`, `qr_tokens`, `qr_targets`, `item_availability`, `local_items`, `central_items` |
| Required Permissions | `organizations.view`, `organizations.edit` (super), `ports.view`, `ports.create`, `ports.edit`, `ports.archive`, `qr.view`, `qr.generate`, `qr.revoke`, `availability.manage`, `deletion_wizard.view`, `deletion_wizard.clear_port_items`, `deletion_wizard.archive_port`, `deletion_wizard.archive_organization` |
| User Roles | `super_admin` (full), `hospital_admin` (own org, no org-create/archive), `warehouse_manager` (ports, QR, availability) |
| Status | **Existing — the most complete screen in the app** |
| Notes | This screen is a "mega-screen" that combines many sub-workflows. The port section, QR section, availability section, and cleanup wizard are all embedded sub-components. Consider whether some of these warrant dedicated screens in a future phase. |

---

### 5.14 StatusCenterScreen (Screen 12) — مركز المواقف

| Field | Value |
|-------|-------|
| Screen # | 12 |
| Component | `src/features/status/StatusCenterScreen.tsx` |
| Arabic Name | مركز المواقف |
| English Name | Status Center |
| Main Purpose | CRUD interface for `institution_item_status_reports`. Staff manually flag materials as scarce / surplus / near_expiry / missing at the organization level. Also shows computed exchange alerts (a subset of what InterInstitutionAlertsScreen shows). |
| Key User Tasks | List status reports (filterable by type, active/all, search); Add new report; Edit report; Resolve report; View exchange alert recommendations |
| Data Read | `getStatusReports()`, `getOrganizations()` |
| Data Write | `createStatusReport()`, `updateStatusReport()`, `resolveStatusReport()` |
| Supabase Tables | `institution_item_status_reports`, `organizations` |
| Required Permissions | `status_center.view`, `status_center.create`, `status_center.edit`, `status_center.resolve` |
| User Roles | `super_admin`, `hospital_admin`, `warehouse_manager`, `monthly_status_officer` |
| Status | **Existing** |
| Notes | This screen is the DATA SOURCE for inter-institution alerts. Status reports manually entered here are consumed by `generateExchangeAlerts()` to produce the alerts shown on Screen 13. |

---

### 5.15 InterInstitutionAlertsScreen (Screen 13) — تنبيهات بين المؤسسات

| Field | Value |
|-------|-------|
| Screen # | 13 |
| Component | `src/features/alerts/InterInstitutionAlertsScreen.tsx` |
| Arabic Name | تنبيهات بين المؤسسات |
| English Name | Inter-Institution Alerts |
| Main Purpose | Read-only view of computed exchange recommendations: where one institution has surplus/near_expiry of a material that another institution reports as scarce/missing. Includes contact info for the monthly status officer. |
| Key User Tasks | Filter by priority, status pair, institution; Search by item; Copy phone numbers; Open WhatsApp link; Copy recommendation text |
| Data Read | `getScopedInterInstitutionAlerts()` → calls `supabase.rpc('get_scoped_inter_institution_alerts')`, falls back to client-side computation for super_admin |
| Data Write | None (read-only) |
| Supabase Tables | `institution_item_status_reports`, `organizations`, `organization_status_contacts` |
| Required Permissions | `inter_institution_alerts.view` |
| User Roles | All roles with the view permission |
| Status | **Existing** |
| Notes | Data depends on migration 009 (status reports) and migration 008 (org status contacts). If migration for the RPC is not applied, non-super users see empty results with a migration warning. |

---

### 5.16 UserManagementScreen (Screen 14) — إدارة المستخدمين

| Field | Value |
|-------|-------|
| Screen # | 14 |
| Component | `src/features/users/UserManagementScreen.tsx` |
| Arabic Name | إدارة المستخدمين |
| English Name | User Management |
| Main Purpose | List users, view and edit per-user permission overrides, create new users, and manage user lifecycle (disable/enable/delete/recycle) |
| Key User Tasks | List/search/filter users; Expand user to manage permissions; Toggle individual permissions; Reset to role defaults; Create user (invite / local username / password modes); Disable/enable user; Delete user (with confirmation); Recycle account |
| Data Read | `listUsers()`, `getEffectivePermissions()`, `getOrganizations()`, `getOrgStatusContacts()` |
| Data Write | `assignProfilePermissions()`, `resetProfilePermissions()`, `createUserViaEdge()`, `disableUserViaEdge()`, `enableUserViaEdge()`, `recycleUserViaEdge()` |
| Supabase Tables | `profiles`, `user_permissions`, `organizations`, `organization_status_contacts` |
| Required Permissions | `users.view`, `users.manage_permissions`, `users.create`, `users.disable`, `users.delete`, `users.recycle` |
| User Roles | `super_admin`, `institution_admin`, `hospital_admin` |
| Status | **Existing** |
| Notes | User creation goes through a secure Edge Function, not direct client auth.admin calls. Three creation modes: email invite, local username, advanced password. |

---

### 5.17 MyAccountScreen (Screen 15) — حسابي

| Field | Value |
|-------|-------|
| Screen # | 15 |
| Component | `src/features/account/MyAccountScreen.tsx` |
| Arabic Name | حسابي |
| English Name | My Account |
| Main Purpose | Show current user's profile information and allow password changes |
| Key User Tasks | View name, role, email, institution; Change password; Request password reset email |
| Data Read | `session`, `profile` from `AppContext` |
| Data Write | `markPasswordChanged()`, `updatePassword()`, `requestPasswordReset()` |
| Supabase Tables | `profiles`, Supabase Auth |
| Required Permissions | Own session (no special permission needed) |
| User Roles | All roles |
| Status | **Existing** |

---

### 5.18 StatusEditorScreen (Screen 16) — محرر المواقف

| Field | Value |
|-------|-------|
| Screen # | 16 |
| Component | `src/features/status/StatusEditorScreen.tsx` |
| Arabic Name | محرر المواقف |
| English Name | Status Editor |
| Main Purpose | Unified read-only view of all `item_availability` records across all ports for the active organization, with filtering and CSV export. The name "editor" is misleading — it is a VIEW/EXPORT tool, not an edit form. |
| Key User Tasks | Filter by port; Filter by condition; Search by scientific/trade name; Export CSV |
| Data Read | `getAvailabilityByOrg()`, `getPointsByOrg()` |
| Data Write | None (read-only + CSV export) |
| Supabase Tables | `item_availability`, `distribution_points` |
| Required Permissions | `availability.view` |
| User Roles | All roles |
| Status | **Existing** |
| Notes | ⚠ NAMING CONFUSION: "محرر المواقف" (Status Editor) is actually a READ-ONLY view with export. The actual editor is Screen 3 (Availability Editor). This name misleads users into thinking they can edit here. Should be renamed "عارض المواد / Material Viewer" or "تقرير المواد / Material Report." ⚠ OVERLAP with Reports (Screen 9): both show material lists. |

---

## 6. Workflow Map

### WF-1: Login / Session / Profile

**Pages involved:** LoginScreen → AppProvider (AppContext) → DashboardScreen  
**Journey:**  
User opens app → Supabase session check → if no session, LoginScreen → enter email+password (or local username) → `supabase.auth.signInWithPassword` → AppProvider loads profile, role, permissions → navigates to DashboardScreen  
**Current weakness:** Password recovery requires email — local-username users must ask admin to reset via UserManagementScreen. No SSO or magic link flow.  
**Recommendation:** Surface a "contact your admin" message for local-username users on the forgot-password flow.

---

### WF-2: Dashboard / Command Overview

**Pages involved:** DashboardScreen (Screen 2), MobileCommandScreen (Screen 10)  
**Journey:**  
Authenticated user lands on Dashboard → sees metrics cards → institution health cards → exchange alerts preview → quick-action buttons  
**Current weakness:** Exchange alert cards navigate to wrong screen (Status Center instead of Inter-Institution Alerts). MobileCommandScreen duplicates dashboard data.  
**Recommendation:** Fix `onNavigate(12)` → `onNavigate(13)` in exchange alert cards. Remove or merge MobileCommandScreen.

---

### WF-3: Institution Management

**Pages involved:** InstitutionScreen (Screen 11)  
**Journey:**  
super_admin → lists all organizations → clicks one → OrgDetailView: edit org info, view users, change roles, manage ports, QR, availability  
hospital_admin → directly sees own org detail → manages ports, roles  
**Current weakness:** "Mega-screen" — institution detail, port management, QR lifecycle, availability quick-add, and cleanup wizard are all on one screen. Long scroll required.  
**Recommendation:** Consider splitting port management and cleanup wizard into separate screens or tabs in a future phase.

---

### WF-4: Ports / Distribution Points

**Pages involved:** InstitutionScreen (Screen 11) — PortSection  
**Journey:**  
User with `ports.create` → clicks "Add Port" → enters port name → port created + QR auto-generated → QR thumbnail appears on port card → can preview/print QR  
**Current weakness:** Port creation only accepts a name (name_ar same as name). Port type, warehouse assignment hardcoded to 'dispensing'. No warehouse selection UI despite warehouse_id being required at DB level (handled by migration 021 which removed the mandatory warehouse_id requirement or provides a default).  
**Recommendation:** Add port type selector. Add optional location notes field.

---

### WF-5: QR Creation / Preview / Public Access

**Pages involved:** InstitutionScreen (Screen 11), QrScreen (Screen 6), PublicQrScreen (public)  
**Journey:**  
Create port → QR auto-generated → thumbnail shown → click thumbnail → QrPreviewModal → print or regenerate  
Anyone scans QR → `/?qid={public_id}` → PublicQrScreen → shows safe availability list  
**Current weakness:** Two entry points for QR management: InstitutionScreen (generate/revoke/regenerate per-port) and QrScreen (list all, disable). These could be confused by users.  
**Recommendation:** Unify QR management under InstitutionScreen. Make QrScreen a read-only audit view showing scan counts.

---

### WF-6: Material Availability Editing

**Pages involved:** EditorScreen (Screen 3), InstitutionScreen (Screen 11) → PortAvailabilitySection  
**Journey:**  
Via EditorScreen: select institution (if super) → select port → fill full form → confirm → upsertAvailability  
Via InstitutionScreen: navigate to port card → click "+" in availability section → QuickAvailForm → save  
**Current weakness:** Two entry points to the same DB write operation. EditorScreen is full-form; QuickAvailForm is compact. The QuickAvailForm uses the legacy `local_items`/`central_items` join for item selection, while EditorScreen uses free-text scientific name directly (migration 020 approach). These two approaches may create inconsistency.  
**Recommendation:** Make EditorScreen the canonical entry point. The InstitutionScreen quick form is a convenience, but it should warn when the item doesn't have a `local_items` match.

---

### WF-7: Status Reports (Manual Alert Flagging)

**Pages involved:** StatusCenterScreen (Screen 12)  
**Journey:**  
Staff identifies a problem (scarce drug) → opens Status Center → "Add Report" → enters item name, status type, quantity, notes → save → report appears in list  
**Current weakness:** Status reports are manually entered. There is no automatic triggering from `item_availability` data. A drug can be marked "available" in item_availability but be flagged "scarce" in a status report — or vice versa — with no reconciliation.  
**Recommendation:** Add a button "Create report from availability record" that pre-fills the status form when an `item_availability` row shows `low_stock` or `missing`.

---

### WF-8: Inter-Institution Alerts / Exchange Recommendations

**Pages involved:** Dashboard (preview, Screen 2), StatusCenterScreen (source data, Screen 12), InterInstitutionAlertsScreen (full view, Screen 13)  
**Journey:**  
Status reports from multiple institutions → `generateExchangeAlerts()` / RPC → ranked recommendations appear on Screen 13  
Dashboard shows top-3 preview  
**Current weakness:** Three-level data chain (raw availability → status reports → exchange alerts) is non-obvious to users. Dashboard's click on exchange alerts goes to wrong screen (12 not 13).  
**Recommendation:** Fix navigation bug. Add tooltip on Status Center explaining it feeds the Inter-Institution Alerts screen.

---

### WF-9: User and Permission Management

**Pages involved:** UserManagementScreen (Screen 14), InstitutionScreen (user role section, Screen 11)  
**Journey:**  
Admin → UserManagement → select user → expand permission matrix → toggle permissions → save  
Admin → InstitutionScreen → Users section → change role  
**Current weakness:** Role assignment happens in TWO places: InstitutionScreen's UserRow (role only) and UserManagementScreen (full permission matrix). The InstitutionScreen role changer is simpler but less granular.  
**Recommendation:** Keep both (they serve different scopes), but add a link from InstitutionScreen user row to the full permission management in UserManagementScreen.

---

### WF-10: Reports and Audit

**Pages involved:** ReportsScreen (Screen 9), StatusEditorScreen (Screen 16)  
**Journey:**  
User → Reports → tabs: Summary / Low Stock / Missing / Comparison / Audit Log  
User → Status Editor → filter by port/condition → export CSV  
**Current weakness:** Two screens serve very similar purposes. Reports has tabs but no CSV export. Status Editor has CSV export but no tabs or summary. Neither is a complete reporting solution.  
**Recommendation:** Merge into one screen with tabs + export.

---

### WF-11: Disabled Modules

**Pages involved:** IntakeFrozenScreen (Screen 8)  
**Status:** Correctly frozen. Shows Excel/OCR/CSV/DocIntel/SmartIntake as blocked. Redirects to EditorScreen.  
**Recommendation:** Keep as-is.

---

### WF-12: Settings / Language / RTL

**Pages involved:** All screens — language toggle in PublicQrScreen header; `lang` state in AppContext  
**Current weakness:** Language toggle is only explicitly surfaced in the Public QR screen. In the main app, no visible language toggle button exists in the sidebar. Users can't discover it unless they know where to look (there may be one in the top bar depending on implementation).  
**Recommendation:** Add a language toggle button to the sidebar footer or topbar.

---

### WF-13: Audit Logs

**Pages involved:** ReportsScreen (Screen 9) → Audit Log tab  
**Status:** `getAuditLog(orgId)` exists in `audit.service.ts` and is called from ReportsScreen. **Partial** — data source exists but the UI for the audit tab needs verification for completeness.

---

## 7. Duplicate / Overlap Analysis

### D-1: Dashboard Institution Cards ↔ Mesh View

| | |
|--|--|
| Page A | DashboardScreen (Screen 2) — "Institution Status" section |
| Page B | MeshScreen (Screen 5) |
| What overlaps | Both call `getInstitutionOverviews()` and render cards with institution name, available/low/missing counts, status badge, and health progress bar. The visual design is nearly identical. |
| True duplication? | **Yes** — same data, same visual, same purpose |
| Recommendation | **Merge** — Remove Mesh as a standalone sidebar item. Integrate its click-to-expand side panel behavior into the Dashboard institution cards. The Dashboard becomes the single institution overview. |
| Risk if removed | Low — Mesh View adds only the expand/select side panel which can be implemented as a modal or drawer on the Dashboard cards. |
| Migration path | Keep the screen in code initially (hidden from sidebar). Rebuild the expand behavior inside Dashboard cards. Then remove after validation. |

---

### D-2: Dashboard (preview) ↔ Inter-Institution Alerts Screen

| | |
|--|--|
| Page A | DashboardScreen (Screen 2) — "Exchange Alerts" section |
| Page B | InterInstitutionAlertsScreen (Screen 13) |
| What overlaps | Dashboard shows top-3 exchange alerts with priority badges; Screen 13 shows the full filterable list. |
| True duplication? | **No — justified separation.** Dashboard is a summary/preview; Screen 13 is the full management view. |
| Recommendation | **Keep both** but fix the navigation bug: dashboard alert cards should navigate to Screen 13, not Screen 12. |
| Risk if changed | None — it is a one-line fix in DashboardScreen. |

---

### D-3: EditorScreen ↔ InstitutionScreen QuickAvailForm

| | |
|--|--|
| Page A | EditorScreen (Screen 3) |
| Page B | InstitutionScreen (Screen 11) → PortCard → PortAvailabilitySection → QuickAvailForm |
| What overlaps | Both call `upsertAvailability()` to write to `item_availability`. Both allow selecting a port and entering availability data. |
| True duplication? | **Partial.** EditorScreen is a full form with all material fields (scientific name, trade name, dosage form, concentration, price, supply type, national code). QuickAvailForm is a compact form for quick inline entry with item dropdown from `local_items`. |
| Recommendation | **Keep both** — they serve different use cases (dedicated vs. inline). However, the QuickAvailForm's reliance on `local_items` for item selection creates a different data path than EditorScreen's free-text scientific name. Both paths upsert on `(distribution_point_id, scientific_name)` — they should produce consistent records. |
| Risk | Medium — QuickAvailForm resolves `ci.name` as the scientific name from central_items. EditorScreen uses direct user input. If names don't match exactly, two separate records will be created for the same drug. |
| Safer path | Add a "find existing record" lookup to EditorScreen that suggests autocomplete from current `item_availability` scientific names. |

---

### D-4: ReportsScreen ↔ StatusEditorScreen

| | |
|--|--|
| Page A | ReportsScreen (Screen 9) — tabs: Low Stock, Missing |
| Page B | StatusEditorScreen (Screen 16) |
| What overlaps | Both show `item_availability` records for the active organization filtered by condition. Reports has "Low Stock" and "Missing" tabs that show the same data as StatusEditor filtered to those conditions. |
| True duplication? | **Yes — significant overlap.** StatusEditor adds CSV export; Reports adds the Summary and Comparison tabs. |
| Recommendation | **Merge into Reports.** Add CSV export to the Reports screen. Remove StatusEditorScreen from the sidebar or convert it into a tab within Reports. |
| Risk | Low — StatusEditor is a relatively recent addition and its core value (CSV export) can be added to Reports in a P1 task. |
| Migration path | Add CSV export button to Reports. Add "All Materials" tab to Reports using the StatusEditor table. Hide StatusEditor from sidebar. Remove after 2-sprint validation. |

---

### D-5: QrScreen ↔ InstitutionScreen QR Management

| | |
|--|--|
| Page A | QrScreen (Screen 6) — flat list of all org QR tokens |
| Page B | InstitutionScreen (Screen 11) → PortCard → QR actions |
| What overlaps | Both allow revoking/disabling QR tokens. |
| True duplication? | **Partial — different scope.** QrScreen shows ALL QR tokens for an org in a flat list (good for audit). InstitutionScreen manages QR per port with generate/regenerate/revoke in context. |
| Recommendation | **Keep both** but clarify purpose. Rename QrScreen to "QR Audit" (مراجعة رموز QR) and make it clearly a read-only audit view with disable only. Primary QR management (generate/regenerate) stays in InstitutionScreen. |
| Risk if changed | Low — the change is in labeling and scope, not functionality. |

---

### D-6: MobileCommandScreen ↔ DashboardScreen

| | |
|--|--|
| Page A | MobileCommandScreen (Screen 10) |
| Page B | DashboardScreen (Screen 2) |
| What overlaps | Both call `getDashboardMetrics()` and `getInstitutionOverviews()` and display the results. MobileCommandScreen is a narrow layout version of the same data. |
| True duplication? | **Yes.** The Dashboard already has `isMobile` layout checks. MobileCommandScreen duplicates the same data in a simpler view. |
| Recommendation | **Hide from sidebar / merge.** Improve the Dashboard's mobile layout to make MobileCommandScreen unnecessary. |
| Risk | Low — MobileCommandScreen can be kept in code but hidden from the secondary nav. The ring chart SVG is a nice UX element that could be added to the Dashboard mobile view. |

---

### D-7: StatusCenter Exchange Alert Section ↔ InterInstitutionAlertsScreen

| | |
|--|--|
| Page A | StatusCenterScreen (Screen 12) — exchange alerts section at the bottom |
| Page B | InterInstitutionAlertsScreen (Screen 13) |
| What overlaps | StatusCenterScreen shows exchange alerts using `generateExchangeAlerts()`. Screen 13 is the dedicated full view using `getScopedInterInstitutionAlerts()` (which may use the RPC). |
| True duplication? | **Partial** — both show similar data but different quality. StatusCenter uses the simpler client-side `generateExchangeAlerts()`; Screen 13 uses the safer scoped RPC path. |
| Recommendation | **Remove** the exchange alerts section from StatusCenterScreen and replace it with a "See Inter-Institution Alerts →" navigation link to Screen 13. |
| Risk | Low. |

---

## 8. Proposed Navigation Cleanup

This is information architecture only — no code renaming.

| Arabic Label | English Label | Screen # | Section | Action | Reason |
|-------------|--------------|---------|---------|--------|--------|
| لوحة التحكم | Dashboard | 2 | Main | **Keep** | Primary entry point |
| إدارة المؤسسات | Institutions | 11 | Main | **Keep** | Core management |
| مركز المواقف | Status Center | 12 | Main | **Keep** | Manual reporting |
| تنبيهات بين المؤسسات | Inter-Institution Alerts | 13 | Main | **Keep** | Exchange recommendations |
| إدارة المستخدمين | User Management | 14 | Main | **Keep** | User admin |
| محرر التوفر | Availability Editor | 3 | Main | **Keep** | Primary data entry |
| عارض المواد | Material Viewer | 16 | Main | **Rename** then Merge into Reports | Currently named "Status Editor" — misleading |
| سجل العناصر | Item Registry | 4 | Main | **Keep** — add item creation later | Read-only for now |
| عرض الشبكة | Mesh View | 5 | Main | **Hide** → Merge into Dashboard | Duplicate institution cards |
| مركز QR | QR Center | 6 | Main | **Keep** — rename to "QR Audit" | Audit list |
| صحة النظام | System Health | 7 | Main | **Hide until connected to real data** | Currently placeholder |
| التقارير | Reports | 9 | Main | **Keep + expand** | Add CSV + merge StatusEditor |
| حسابي | My Account | 15 | Secondary | **Keep** | User account |
| الإدخال | Intake | 8 | Secondary | **Keep frozen** | Safety requirement |
| العرض المحمول | Mobile View | 10 | Secondary | **Hide** → Improve Dashboard mobile | Duplicate |

---

## 9. Material Alerts — Proposed Operating Model

### Alert Type A: Low Stock / Low Availability

**Trigger:** `item_availability.condition = 'low_stock'` OR `quantity < configured_threshold`  
**Data needed:** `quantity`, `condition`, `organization_id`, `distribution_point_id`, `scientific_name`  
**Severity levels:**
- `Critical`: quantity = 0 but condition = low_stock (contradictory)
- `High`: condition = low_stock AND quantity < 10% of expected stock
- `Medium`: condition = low_stock AND quantity < 30%
- `Info`: condition = low_stock (default)

**Who should see it:** institution_admin, warehouse_manager, point_operator for their org  
**UI location:** Dashboard metric card (already exists as count); Add badge on Institution screen port card; Add banner in EditorScreen  
**Action button:** "Update Availability →" (navigates to EditorScreen or port card)  
**Notification:** Display only (Level 1); Persistent + acknowledgement (Level 2)  
**Visibility:** Internal only — must NOT appear on public QR page

---

### Alert Type B: Out of Stock / Missing Material

**Trigger:** `item_availability.condition = 'missing'` OR `quantity = 0 AND condition = 'available'`  
**Data needed:** `condition`, `quantity`, `organization_id`  
**Severity:** Critical (red)  
**Who should see it:** All staff; monthly_status_officer should be prompted to file a Status Report  
**UI location:** Dashboard metric (exists); Institution screen port card badge; Status Center "attention needed"  
**Action button:** "File Status Report →" (navigates to StatusCenterScreen, pre-fills item)  
**Visibility:** Internal only. Consider whether `missing` items should be hidden from public QR or shown with "غير متوفر"  
**Note:** Current public QR shows `missing` with a red badge — this is correct UX for patients (so they know not to come). Keep this behavior but verify the label is appropriate.

---

### Alert Type C: Near Expiry

**Current state:** `near_expiry` is a MANUAL condition flag set by staff. The `expiry_date` field exists but is NOT used to auto-compute this.

**Proposed auto-trigger:**  
- `Critical (30 days)`: `expiry_date` IS NOT NULL AND `expiry_date <= today + 30 days` AND `condition NOT IN ('expired', 'missing')`  
- `High (60 days)`: `expiry_date <= today + 60 days`  
- `Medium (90 days)`: `expiry_date <= today + 90 days`

**Data needed:** `expiry_date`, `quantity`, `condition`  
**Who should see it:** warehouse_manager, point_operator, monthly_status_officer  
**UI location:** Dashboard near-expiry count (already exists); Near-expiry tab in Reports  
**Action button:** "Mark for redistribution" → creates Status Report with type=near_expiry  
**Visibility:** Show `near_expiry` on public QR (already done). Do NOT show `expiry_date` on public view (privacy risk).  
**Note for no-expiry items:** Items without `expiry_date` must NOT generate expiry alerts. Query must include `expiry_date IS NOT NULL` guard.

---

### Alert Type D: Expired Material

**Proposed auto-trigger:** `expiry_date < today` AND `condition != 'expired'`  
**Data needed:** `expiry_date`, `condition`  
**Severity:** Critical  
**Who should see it:** All internal staff  
**UI location:** Dashboard (add "expired" count alongside near_expiry); Reports Missing tab  
**Action:** Auto-suggest changing condition to 'expired'; remove from public availability view  
**Critical rule:** Expired items must NOT appear as "available" on the public QR page. The RPC must filter out expired items OR map them to a "not available" display. **This is currently NOT verified in code** — the `getPublicQrPayload` RPC behavior for expired items is unknown and must be audited.  
**Visibility:** Internal for the alert; public page should either hide them or show "غير متوفر"

---

### Alert Type E: Excess / Surplus

**Trigger:** `condition = 'surplus'` OR `quantity > configured_max`  
**Data needed:** `condition`, `quantity`, `scientific_name`  
**Severity:** Info / Medium (not dangerous, but opportunity for redistribution)  
**Who should see it:** monthly_status_officer, warehouse_manager, hospital_admin  
**UI location:** Dashboard surplus count (exists); StatusCenterScreen "Add report" pre-filled as surplus  
**Action button:** "Create exchange recommendation →" (files a Status Report type=surplus, which then feeds InterInstitutionAlertsScreen)  
**Visibility:** Internal only for the alert quantity. Public QR can show "surplus" condition as general availability info.

---

### Alert Type F: Stale Data

**No stale-data detection currently exists.**

**Proposed trigger:**  
- `updated_at < now() - interval '7 days'` for any `item_availability` row → **Warning**  
- `updated_at < now() - interval '72 hours'` for active ports → **Stale**  
- `updated_at < now() - interval '24 hours'` for public-facing ports with active QR → **Critical** (public QR data untrustworthy)

**Data needed:** `updated_at`, `distribution_point_id`, existence of active `qr_tokens`  
**Severity:**  
- 24h without update on QR-enabled port: Critical  
- 72h: High  
- 7 days: Medium  
**Who should see it:** point_operator (their ports only), warehouse_manager, hospital_admin  
**UI location:** Port card in InstitutionScreen (badge: "لم يُحدَّث منذ X يوم"); Dashboard port health widget  
**Action button:** "Update availability →" (opens EditorScreen pre-scoped to that port)  
**Visibility:** Internal only. Public QR should show "last_updated" timestamp (already done in PublicQrScreen) so citizens can judge freshness.  
**Note:** This is the most operationally important alert type for a public health system. Stale data on a public-facing QR page is worse than no data.

---

### Alert Type G: Inconsistent Data

**No inconsistency detection currently exists.**

**Examples to detect:**
1. `condition = 'available'` AND `quantity = 0` → Contradictory (quantity implies missing)
2. `condition = 'missing'` AND `quantity > 0` → Contradictory (quantity implies available or low)
3. `condition = 'near_expiry'` AND `expiry_date IS NULL` → Cannot verify — flag for review
4. `expiry_date < today` AND `condition != 'expired'` → Expired but not flagged
5. `condition = 'available'` AND `expiry_date < today` → Expired drug shown as available to public

**Data needed:** `condition`, `quantity`, `expiry_date`  
**Severity:** Case 5 is Critical (public health risk); others are Medium/High  
**Recommendation:** These can be computed as Level 1 frontend alerts with NO migration. A helper function can scan `item_availability` rows and return a list of inconsistency flags.

---

### Alert Type H: QR / Public Access Alerts

**Proposed triggers:**
1. Distribution point `status = 'active'` but no active `qr_tokens` → "Port has no QR"
2. QR token `status = 'active'` but `distribution_point.status = 'archived'` → "QR orphaned"
3. Active QR + active port + 0 items in `item_availability` → "QR active but empty public page"
4. `qr_tokens.status = 'disabled'` but UI shows the URL → Should not happen (code gated)

**Data needed:** `qr_tokens`, `distribution_points`, `item_availability`  
**Severity:** 
- Type 1: Info (port not QR-enabled yet)  
- Type 2: High (orphaned QR — security risk)  
- Type 3: Medium (public page shows nothing)  
**UI location:** InstitutionScreen port card badges; QrScreen audit list; Dashboard (count of "ports without QR")  
**Visibility:** Internal only

---

## 10. Current Alert Implementation Review

### What Currently Exists

| Feature | Location | Status |
|---------|----------|--------|
| Dashboard metric cards (counts) | `DashboardScreen.tsx` + `dashboard.service.ts` | **Existing** — shows available, low_stock, missing, near_expiry, surplus counts. Frontend-computed from DB. |
| Exchange alerts (inter-institution) | `exchange-alerts.ts`, `inter-institution-alerts.service.ts` | **Existing** — computed from `institution_item_status_reports`. Uses RPC when available, falls back to client-side. |
| Exchange alerts preview on Dashboard | `DashboardScreen.tsx` | **Existing** — top-3 recommendations shown. Wrong navigation target (bug). |
| Status reports (manual flags) | `StatusCenterScreen.tsx`, `status-reports.service.ts` | **Existing** — CRUD for manual staff reports. These ARE the trigger for exchange alerts. |
| Low-stock filter in Reports | `ReportsScreen.tsx`, `availability.service.ts::getLowStockItems()` | **Existing** — queries `item_availability` for conditions: low_stock, missing, near_expiry, expired. |
| Near-expiry display on Public QR | `PublicQrScreen.tsx` | **Existing** — shows expiry_date for near_expiry/expired items on public page. |
| Alert acknowledgement | — | **Missing** |
| Persistent alert table | — | **Missing** |
| Auto-expiry detection (from expiry_date) | — | **Missing** |
| Stale data detection (from updated_at) | — | **Missing** |
| Inconsistency detection | — | **Missing** |
| QR health alerts | — | **Missing** |
| Notification system (email/push) | — | **Missing** |

### Database Fields Available for Alert Computation

From `item_availability` (migration 001 + 019 + 020):
- `condition` (available, low_stock, missing, surplus, near_expiry, expired) — MANUAL
- `quantity` — numeric
- `expiry_date` — date, nullable
- `updated_at` — timestamptz
- `organization_id`, `distribution_point_id`
- `scientific_name`, `trade_name`

From `distribution_points`:
- `status` (active, inactive, archived)
- `updated_at`

From `qr_tokens`:
- `status` (active, disabled)
- `last_scanned_at`
- `scan_count`

From `institution_item_status_reports`:
- `status_type` (scarce, surplus, near_expiry, missing)
- `is_active`
- `quantity`, `unit`, `expiry_date`

### Missing Fields for Full Alert System

- `item_availability.threshold_min` — minimum quantity below which "low stock" is triggered automatically
- `item_availability.threshold_max` — maximum quantity above which "surplus" is triggered
- `alerts` table — persistent alert records
- `alert_rules` table — configurable thresholds per org/material
- `alert_acknowledgements` table — user acknowledgements
- `alert_events` table — audit log for alert history

### Current Alert Reliability

| Alert Type | Reliable? | Reason |
|------------|-----------|--------|
| Low stock count | Moderate | Only if staff manually set `condition = 'low_stock'` |
| Missing count | Moderate | Only if staff manually set `condition = 'missing'` |
| Near expiry count | **Low** | Requires manual flag; `expiry_date` not auto-checked |
| Surplus count | Moderate | Manual flag |
| Exchange alerts | Moderate | Computed from manual status reports; no auto-trigger |
| Expired items | **None** | No auto-detection from `expiry_date < today` |
| Stale data | **None** | Not implemented |
| Inconsistencies | **None** | Not implemented |

**Most critical gap:** There is currently no automatic detection that a drug's expiry date has passed. An expired drug can remain marked "available" indefinitely unless a staff member manually changes the condition. This is a **public health risk** if expired drugs appear as "available" on the public QR page.

---

## 11. Recommended Alert Architecture

### Level 1 — Frontend-Computed Alerts (No DB Migration Required)

**What it is:** A pure TypeScript function that takes existing `item_availability` rows and returns a list of alert objects. No new tables. No server-side changes. Can be implemented in a single PR.

**Implementation pattern:**
```typescript
// src/shared/lib/alerts.ts (proposed)
interface ComputedAlert {
  type: 'expired' | 'near_expiry' | 'stale' | 'inconsistent' | 'no_qr' | 'empty_public';
  severity: 'critical' | 'high' | 'medium' | 'info';
  orgId: string;
  portId?: string;
  scientificName?: string;
  message: string;
  messageAr: string;
  updatedAt?: string;
  expiryDate?: string;
}

function computeAlerts(rows: AvailabilityRow[], today: Date): ComputedAlert[]
```

**Alerts computable at Level 1:**
1. Auto-expired: `expiry_date < today && condition != 'expired'` → Critical
2. Auto-near-expiry: `expiry_date <= today+30 && condition == 'available'` → Critical/High
3. Stale data: `updated_at < today - 7d` → Medium/Warning
4. Inconsistency: `condition = 'available' && quantity = 0` → High
5. Inconsistency: `condition = 'missing' && quantity > 0` → Medium
6. Expired shown as available: `expiry_date < today && condition = 'available'` → Critical

**Pros:**
- No migration needed
- Quick to implement
- Works on current data
- No RLS changes

**Cons:**
- Alerts are recomputed every page load (no caching)
- No acknowledgement history
- No persistence (won't remember if acknowledged)
- Requires fetching all availability rows (pagination concern for large orgs)
- Cannot generate server-side notifications

---

### Level 2 — Persistent Alert Engine (Future Migration Required)

**What it is:** A new set of DB tables that store alert records, rules, and acknowledgements, with a scheduled function that evaluates rules.

**New tables (migration ~027+):**
```sql
-- Alert rules: configurable thresholds per org/material
create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  scientific_name text,                          -- null = applies to all
  threshold_low integer,                         -- qty below this = low stock
  threshold_max integer,                         -- qty above this = surplus
  expiry_warn_days_1 integer default 30,         -- critical
  expiry_warn_days_2 integer default 60,         -- high
  expiry_warn_days_3 integer default 90,         -- medium
  stale_hours_critical integer default 24,
  stale_hours_warning integer default 72,
  stale_days_medium integer default 7,
  created_at timestamptz default now()
);

-- Persistent alert records
create table alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  distribution_point_id uuid references distribution_points(id),
  availability_id uuid references item_availability(id),
  alert_type text not null,                      -- 'expired', 'near_expiry', 'low_stock', etc.
  severity text not null,                         -- 'critical', 'high', 'medium', 'info'
  status text not null default 'active',          -- 'active', 'acknowledged', 'resolved', 'suppressed'
  scientific_name text,
  details jsonb,
  triggered_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by text default 'system'               -- 'system' or user_id
);

-- User acknowledgements
create table alert_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references alerts(id),
  profile_id uuid not null references profiles(id),
  acknowledged_at timestamptz not null default now(),
  note text
);
```

**Supabase Edge Function (proposed `check-alerts` function):**
- Runs on a schedule (e.g., daily or hourly)
- Scans `item_availability` for expired items, near-expiry, stale data
- Creates records in `alerts` table
- Resolves alerts when condition clears

**Pros:**
- Full persistence and history
- User acknowledgements with audit trail
- Can send notifications (in-app badges, email, Telegram/WhatsApp later)
- Configurable thresholds per org/material
- Supports escalation rules

**Cons:**
- Requires new migration
- Requires Edge Function deployment (currently prohibited until explicitly approved)
- More complex RLS needed for `alerts` and `alert_rules`
- Needs careful RLS — alert records may contain info from other institutions (for inter-institution alerts)

**Recommendation:** Implement Level 1 first. Design data structures for Level 2 in parallel. Deploy Level 2 in a dedicated phase after Level 1 is validated in production.

---

## 12. Comprehensive Improvement Roadmap

### P0 — Safety / Correctness

| ID | Problem | Solution | Pages | Risk | Difficulty | Requires |
|----|---------|----------|-------|------|-----------|---------|
| P0-1 | Expired drugs may appear as "available" on public QR page | Audit `get_public_qr_payload` RPC to ensure it excludes `condition='expired'` and `expiry_date < today` rows | PublicQrScreen | **Critical — public health** | Low | RPC/backend review |
| P0-2 | Dashboard exchange-alert cards navigate to wrong screen (12 vs 13) | Change `onNavigate(12)` to `onNavigate(13)` in DashboardScreen exchange alert cards | DashboardScreen | Low | **Very Low** | Frontend only |
| P0-3 | System Health screen shows fake data | Mark HealthScreen as "Demo / Disconnected" or connect to real data | HealthScreen | Medium (misleads operators) | Medium | Backend/real data source |
| P0-4 | No auto-detection of expired materials | Implement Level 1 computed alerts from `expiry_date` | Dashboard, Institution, Reports | High | Medium | Frontend only |
| P0-5 | Batch number, price, supply_type exposed risk on public QR | Verify RPC excludes these fields | PublicQrScreen | High | Low | RLS/RPC review |
| P0-6 | QuickAvailForm (InstitutionScreen) vs EditorScreen may create duplicate availability records with different keys | Add deduplication warning or lookup by scientific name | InstitutionScreen, EditorScreen | Medium | Medium | Frontend only |

---

### P1 — UX

| ID | Problem | Solution | Pages | Risk | Difficulty | Requires |
|----|---------|----------|-------|------|-----------|---------|
| P1-1 | StatusEditorScreen is misleadingly named (not an editor) | Rename to "Material Viewer" / "عارض المواد" | StatusEditorScreen | Low | Low | Frontend only |
| P1-2 | Mesh View duplicates Dashboard institution cards | Merge Mesh behavior into Dashboard; hide Mesh from sidebar | MeshScreen, DashboardScreen | Low | Low | Frontend only |
| P1-3 | MobileCommandScreen duplicates Dashboard | Improve Dashboard mobile layout; hide MobileCommandScreen | MobileCommandScreen, DashboardScreen | Low | Medium | Frontend only |
| P1-4 | Reports and StatusEditorScreen overlap | Add CSV export to Reports; merge StatusEditor as a tab | ReportsScreen, StatusEditorScreen | Low | Medium | Frontend only |
| P1-5 | No language toggle visible in main app sidebar | Add AR/EN toggle to sidebar or topbar | PhoenixSidebar, PhoenixTopbar | Low | Very Low | Frontend only |
| P1-6 | StatusCenter shows exchange alerts that duplicate InterInstitutionAlertsScreen | Remove exchange alerts section from StatusCenter; add link to Screen 13 | StatusCenterScreen | Low | Very Low | Frontend only |
| P1-7 | Empty states could be more actionable | Replace generic "لا توجد بيانات" with context-specific action prompts | All screens | Low | Low | Frontend only |
| P1-8 | InstitutionScreen is a mega-screen with very long scroll | Add tab navigation within OrgDetailView (Users / Ports / Availability / Cleanup) | InstitutionScreen | Low | Medium | Frontend only |
| P1-9 | Port creation only accepts a name (type always 'dispensing') | Add port type dropdown to AddPortForm | InstitutionScreen | Low | Low | Frontend only |

---

### P2 — Operations

| ID | Problem | Solution | Pages | Risk | Difficulty | Requires |
|----|---------|----------|-------|------|-----------|---------|
| P2-1 | No visual indication of stale data (last update > 24h) | Add "last updated" badge on port cards and availability rows | InstitutionScreen, EditorScreen | Low | Low | Frontend only (updated_at exists) |
| P2-2 | Dashboard lacks "ports without QR" count | Add metric card for active ports with no QR | DashboardScreen | Low | Low | Frontend (cross-join query) |
| P2-3 | No expiry calendar or timeline view | Add near-expiry timeline in Reports | ReportsScreen | Low | Medium | Frontend only |
| P2-4 | No redistribution suggestion UI | Add "Create exchange report" button on surplus/near_expiry availability rows | InstitutionScreen, StatusEditorScreen | Low | Medium | Frontend + StatusCenter |
| P2-5 | No institution health score | Compute health score (available% × recency score) for each institution | DashboardScreen, MeshScreen | Low | Medium | Frontend only |
| P2-6 | Reports has no PDF or print export | Add print/PDF export to Reports | ReportsScreen | Low | Medium | Frontend only |

---

### P3 — Governance

| ID | Problem | Solution | Pages | Risk | Difficulty | Requires |
|----|---------|----------|-------|------|-----------|---------|
| P3-1 | No acknowledgement for alerts | Implement acknowledgement in Level 1 (local session state) or Level 2 (DB) | Dashboard, Institution | Low | High | Level 2 migration |
| P3-2 | No change history per material | Add `item_availability_history` table or use audit_log | Reports, EditorScreen | Medium | High | Migration + RLS |
| P3-3 | Permission presets (role templates) | Add preset button groups in UserManagementScreen | UserManagementScreen | Low | Medium | Frontend only |
| P3-4 | User cannot see their own effective permissions | Add "My Permissions" view in MyAccountScreen | MyAccountScreen | Low | Low | Frontend only |
| P3-5 | No approval workflow for dangerous edits | Add a "request review" state for org-archive/user-delete | InstitutionScreen, UserManagementScreen | Low | High | Migration + workflow |

---

### P4 — Scalability

| ID | Problem | Solution | Pages | Risk | Difficulty | Requires |
|----|---------|----------|-------|------|-----------|---------|
| P4-1 | Dashboard fetches ALL `item_availability` rows for counts | Replace with aggregate SQL query or RPC | DashboardScreen, dashboard.service.ts | Medium (grows with data) | Low | Backend RPC |
| P4-2 | No pagination on Reports / StatusEditorScreen lists | Add cursor pagination | ReportsScreen, StatusEditorScreen | Low | Medium | Frontend + query |
| P4-3 | `getInstitutionOverviews()` double-fetches | Cache at AppContext level with TTL | All screens using this | Low | Low | Frontend only |
| P4-4 | Public QR page has no caching | Add HTTP cache headers in RPC or CDN-level caching | PublicQrScreen | Medium | Medium | Backend/RPC |
| P4-5 | Missing DB indexes on `item_availability.condition` | Add index on `(organization_id, condition)` | Backend | Low | Very Low | Migration |

---

## 13. Risks and Open Questions

| # | Risk | Severity | Status |
|---|------|----------|--------|
| R-1 | `get_public_qr_payload` RPC may expose sensitive fields (batch_number, price, supply_type, notes) | Critical | Open — requires RPC code review |
| R-2 | Expired drugs (`expiry_date < today`) may appear as "available" on public QR | Critical | Open — requires RPC audit |
| R-3 | System Health screen shows hardcoded data — operators may rely on it | High | Open — needs label or real data connection |
| R-4 | Dashboard exchange-alert navigation bug (goes to Screen 12 not 13) | Medium | Confirmed — trivial fix |
| R-5 | QuickAvailForm and EditorScreen may create duplicate records for the same drug | Medium | Open — needs scientific name normalization |
| R-6 | `near_expiry` condition is manual-only — auto-expiry detection absent | High | Open — Level 1 alert required |
| R-7 | Stale public QR data — no staleness check or warning | High | Open — Level 1 alert required |
| R-8 | User permissions cached in AppContext may diverge from DB | Low | Partially handled by `reloadMyPermissions()` |
| R-9 | npm audit shows 1 high + 1 critical vulnerability in dependencies | High | Open — do not force-fix without review |
| R-10 | `organizations.archived` status: migration 001 only has `active/inactive/suspended` check constraint, but status_reports and other places reference `archived` | Medium | Needs schema verification |

**Open Questions:**

1. Should `expired` items be hidden from the public QR page entirely, or shown as "غير متوفر" (unavailable)?
2. Should stale data (e.g., not updated in 24h) trigger an automatic `status = 'inactive'` for the public display?
3. Which migration exactly removed the mandatory `warehouse_id` from `distribution_points`? (The form hardcodes 'dispensing' type and the AddPortForm creates without warehouse selection — but migration 001 shows `warehouse_id NOT NULL`. Migration 021 likely changed this.)
4. Is there an Edge Function for scheduled alert checking already planned, or will Level 1 frontend-only alerts serve production for the foreseeable future?

---

## 14. Recommended Next Implementation Phases

**Phase 1 (Immediate — 1-2 days):**
- Fix navigation bug: Dashboard exchange alerts → Screen 13 (P0-2)
- Mark HealthScreen as "Demo / Disconnected" clearly (P0-3 partial)
- Add AR/EN language toggle to sidebar (P1-5)

**Next Phase — AVAILABILITY-PUBLIC-RLS-PRIVACY-HARDENING-A:**
- Audit `get_public_qr_payload` RPC (P0-1, P0-5)
- Verify expired materials are not shown as available on public QR (P0-4 partial)
- Add `updated_at` staleness warning to public QR footer

**Then — MATERIAL-ALERTS-FRONTEND-COMPUTED-MVP-A:**
- Implement Level 1 computed alerts (P0-4 full)
- Auto-detect: expired, near-expiry, stale, inconsistent
- Show alert badges on InstitutionScreen port cards
- Show alert count in Dashboard header
- No migration required

**Then — REPORTS-STATUS-EDITOR-MERGE-A:**
- Merge StatusEditorScreen into Reports as a tab (P1-4)
- Add CSV export to Reports
- Hide StatusEditorScreen from sidebar (P1-1)

**Then — MESH-MOBILE-DEDUP-A:**
- Hide MeshScreen and MobileCommandScreen from sidebar (P1-2, P1-3)
- Integrate Mesh click-to-expand into Dashboard institution cards
- Improve Dashboard mobile layout

**Later — LEVEL-2-ALERT-ENGINE-A:**
- Migrations for `alerts`, `alert_rules`, `alert_acknowledgements`
- Edge Function for scheduled alert evaluation
- In-app alert notification center

---

## 15. Final Summary Table

| Screen / Feature | Keep Now | Merge Later | Hide Now | Remove After Replacement | Needs Future Migration | Needs RLS/Privacy Review |
|-----------------|----------|-------------|----------|--------------------------|----------------------|--------------------------|
| Dashboard (Screen 2) | ✅ | — | — | — | — | — |
| Availability Editor (Screen 3) | ✅ | — | — | — | — | — |
| Item Registry (Screen 4) | ✅ | — | — | — | — | — |
| Mesh View (Screen 5) | — | ✅ → Dashboard | ✅ | ✅ | — | — |
| QR Center (Screen 6) | ✅ (rename to QR Audit) | — | — | — | — | — |
| System Health (Screen 7) | — | — | ✅ (until real data) | — | — | — |
| Intake Frozen (Screen 8) | ✅ | — | — | — | — | — |
| Reports (Screen 9) | ✅ | Absorb StatusEditor | — | — | — | — |
| Mobile View (Screen 10) | — | ✅ → Dashboard | ✅ | ✅ | — | — |
| Institutions (Screen 11) | ✅ | — | — | — | — | ✅ (port availability privacy) |
| Status Center (Screen 12) | ✅ | — | — | — | — | — |
| Inter-Institution Alerts (Screen 13) | ✅ | — | — | — | — | ✅ (cross-org data exposure) |
| User Management (Screen 14) | ✅ | — | — | — | — | ✅ (permission grant enforcement) |
| My Account (Screen 15) | ✅ | — | — | — | — | — |
| Status Editor (Screen 16) | — | ✅ → Reports | ✅ | ✅ | — | — |
| Public QR (/?qid=) | ✅ | — | — | — | — | ✅ **Critical** (expired items, sensitive fields) |
| Login / Reset Password | ✅ | — | — | — | — | — |
| Level 1 Computed Alerts | Recommended | — | — | — | — (frontend only) | — |
| Level 2 Persistent Alert Engine | — | — | — | — | ✅ (alerts tables + Edge Function) | ✅ |

---

## Final Summary

**document_created:**
- Path: `docs/PAGE_TASK_MAP_DUPLICATES_AND_MATERIAL_ALERTS_AUDIT.md`
- Sections: 15 major sections, 14 sub-phases
- Pages/routes mapped: 18 screens + 3 auth states
- Duplicate/overlap candidates identified: 7 pairs (D-1 through D-7)
- Alert types documented: 8 types (A through H), each with trigger, severity, visibility, and action

**key_findings:**
- **Most important duplicate:** MeshScreen (5) duplicates Dashboard institution cards — safe to hide and merge
- **Most urgent navigation bug:** Dashboard exchange-alert cards navigate to Screen 12 (Status Center) instead of Screen 13 (Inter-Institution Alerts)
- **Highest-risk missing alert behavior:** No auto-detection of expired materials from `expiry_date` field — expired drugs may appear "available" on public QR pages
- **Highest-priority UX improvement:** Merge StatusEditorScreen into Reports; rename HealthScreen as demo/disconnected
- **Highest-priority privacy concern:** `get_public_qr_payload` RPC must be audited to confirm it excludes `batch_number`, `price`, `supply_type`, `notes`, and expired items

**recommendations_summary:**
- Keep: Dashboard, Editor, Registry, QR Center, Health (once real), Intake (frozen), Reports (expanded), Institutions, Status Center, Inter-Institution Alerts, User Management, My Account
- Merge: Mesh → Dashboard, Mobile → Dashboard, StatusEditor → Reports
- Hide now: MeshScreen (sidebar), MobileCommandScreen (secondary nav), HealthScreen (until real data), StatusEditorScreen (after merge)
- Remove after replacement: Mesh, Mobile, StatusEditor (after merge validated)
- Future migration needed: Level 2 alert engine (alerts + alert_rules + alert_acknowledgements tables + scheduled Edge Function)
- Frontend-only quick wins: P0-2 (nav bug fix), P0-4 (expiry alerts), P1-5 (language toggle), P1-6 (remove alerts from Status Center), P2-1 (stale badge)

**security_result:**
- No code behavior changed ✅
- No SQL executed ✅
- No migration created ✅
- No RLS change ✅
- No permission weakening ✅
- No service_role exposure ✅
- No auth.admin frontend call ✅
- Data Reset remains absent ✅
- Intake/OCR/Excel/DocIntel remain disabled ✅

**verification:**
- Tests: ✅ 1812 passed
- Lint: ✅ 0 errors
- Build: ✅ 2.23s
- Audit: ⚠ 5 vulnerabilities (not fixed — prohibited)

**manual_next_steps:**
1. Review `docs/PAGE_TASK_MAP_DUPLICATES_AND_MATERIAL_ALERTS_AUDIT.md`
2. Decide which duplicate pages to merge (start with D-1 Mesh and D-4 StatusEditor)
3. Choose alert implementation level:
   - **Level 1** — Frontend/computed alerts (no migration, quick wins)
   - **Level 2** — Persistent alert engine (migration + Edge Function required)
4. Suggested next phases in order:
   - `AVAILABILITY-PUBLIC-RLS-PRIVACY-HARDENING-A` — audit RPC for expired/sensitive data
   - `MATERIAL-ALERTS-FRONTEND-COMPUTED-MVP-A` — Level 1 alerts from expiry_date
