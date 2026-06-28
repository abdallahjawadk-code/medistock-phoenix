# SIMPLE-CORE-AUDIT-A — MediStock-Babil Phoenix V2

**Date:** 2026-06-28
**Project:** medistock-phoenix (abdallahjawadk-code/medistock-phoenix)
**Branch:** master
**Status:** Clean working tree

---

## 1. Current Mapping

### 1.1 Institutions / Users / Roles / Permissions — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **Organizations table** | Exists | `organizations` — name, name_ar, code, status, city. RLS: super_admin reads all; others read own org. |
| **Profiles table** | Exists | `profiles` — links to auth.users, stores role + organization_id. Auto-created on signup via trigger. |
| **Roles** | Exists | 5 roles: `super_admin`, `hospital_admin`, `warehouse_manager`, `point_operator`, `viewer`. Enforced in DB CHECK + RLS. |
| **RLS permissions** | Exists | Full role matrix in migration 002. super_admin = global, hospital_admin = own org, warehouse_manager = own org (write warehouses + availability), point_operator = update availability only, viewer = read-only. |
| **Auth** | Exists | Supabase Auth with email/password. `auth.service.ts` uses `signInWithPassword`. No service_role in frontend. Password reset with dynamic redirect. |
| **Org scope switching** | Exists | `AppContext.tsx` — super_admin can switch `activeOrgId`; others are pinned. `PhoenixOrgScope` UI component. |
| **Hierarchy** | Partial | Flat hierarchy: organizations → warehouses → distribution_points. No parent-child between organizations (no sub-institutions). |

**Gap:** No multi-level institution hierarchy (e.g. province → hospital → department). Currently single-level organizations only.

### 1.2 Ports / Points — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **Distribution points table** | Exists | `distribution_points` — name, name_ar, point_type (dispensing/storage/returns/emergency), linked to warehouse + organization. |
| **Warehouses table** | Exists | `warehouses` — name, name_ar, location_notes, linked to organization. Soft-archive supported. |
| **Services** | Exists | `warehouses.service.ts` — `getPointsByOrg()` returns all points for an org. |

**Note:** "Ports" in the requirements maps to `distribution_points` in the schema. The hierarchy is: Organization → Warehouse → Distribution Point.

### 1.3 QR Generation / Public Page — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **QR targets table** | Exists | `qr_targets` — polymorphic target (warehouse / distribution_point / local_item). |
| **QR tokens table** | Exists | `qr_tokens` — hash-only storage, public_id for URLs, scan count, active/disabled/rotated status. One active per target. |
| **Create QR RPC** | Exists | `create_qr_for_target()` — idempotent, role-gated, audited. |
| **Disable QR RPC** | Exists | `disable_qr_token()` — never touches parent entity. |
| **Public QR payload RPC** | Exists | `get_public_qr_payload()` — anon-safe, returns items for scanned point. |
| **QR Screen (admin)** | Exists | `QrScreen.tsx` — lists tokens by org, disable button, public URL display. |
| **Public QR Screen** | Exists | `PublicQrScreen.tsx` — anon route via `?qid=`, bilingual, shows availability. |
| **QR service** | Exists | `qr.service.ts` — wraps the 3 RPCs. No raw deletes. |

**Gap:** QR is NOT auto-created when a distribution point is created. Currently requires manual creation via admin.

### 1.4 Port Availability — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **Item availability table** | Exists | `item_availability` — per local_item per distribution_point. Quantity, condition (available/low_stock/missing/surplus/near_expiry/expired), batch_number, expiry_date. |
| **Central items table** | Exists | `central_items` — master drug list. name, name_ar, barcode, unit, category. Super_admin write only. |
| **Local items table** | Exists | `local_items` — hospital-level customization referencing central items. local_name, local_code. |
| **Availability service** | Exists | `availability.service.ts` — `getAvailabilityByPoint()`, `upsertAvailability()`, `getLowStockItems()`. |
| **Editor screen** | Exists | `EditorScreen.tsx` — manual availability upsert with confirmation dialog. Org-scoped. |

### 1.5 Central Shortage / Surplus / Missing / Near-Expiry Center — PARTIAL

| Layer | Status | Details |
|-------|--------|---------|
| **Data foundation** | Exists | `item_availability.condition` stores all states. Dashboard metrics aggregate them. |
| **Dashboard metrics** | Exists | `getDashboardMetrics()` counts available/low_stock/missing/near_expiry across org. |
| **Reports screen** | Exists | `ReportsScreen.tsx` — tabs for summary, low stock, missing, comparison, audit. Uses `getLowStockItems()`. |
| **Dedicated center page** | MISSING | No standalone shortage/surplus center page. Data is spread across dashboard metrics and reports tabs. |

**Gap:** No dedicated, independent "Central Status Center" that aggregates shortage/surplus/missing/near-expiry across ALL organizations in one unified view. The current dashboard shows per-org data; the reports screen is also org-scoped. A super_admin cross-org status center is missing.

### 1.6 Exchange Alerts — MISSING

| Layer | Status | Details |
|-------|--------|---------|
| **Exchange alerts table** | Missing | No table for tracking exchange proposals or alerts between institutions. |
| **Alert logic** | Missing | No rule-based logic to detect when one institution has surplus and another has shortage of the same item. |
| **Alert UI** | Missing | No exchange/transfer alert screen or notification system. |
| **Transfer tracking** | Missing | No transfer or exchange table to record actual movement between institutions. |

### 1.7 Dashboards — EXISTS (partial)

| Layer | Status | Details |
|-------|--------|---------|
| **Central dashboard** | Exists | `DashboardScreen.tsx` — metrics, institution overview cards, quick actions. |
| **Institution dashboard** | Partial | Org-scoped data visible via `activeOrgId` filter, but no dedicated per-institution dashboard page. |
| **Mesh view** | Exists | `MeshScreen.tsx` — shows all institutions with availability pct bars. |

**Gap:** No dedicated secondary institution dashboard that a hospital_admin sees with their own institution's full detail (warehouses, points, items, availability). Currently they see the same dashboard filtered by their org.

### 1.8 Bilingual UI / Content Support — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **i18n system** | Exists | `strings.ts` — 140+ keys with ar/en pairs. `t(key, lang)` function. |
| **Language toggle** | Exists | `AppContext.tsx` — `toggleLang()`, persists in state. |
| **Bilingual data** | Exists | All entities have `name` + `name_ar` fields (organizations, warehouses, distribution_points, central_items). |
| **Schema fields** | Exists | `name_ar` on all entity tables. Public QR payload returns both `org_name` and `org_name_ar`. |
| **Empty/loading/error states** | Exists | All bilingual via `t()` calls. |

### 1.9 RTL / LTR Support — EXISTS

| Layer | Status | Details |
|-------|--------|---------|
| **Direction management** | Exists | `AppContext.tsx` sets `dir` on `<html>` and `<body>`. `direction.ts` utility. |
| **CSS** | Exists | `global.css` handles RTL/LTR. |
| **Technical identifiers** | Partial | QR URLs use `dir="ltr"` in QrScreen. Batch number input uses `dir="ltr"`. But not all technical fields are explicitly guarded. |
| **Tests** | Exists | `direction.test.ts` tests the direction utility. |

**Gap:** Some technical identifiers (UUIDs, barcodes, local_codes) displayed in UI may need explicit `dir="ltr"` or `<bdi>` tags to prevent RTL reordering. The IntakeFrozenScreen hardcodes bilingual text but uses proper `dir="rtl"` / `dir="ltr"` attributes.

### 1.10 Search — PARTIAL

| Layer | Status | Details |
|-------|--------|---------|
| **DB indexes** | Exists | `pg_trgm` trigram indexes on `central_items.name` and `central_items.name_ar` for fuzzy search. |
| **Frontend search** | Minimal | `RegistryScreen.tsx` has a search input, but search behavior for Arabic/English mixed content is not deeply implemented. |

---

## 2. Disabled Modules (MUST STAY DISABLED)

| Module | Status | Location |
|--------|--------|----------|
| **Intake** | Frozen | `IntakeFrozenScreen.tsx` — explicitly disabled, shows blocked workflows. |
| **Excel Import** | Blocked | Listed in IntakeFrozenScreen BLOCKED array. |
| **OCR Scan** | Blocked | Listed in IntakeFrozenScreen BLOCKED array. |
| **CSV Upload** | Blocked | Listed in IntakeFrozenScreen BLOCKED array. |
| **Doc Intelligence** | Blocked | Listed in IntakeFrozenScreen BLOCKED array. |
| **Smart Intake** | Blocked | Listed in IntakeFrozenScreen BLOCKED array. |
| **Data Reset Center** | No code | Guardrail tests verify no DataReset imports. No restore allowed. |

The guardrail test suite (`phoenix-guardrails.test.ts`, 15 test groups) enforces:
- No service_role in frontend
- No raw `.delete()` calls
- No old project imports (DataReset, OCR, DocIntel, Excel)
- No dangerous scripts in package.json
- Intake stays frozen
- QR lifecycle is RPC-only
- Purge safety (super_admin only, confirmation required, QR-first deletion order)

---

## 3. Reuse — Files/Pages/RPCs/Tables to Keep

### Tables (all 10, keep as-is)
- `organizations` — maps to "institutions"
- `profiles` — users + roles
- `warehouses` — intermediate grouping under institutions
- `distribution_points` — maps to "ports/points"
- `central_items` — master drug list
- `local_items` — hospital-level item customization
- `item_availability` — per-point availability (core operational table)
- `qr_targets` + `qr_tokens` — QR lifecycle
- `audit_logs` — append-only audit trail

### RPCs (all 6, keep as-is)
- `get_public_qr_payload` — public QR scan
- `create_qr_for_target` — create QR
- `disable_qr_token` — disable QR
- `archive_entity` — soft-archive
- `get_entity_purge_impact` — purge preview
- `purge_entity_with_all_data` — hard purge (super_admin)

### Frontend pages (keep all)
- `DashboardScreen` — central dashboard
- `EditorScreen` — availability editor
- `RegistryScreen` — item registry
- `MeshScreen` — institution mesh view
- `QrScreen` — QR admin center
- `PublicQrScreen` — public QR page
- `HealthScreen` — system health
- `IntakeFrozenScreen` — frozen module display
- `ReportsScreen` — reports and audit log
- `LoginScreen` / `ResetPasswordScreen` — auth
- `MobileCommandScreen` — mobile optimized view

### Services (keep all)
- `auth.service.ts`, `dashboard.service.ts`, `availability.service.ts`
- `qr.service.ts`, `organizations.service.ts`, `registry.service.ts`
- `warehouses.service.ts`, `lifecycle.service.ts`, `audit.service.ts`

### UI components (keep all 15+ Phoenix* components)

---

## 4. Avoid — Risky Paths

| Risk | Details |
|------|---------|
| **Legacy project** | `medistock-qr-network` — do NOT deploy, do NOT import from. |
| **Intake re-enable** | Excel/OCR/DocIntel/CSV workflows — stay frozen. |
| **Data Reset restore** | No code exists; must not be re-created. |
| **service_role in frontend** | Enforced by guardrail tests. |
| **Raw .delete() in frontend** | Enforced by guardrail tests; use RPCs only. |
| **npx supabase db push** | Prohibited. All SQL applied manually via SQL Editor. |
| **npm audit fix --force** | Prohibited. |
| **Duplicated QR logic** | All QR operations go through 3 RPCs. No parallel path. |
| **Hardcoded institution codes** | `types.ts` has hardcoded `'marjan' | 'hilla' | 'babil' | 'mahawil'` in Institution interface — this is from demo data and should not be relied upon for real institutions. |

---

## 5. Recommended Next Phase

**Recommendation: A. INSTITUTION-HIERARCHY-A**

**Rationale:**
1. The institution/organization layer is the foundation for everything else. Ports, availability, QR, dashboards, and exchange alerts all depend on a clean institution model.
2. Currently the `Institution` TypeScript interface in `types.ts` has hardcoded codes (`marjan`, `hilla`, `babil`, `mahawil`) that don't match the actual DB schema (which uses dynamic UUIDs). This mismatch needs cleanup.
3. The `organizations` table exists but the concept of "secondary institution dashboards" requires proper per-institution views.
4. User/role management UI doesn't exist yet — profiles are created via DB trigger but there's no admin screen to manage users, assign roles, or assign users to organizations.
5. Once institutions + users + roles are solid, the remaining phases (ports, availability, QR auto-gen, central status, exchange alerts) can build on a stable foundation.

**Alternative consideration:** If QR auto-generation is the highest-priority feature, **B. PORT-QR-LIFECYCLE-A** would be a valid choice since the QR infrastructure already exists and only needs the auto-create-on-point-creation trigger.

---

## Verification

```
project_verification: medistock-phoenix / abdallahjawadk-code / master / clean
what_changed: no code changes (audit only)
bilingual_result: 140+ i18n keys, all entities have name + name_ar, public QR bilingual
rtl_ltr_result: AppContext manages dir on html/body, direction.ts utility, some technical fields use dir="ltr"
verification: no gates run (audit phase — no code changes)
remaining_risks_if_any:
  - types.ts Institution interface has hardcoded institution codes (should be dynamic)
  - No user/role management admin UI
  - QR not auto-created on point creation
  - No central cross-org status center
  - No exchange alerts infrastructure
  - Some technical identifiers may need dir="ltr" guards
rollback: N/A (no changes made)
```
