# Duplicate Pages Navigation Cleanup

**Phase**: DUPLICATE-PAGES-NAVIGATION-CLEANUP-A  
**Scope**: Frontend navigation only — no SQL, no migrations, no RLS changes, no service_role usage.

---

## Problem

The sidebar, mobile bottom nav, and mobile drawer contained three pages that were either
duplicate views of existing screens or unfilled placeholder screens:

| Screen | Label | Reason to hide |
|--------|-------|----------------|
| 5 | Mesh View | Functional duplicate of Dashboard (screen 2) |
| 7 | System Health | Placeholder with fake data; no production content |
| 10 | Mobile View | Duplicate of Dashboard mobile layout (screen 2) |

Additionally, the Status Center (screen 12) contained a built-in `ExchangeAlertsSection`
component that duplicated the dedicated Inter-Institution Alerts screen (screen 13). That
section used a simpler client-side `generateExchangeAlerts()` engine, less capable than the
RPC-backed screen 13 engine.

The QR screen (screen 6) label was generic ("QR Center") and did not communicate its actual
purpose: auditing active/disabled QR tokens and monitoring scan usage.

---

## Changes

### 1. Sidebar (`PhoenixSidebar.tsx`)

- **Removed** screen 5 (Mesh View) from `NAV_ITEMS`
- **Removed** screen 7 (System Health) from `NAV_ITEMS`
- **Updated** screen 6 label: `nav_qr` → `nav_qr_audit` ("QR Audit Center")
- **Removed** screen 10 (Mobile View) from `SECONDARY_ITEMS`

Screens 5, 7, and 10 remain routable (App.tsx switch still maps them) but are no longer
surfaced in navigation. Deep-linking via `setScreen(n)` still works if needed.

### 2. Mobile Bottom Nav (`PhoenixMobileBottomNav.tsx`)

Replaced the two hidden screens in the bottom nav with useful screens:

| Old | New |
|-----|-----|
| Screen 5 — Mesh View | Screen 11 — Institutions |
| Screen 7 — System Health | Screen 13 — Inter-Institution Alerts |

### 3. Mobile Drawer (`PhoenixMobileDrawer.tsx`)

- **Removed** screen 5 (Mesh View) from `ALL_NAV`
- **Removed** screen 7 (System Health) from `ALL_NAV`
- **Removed** screen 10 (Mobile View) from `ALL_NAV`
- **Updated** screen 6 label: `nav_qr` → `nav_qr_audit`

### 4. Status Center (`StatusCenterScreen.tsx`)

- **Removed** `ExchangeAlertsSection` component and its helpers
  (`PRIORITY_VARIANT`, `PRIORITY_LABEL_KEY`, `alertItemName`, `alertOrgName`)
- **Removed** import of `generateExchangeAlerts` / `ExchangeAlert` / `AlertPriority`
- **Added** `onNavigate` prop to `StatusCenterScreen`
- **Added** Material Exchange Command Center CTA card pointing to screen 13

The CTA card is always visible (not gated on report count), ensuring users can always
navigate to the dedicated exchange screen regardless of current report state.

### 5. App.tsx

- Passed `onNavigate={setScreen}` prop to `<StatusCenterScreen />`

### 6. QR Screen (`QrScreen.tsx`)

- Title: `t('nav_qr', lang)` → `t('nav_qr_audit', lang)` → "QR Audit Center" / "مركز تدقيق QR"
- Subtitle: `t('qr_sub', lang)` → `t('qr_audit_center_subtitle', lang)` → "Monitor active/disabled QR codes and usage"

### 7. i18n (`strings.ts`)

Five new keys added:

| Key | AR | EN |
|-----|----|----|
| `nav_qr_audit` | مركز تدقيق QR | QR Audit Center |
| `qr_audit_center_subtitle` | مراقبة رموز QR النشطة والمعطلة ومتابعة استخدامها | Monitor active/disabled QR codes and usage |
| `material_exchange_center` | مركز تبادل المواد | Material Exchange Command Center |
| `open_exchange_center` | فتح مركز تبادل المواد | Open Exchange Center |
| `duplicate_exchange_moved_notice` | تنبيهات التبادل بين المؤسسات أصبحت متوفرة في مركز تبادل المواد | Inter-institution exchange alerts are now managed in the Material Exchange Command Center |

Existing keys `nav_qr`, `qr_sub`, `nav_mesh`, `nav_health`, `nav_mobile` are retained
(used by hidden screens that remain routable) — no deletions.

---

## Tests Updated

File: `src/features/status/__tests__/exchange-alerts.test.ts`

Updated test `'screen shows manual action required'` → `'screen has CTA to exchange center (screen 13) instead of inline alerts'`:
- Asserts `onNavigate(13)` is present in screen source
- Asserts `material_exchange_center` i18n key is used
- Asserts `generateExchangeAlerts` is NOT present (client-side engine removed)

Total: **1988 tests passing** (unchanged count — one test updated, none added or deleted).

---

## What Was NOT Changed

- Screen routing in `App.tsx` for screens 5, 7, 10 — still routable, just not surfaced in nav
- `PhoenixAppShell.tsx` screen-to-label map — unchanged (preserves breadcrumb labels)
- `nav_qr` i18n key — kept (screen 5 uses it; public QR also uses nav keys)
- `qr_sub` i18n key — kept (may be used elsewhere)
- `exchange-alerts.ts` engine file — kept (used by screen 13 / InterInstitutionAlertsScreen)
- No SQL, no migrations, no RLS policies, no Supabase Edge Functions
- No backend changes of any kind

---

## Verification Commands

```bash
npm test -- --run          # 1988 tests, all pass
npm run lint               # 0 warnings
npm run build              # clean production build
npm audit --audit-level=high  # pre-existing vulnerabilities only (no new ones)
```
