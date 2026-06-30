# Public QR D6/D7 — Expiry & Scientific-Name Fix

**Phase**: PUBLIC-QR-D6-D7-EXPIRY-AND-SCIENTIFIC-NAME-FIX-A  
**Migration**: 028 (MANUAL APPLY ONLY — do not apply via `supabase db push`)  
**Frontend**: `src/features/qr/PublicQrScreen.tsx`  
**Tests**: `src/shared/supabase/__tests__/phoenix-guardrails.test.ts` (appended)

---

## Defects Fixed

### D6 — Scientific-name-only items invisible on public QR

**Root cause**: Migration 019 made `item_availability.local_item_id` nullable to support a new editor path where operators enter items by `scientific_name` instead of selecting from the local item catalogue. Rows created via this path have `local_item_id = NULL` and `scientific_name` populated.

The `distribution_point` branch of `get_public_qr_payload` joined `item_availability` to `local_items` and `central_items` using INNER JOINs. Any row where `local_item_id IS NULL` was silently dropped — scientific-name-only items were completely invisible on the public QR scan result.

**Fix (migration 028)**: Changed both JOINs to LEFT JOINs. Display name computed via `COALESCE`:
```sql
coalesce(ci.name,    ci.name_ar, ia.scientific_name, 'Unnamed material')  as name
coalesce(ci.name_ar, ci.name,    ia.scientific_name, 'مادة غير مسماة')  as name_ar
```

`unit` comes from `ci.unit` (NULL for scientific-name-only rows — `item_availability` has no `unit` column and migration 020 did not add one).

**Safety**: `scientific_name` is used only as a display-name fallback. It is a pharmacological name (e.g. "Amoxicillin") intended for clinical use — not an internal identifier or sensitive operational field. It is NOT emitted as its own key in the JSON output.

---

### D7 — Expiry condition based on manual `ia.condition`, not `expiry_date`

**Root cause**: The RPC returned `ia.condition` directly. `condition` is manually set by operators. A material could have `condition = 'available'` while its `expiry_date` is within 9, 6, or 3 months, or already expired — the public QR would show it as "Available" with no warning. This is medically misleading.

**Fix (migration 028)**: Added a derived subquery computing `effective_condition` and `expiry_bucket` from `expiry_date` using date-only arithmetic (no timezone ambiguity):

| `expiry_date` vs today                        | `effective_condition` | `expiry_bucket` |
|-----------------------------------------------|----------------------|-----------------|
| `< current_date`                              | `'expired'`          | `'expired'`     |
| `<= current_date + interval '3 months'`       | `'near_expiry'`      | `'3_months'`    |
| `<= current_date + interval '6 months'`       | `'near_expiry'`      | `'6_months'`    |
| `<= current_date + interval '9 months'`       | `'near_expiry'`      | `'9_months'`    |
| `> current_date + interval '9 months'`        | `ia.condition`       | `null`          |
| `IS NULL`                                     | `ia.condition`       | `null`          |

The outer query reads `derived.effective_condition` and `derived.expiry_bucket` so each is computed once (not duplicated in every CASE output column).

**D2/D3 from migration 027 extended**: Both guards now use `effective_condition` instead of `ia.condition`:
- D2: `quantity = null when effective_condition = 'expired'`
- D3: `expiry_date` returned only when `effective_condition in ('near_expiry', 'expired')`

The fix applies to both the `distribution_point` branch and the `local_item` branch of the RPC.

---

## What Was NOT Changed

- `avail_select_anon` policy (`using (false)`) — fully preserved (D1)
- D4: `distribution_point status = 'active'` guard — fully preserved
- Token resolution, scan counter, org resolution — unchanged
- `warehouse` branch — unchanged
- All RLS policies on `item_availability` — unchanged
- No new tables, columns, or indexes
- No `auth.users` writes, no service_role exposure, no anon write grants

---

## Frontend Changes — `PublicQrScreen.tsx`

### New `PublicItem` field

```typescript
expiry_bucket?: string; // D7: 'expired'|'3_months'|'6_months'|'9_months'|null
```

### New `getExpBucketBadge` helper

```typescript
function getExpBucketBadge(bucket: string | undefined, lang: 'ar' | 'en'):
  { label: string; color: string; bg: string } | null
```

Uses existing `strings.ts` i18n keys — no new keys added:

| `expiry_bucket`  | i18n key                  | Color       |
|------------------|---------------------------|-------------|
| `'expired'`      | `expired_material`        | `var(--err)` / `var(--err2)` |
| `'3_months'`     | `expires_within_3_months` | `#dc2626` / `#fef2f2`       |
| `'6_months'`     | `expires_within_6_months` | `var(--warn)` / `var(--warn2)` |
| `'9_months'`     | `expires_within_9_months` | `#b45309` / `#fef3c7`       |

### Item card changes

- Border color uses `bucketBadge.color` when a threshold badge is present (amber/orange/rose/red), falling back to `var(--brd)`.
- Threshold badge (pill) shown alongside the existing condition badge.
- Expiry date warning text uses `bucketBadge.color` for accurate color matching instead of always `var(--warn)`.

---

## Tests Added (migration 028 guardrails)

File: `src/shared/supabase/__tests__/phoenix-guardrails.test.ts`

Four new describe blocks appended after the migration 027 tests:

| Block | Tests |
|-------|-------|
| `PUBLIC-QR-D6 [scientific-name-only items visible on QR]` | 8 |
| `PUBLIC-QR-D7 [auto-compute expiry condition from expiry_date]` | 15 |
| `PUBLIC-QR-D6/D7 [security: privacy guardrails preserved in migration 028]` | 15 |
| `PUBLIC-QR-D6/D7 [frontend: PublicQrScreen expiry_bucket support]` | 10 |

Total new tests: **48**

---

## Migration 028 Manual Apply Instructions

1. Confirm migration 027 is applied and healthy in Supabase Dashboard.
2. Open Supabase Dashboard → SQL Editor.
3. Paste the full contents of `supabase/migrations/028_phoenix_public_qr_expiry_scientific_name_fix.sql`.
4. Run. The embedded `DO $$ … $$` VERIFY block will raise a NOTICE on success or an ASSERT error on failure.
5. Run the post-apply SQL queries in the migration file's comments to confirm D1/D4 preserved, D6/D7 fixed.

**Do NOT** apply via `supabase db push`, automated CI, or any script runner.

---

## Remaining Future Work (out of scope for this phase)

- `unit` for scientific-name-only rows: currently `null`. A future migration could add a `unit` column to `item_availability` or extend migration 020's scientific_name editor to capture unit.
- `local_item` branch: could similarly be extended to handle scientific_name-only rows if such rows are ever linked via a different key, though at present the `local_item` QR target only exists for rows that have `local_item_id IS NOT NULL`.
- Frontend threshold badge animation (pulsing border for expired, identical to dashboard widget cards) — not added here to minimize scope; can be a dedicated polish pass.
