# Smart Material Alerts & Material Exchange Command Center

**Task:** SMART-MATERIAL-ALERTS-AND-INTERINSTITUTION-UX-LEAP-A  
**Date:** 2026-06-30  
**Scope:** Frontend / computed MVP — no SQL, no migrations, no DB writes

---

## 1. Overview

This task delivers a "Material Intelligence" layer that computes smart alerts and
inter-institution exchange suggestions directly from existing `StatusReport[]` data
already loaded in the app. No new database tables, no persistent alert storage,
no automatic transfers.

---

## 2. Files Delivered

| File | Status | Description |
|---|---|---|
| `src/features/alerts/materialAlertEngine.ts` | NEW | Pure TypeScript alert engine |
| `src/features/alerts/__tests__/materialAlertEngine.test.ts` | NEW | Unit tests for the engine |
| `src/features/dashboard/DashboardScreen.tsx` | MODIFIED | Nav bug fix + Smart Alerts widget |
| `src/features/alerts/InterInstitutionAlertsScreen.tsx` | MODIFIED | Material Exchange Command Center upgrade |
| `src/shared/i18n/strings.ts` | MODIFIED | 31 new bilingual string keys |

---

## 3. Material Alert Engine (`materialAlertEngine.ts`)

### Guarantees

- **Pure**: no side effects, no network calls, no DB writes
- **Deterministic**: identical inputs always produce identical outputs
- **Safe**: null / undefined / invalid fields never crash the engine
- **Reusable**: used by Dashboard widget and available for other screens
- **Testable**: all utility functions are exported for unit testing

### Severity Model

| Severity | Trigger | Border Color |
|---|---|---|
| `critical` | `status_type === 'missing'` OR `expiry_date < today` | `var(--err)` dark red |
| `urgent` | `status_type === 'scarce'` OR `expiry_date ≤ today + 3 months` | `#dc2626` rose/red |
| `high` | `expiry_date ≤ today + 6 months` | `var(--warn)` orange |
| `watch` | `expiry_date ≤ today + 9 months` | amber |
| `opportunity` | `status_type === 'surplus'` | `var(--p)` blue/violet |
| `info` | data quality contradictions | `var(--t2)` slate/neutral |

### Alert Kinds

- `expiry` — computed from `expiry_date` field (independent of manual `status_type`)
- `missing` — `status_type === 'missing'` (critical) or `'scarce'` (urgent)
- `surplus` — `status_type === 'surplus'` (opportunity)
- `data_quality` — contradictions: qty > 0 with missing status; expired by date but non-expiry status

### Expiry Thresholds (calendar-accurate)

Uses `new Date(year, month + n, day)` for month computation — not fixed day counts.
This avoids off-by-one errors around month boundaries.

### Exchange Suggestions

Generated when:
- Source `status_type ∈ {surplus, near_expiry}` in institution A
- Target `status_type ∈ {missing, scarce}` in institution B (different org)
- Material matches by `item_id` (high confidence) OR exact `item_name`/`item_name_ar` (medium confidence)
- Low-confidence (fuzzy) matches are NOT shown

Severity mapping:
- `near_expiry + missing` → `urgent`
- `surplus + missing + qty > 0` → `urgent`
- `surplus + missing + qty = 0` → `opportunity`
- `surplus + scarce` OR `near_expiry + scarce` → `high`

### Output

```typescript
interface MaterialAlertEngineOutput {
  alerts: MaterialAlert[];          // sorted critical → info
  suggestions: ExchangeSuggestion[]; // sorted urgent → opportunity
  summary: { criticalCount, urgentCount, highCount, watchCount, opportunityCount, dataQualityCount };
  computedAt: string;               // ISO timestamp of today parameter
}
```

---

## 4. Dashboard Changes

### Navigation Bug Fix

**Before (bug):** Exchange alert cards called `onNavigate(12)` → Status Center  
**After (fixed):** `onNavigate(13)` → Inter-Institution Alerts ✓

Line 118 of `DashboardScreen.tsx` was corrected.

### Smart Material Alerts Widget

- Shows top 3 critical/urgent alerts from `computeMaterialAlerts(allReports.data)`
- Uses `useMemo` to avoid recomputing on every render
- "View all alerts" button → `onNavigate(13)`
- Hidden when no critical/urgent alerts exist (no empty section noise)
- Each card has severity rail (left border: `var(--err)` or `#dc2626`)

Data source: the existing `allReports` async fetch (`getStatusReports({ activeOnly: true })`)
already loaded by the Dashboard — no additional fetch required.

---

## 5. Inter-Institution Alerts Screen Upgrade

### New Identity

- **Title:** "مركز تبادل المواد بين المؤسسات" / "Material Exchange Command Center"
- **Subtitle:** `exchange_command_subtitle` key

### Summary Cards

Four interactive metric tiles derived from loaded `ScopedAlert[]`:

| Card | Data Source |
|---|---|
| Total exchange alerts | `allAlerts.length` |
| Critical need | `allAlerts.filter(a => a.priority === 'high').length` |
| Near-expiry redistribution | `allAlerts.filter(a => a.sourceStatus === 'near_expiry').length` |
| Surplus opportunities | `allAlerts.filter(a => a.sourceStatus === 'surplus').length` |

Clicking a card activates the corresponding filter chip.

### Filter Chips

Replace the priority dropdown with semantic chips:
- **All** — clears chip filter
- **High Priority** — `priority === 'high'`
- **Medium Priority** — `priority === 'medium'`
- **Low Priority** — `priority === 'low'`
- **Near-expiry** — `sourceStatus === 'near_expiry'`
- **Surplus** — `sourceStatus === 'surplus'`
- **Missing** — `targetStatus === 'missing'`
- **Scarce** — `targetStatus === 'scarce'`

Pair and institution selects are retained for further narrowing.

### Alert Cards

- Left severity rail: `var(--err)` for high, `var(--warn)` for medium, `var(--brd)` for low
- Labels updated: "المؤسسة المصدر / Source Institution" and "المؤسسة المستهدفة / Destination Institution"

### Empty State

Uses `no_exchange_opportunities` key instead of `iia_empty` for the filtered-zero state.

---

## 6. Known Duplicate: StatusCenterScreen ExchangeAlertsSection

`src/features/status/StatusCenterScreen.tsx` embeds its own `ExchangeAlertsSection`
component that duplicates some of the exchange alert display logic from
`InterInstitutionAlertsScreen`. This is a **known pre-existing duplicate** — left
unchanged per task hard rules (do not touch unrelated modules).

Remediation path (future task): extract a shared `<ExchangeAlertCard>` component
and use it from both StatusCenterScreen and InterInstitutionAlertsScreen.

---

## 7. i18n Keys Added (31 keys)

All keys are bilingual (Arabic + English) in `src/shared/i18n/strings.ts`:

`smart_material_alerts`, `material_exchange_command_center`, `exchange_command_subtitle`,
`expires_within_9_months`, `expires_within_6_months`, `expires_within_3_months`,
`expired_material`, `surplus_for_redistribution`, `critical_need`, `urgent_redistribution`,
`data_quality_warning`, `current_position_based`, `view_all_alerts`, `no_exchange_opportunities`,
`verify_quantity_before_transfer`, `rotate_before_expiry`, `available_but_zero_quantity`,
`expired_but_marked_available`, `source_institution`, `destination_institution`,
`suggested_action`, `confidence`, `severity`, `watch`, `urgent`, `high`, `critical`,
`opportunity`, `missing_material`, `out_of_stock`, `no_smart_alerts`

---

## 8. Safety Properties

| Property | Status |
|---|---|
| No SQL / migrations | ✅ |
| No DB writes | ✅ |
| No Edge Function deploy | ✅ |
| No Vercel deploy | ✅ |
| No service_role exposure | ✅ |
| No auth.admin in frontend | ✅ |
| No RLS changes | ✅ |
| No fake / hardcoded data | ✅ |
| No automatic transfers | ✅ |
| No WhatsApp/email notifications | ✅ |
| No persistent alert DB table | ✅ |
| Existing 65 IIA tests still pass | ✅ |

---

## 9. Design Decisions

**Why `StatusReport[]` as engine input?**  
The Dashboard already fetches it. The engine is then a `useMemo()` call — zero extra
network requests. For the InterInstitutionAlertsScreen, the existing service already
returns `ScopedAlert[]` which carry `sourceStatus`/`targetStatus` — enough for the
summary cards and filter chips without a second fetch.

**Why i18n keys in `reason` / `suggestedAction` fields?**  
The engine is language-agnostic. Storing key names instead of resolved strings means
the UI calls `t(alert.reason, lang)` and respects the user's language preference.
It also means the engine has zero dependency on the i18n module.

**Why calendar `addMonths()` instead of fixed day counts?**  
91/183/274 days diverge from 3/6/9 calendar months by up to 2–3 days depending on
the month. Using `new Date(y, m + n, d)` gives exact calendar-month boundaries.

---

## 10. Post-SMART UX Polish (POST-SMART-ALERTS-USABILITY-AND-THRESHOLD-POLISH-A)

**Date:** 2026-06-30  
**Scope:** UX/visual polish only — no SQL, no migrations, no engine logic changes.

### Final 9 / 6 / 3 / Expired Color Model

| Bucket       | Severity     | Border / Badge Color            | Tone           |
|---|---|---|---|
| `expired`    | `critical`   | `var(--err)` dark red           | Serious danger |
| `3_months`   | `urgent`     | `#dc2626` rose/red              | Urgent warning |
| `6_months`   | `high`       | `var(--warn)` orange            | Strong warning |
| `9_months`   | `watch`      | `#d97706` amber                 | Early warning  |
| surplus      | `opportunity`| `var(--p)` blue/violet          | Opportunity    |
| missing      | `critical`   | `var(--err)` red                | Critical need  |

### Visible UI Badges and Filters

**`ExpiryBucketBadge` component** (defined locally in both Dashboard and IIA screen):
- Renders a colored pill badge showing "Expired / منتهي الصلاحية", "3 months / 3 أشهر", etc.
- Used on Dashboard smart alert cards when `a.kind === 'expiry' && a.monthsBucket` is set.
- Used on IIA screen alert cards when the source has an `expiryDate` that computes to a bucket.

**Threshold filter chips in IIA screen** (three rows):
1. Priority row: All · High · Medium · Low
2. Expiry threshold row: Expired · 3 months · 6 months · 9 months
3. Condition row: Surplus → Missing · Missing · Scarce · Data Quality

### Dashboard Widget Behavior

- **Always shown** when `materialAlertResult` is not null (data loaded).
- **Empty state** (`no_critical_alerts_now` key): shown when no critical/urgent alerts exist.
  - Arabic: لا توجد تنبيهات حرجة حالياً
  - English: No critical alerts right now
- **Top 3 cards**: critical + urgent alerts only, sorted highest severity first.
- **Threshold badge**: shown per card for expiry-kind alerts (9/6/3/expired).
- **Expiry date**: shown in small text below material name when `a.expiryDate` is set.
- **View all** button always visible, navigates to screen 13 (Inter-Institution Alerts).

### Mobile / RTL Notes

- All cards use `dir="auto"` for material/institution names.
- Expiry date displayed `dir="ltr"` to preserve date format.
- Filter chip rows wrap on mobile via `flexWrap: 'wrap'`.
- `PhoenixCard` hover lift is CSS-transition-based (60ms implicit by theme).

### Animation and Accessibility

- Entrance animation: container `animation: 'fs .3s ease'` (existing, one-shot, not looping).
- No infinite pulsing or blinking animations added.
- Hover effect: `PhoenixCard` hover prop (existing CSS transition, no JS required).
- `aria-pressed` on Chip and SummaryCard buttons for screen reader state.
- Color is never the **only** signal — badges carry text labels in both languages.

### i18n Keys Added (12 keys, phase POST-SMART)

`no_critical_alerts_now`, `filter_expired`, `filter_9_months`, `filter_6_months`,
`filter_3_months`, `filter_surplus`, `filter_missing`, `filter_data_quality`,
`expiry_threshold_9_months`, `expiry_threshold_6_months`, `expiry_threshold_3_months`,
`expired`

### What Was Intentionally Not Changed

- `materialAlertEngine.ts` — engine logic untouched (no bugs found).
- `inter-institution-alerts.ts` — domain logic untouched.
- `inter-institution-alerts.service.ts` — service untouched.
- No migrations, no RLS changes, no SQL.
- No new npm dependencies added.
- `StatusCenterScreen` exchange section — known duplicate, not touched per scope rules.

### Remaining Future Work

- Dedicated **Material Alerts screen** that renders all `MaterialAlert[]` from the engine
  with full threshold filter chips (expired/3/6/9/surplus/missing/data-quality).
- Persistent alert storage (requires new migration — future phase).
- External notifications (future phase after persistent alerts).
- `ExpiryBucketBadge` could be extracted to `src/shared/ui/` when more than 2 screens use it.
