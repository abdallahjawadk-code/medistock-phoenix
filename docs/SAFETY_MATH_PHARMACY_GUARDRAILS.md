# Safety / Math / Pharmacy Guardrails

**Phase**: SAFETY-MATH-PHARMACY-GUARDRAILS-A  
**Scope**: Frontend TypeScript + tests + docs only. No SQL, no migrations, no RLS changes.

---

## 1. `addMonths` — Postgres Alignment Fix

### Problem

The original implementation:

```ts
export function addMonths(base: Date, months: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + months, base.getDate());
}
```

JavaScript's `Date` constructor silently overflows month-end days:
`new Date(2026, 1, 31)` → `2026-03-03` (31 days past Feb 1).

Postgres `(current_date + interval 'N months')::date` clamps the result to the last day
of the target month: `2026-01-31 + interval '1 month'` → `2026-02-28`.

This divergence caused `expiryBucket()` to produce different bucket assignments than the
DB's `expiry_bucket` field from `get_public_qr_payload` (migration 028) for dates that
fall on the last day of a long month when the target month is shorter.

### Fix

```ts
// Matches Postgres `(date + interval 'N months')::date` semantics:
// the result day is clamped to the last day of the target month,
// preventing JS Date overflow at month boundaries.
export function addMonths(base: Date, months: number): Date {
  const rawMonth  = base.getMonth() + months;
  const y         = base.getFullYear() + Math.floor(rawMonth / 12);
  const m         = ((rawMonth % 12) + 12) % 12;
  const lastDay   = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(base.getDate(), lastDay));
}
```

### Verified Equivalence

| Input | JS result (fixed) | Postgres result |
|-------|-------------------|-----------------|
| 2026-01-31 + 1 month | 2026-02-28 | 2026-02-28 ✅ |
| 2026-01-31 + 3 months | 2026-04-30 | 2026-04-30 ✅ |
| 2026-01-31 + 6 months | 2026-07-31 | 2026-07-31 ✅ |
| 2026-01-31 + 9 months | 2026-10-31 | 2026-10-31 ✅ |
| 2024-01-31 + 1 month | 2024-02-29 | 2024-02-29 ✅ (leap year) |
| 2026-01-15 + 3 months | 2026-04-15 | 2026-04-15 ✅ (mid-month unchanged) |

`expiryBucket()` itself was **not changed** — its `<=` comparisons are correct.

---

## 2. `matchConfidence` — Blind-Match Guard

### Problem

If both a source and destination `StatusReport` somehow passed `materialKey()` with
non-empty keys but lacked any discriminating name data, `matchConfidence()` could
theoretically return a false-positive `medium` match.

More importantly: name-only matching (`medium` confidence) does **not** guarantee that
two materials are pharmacologically equivalent. The fields `concentration`, `dosage_form`,
and `supply_type` are **absent from `StatusReport`** (they are not queried from the DB
and are not part of the interface). An operator name like "Amoxicillin" without dosage
form/concentration context is insufficient to confirm safe exchange.

### Fix Applied (Defensive Guard)

```ts
// Guard: if neither side carries item_id nor any name → return null (no blind matching).
if (!srcEn && !srcAr && !dstEn && !dstAr) return null;
```

A comment documents the pharmacological limitation explicitly.

### Phase 5 Deferral — Concentration / Dosage Form / Supply Type Matching

**Decision**: Matching on `concentration`, `dosage_form`, and `supply_type` is deferred
to a future phase (**Phase 5**) for the following reason:

> These three fields do not exist in `StatusReport`
> (`src/shared/supabase/services/status-reports.service.ts`). The interface was confirmed
> via source inspection — the fields are not queried and not present. Adding them would
> require a backend schema change to `institution_item_status_reports`, an RPC or query
> update, and StatusReport interface expansion.

Until Phase 5 ships, the UI correctly communicates this limitation via `manualActionRequired: true`
on every `ExchangeSuggestion` — no suggestion is ever acted on automatically.

---

## 3. Expiry Bucket Color/Style — Single Source of Truth

### Problem

The color and background values for each `ExpiryBucket` were duplicated verbatim in three
separate files:

| File | Location |
|------|----------|
| `src/features/dashboard/DashboardScreen.tsx` | `ExpiryBucketBadge` (lines ~40–42) |
| `src/features/alerts/InterInstitutionAlertsScreen.tsx` | `ExpiryBucketBadge` (lines ~48–50) |
| `src/features/qr/PublicQrScreen.tsx` | `getExpBucketBadge` (lines ~44–46) |

### Fix

Added a new export to `materialAlertEngine.ts`:

```ts
export function getExpiryBucketStyle(bucket: string): { color: string; bg: string } | null {
  switch (bucket) {
    case 'expired':  return { color: 'var(--err)',  bg: 'var(--err2)'  };
    case '3_months': return { color: '#dc2626',     bg: '#fef2f2'      };
    case '6_months': return { color: 'var(--warn)', bg: 'var(--warn2)' };
    case '9_months': return { color: '#b45309',     bg: '#fef3c7'      };
    default:         return null;
  }
}
```

All three files now call `getExpiryBucketStyle(bucket)` and destructure `{ color, bg }`.
**No visual output was changed** — the exact same colors and backgrounds are used.

i18n label keys differ per screen (by design) and are unchanged:

| Screen | i18n keys used |
|--------|---------------|
| Dashboard + IIA | `filter_expired`, `filter_3_months`, `filter_6_months`, `filter_9_months` |
| PublicQrScreen | `expired_material`, `expires_within_3_months`, `expires_within_6_months`, `expires_within_9_months` |

---

## 4. New Tests Added

File: `src/features/alerts/__tests__/materialAlertEngine.test.ts`

| Test group | Count | What is tested |
|------------|-------|---------------|
| `addMonths` (month-end clamping) | 6 | Jan 31 + 1/3/6/9 months; leap year Feb 29; mid-month unchanged |
| `expiryBucket` (today = 2026-01-31) | 3 | inclusive 3-month boundary; one day past; expired |
| `matchConfidence` guardrails | 3 | no-name blind match → 0 suggestions; high; medium |

---

## 5. Security Reminder

`FULL_PUBLIC_APP_WIPE_APPROVED` in `.env.local` **must remain empty**.  
It was verified empty at the start of this phase and must not be set to any value unless
a full wipe procedure is explicitly approved by the project owner.
