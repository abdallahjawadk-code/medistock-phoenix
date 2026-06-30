# Public QR / Public Availability Privacy Audit

**Task:** AVAILABILITY-PUBLIC-RLS-PRIVACY-HARDENING-A  
**Date:** 2026-06-30  
**Migration produced:** `supabase/migrations/027_phoenix_public_availability_privacy_hardening.sql`  
**Status:** DEFECTS D1–D4 fixed in migration 027 (MANUAL APPLY REQUIRED)

---

## 1. Scope

This audit covers the complete path by which unauthenticated (anon) users receive
material availability data via the public QR scan feature:

```
QR code URL (?qid=<public_id>)
  → App.tsx publicQrId() gate
  → PublicQrScreen.tsx
  → getPublicQrPayload(publicId)              [qr.service.ts]
  → supabase.rpc('get_public_qr_payload', …)  [anon role]
  → Supabase: RLS + SECURITY DEFINER function  [migration 003]
  → item_availability, distribution_points, organizations, qr_tokens, qr_targets
```

Tables with anon-relevant RLS policies (before this migration):

| Table | Anon policy (pre-027) |
|---|---|
| `qr_tokens` | `qrtk_select_anon` — `using (status = 'active')` |
| `item_availability` | `avail_select_anon` — `using (true)` ← **CRITICAL** |
| All others | No anon policy (RLS blocks access) |

---

## 2. Files Inspected

| File | Purpose |
|---|---|
| `src/app/App.tsx` | Public QR entry gate (`publicQrId()`, `?qid=`) |
| `src/features/qr/PublicQrScreen.tsx` | Public-facing availability display |
| `src/shared/supabase/services/qr.service.ts` | `getPublicQrPayload()` call |
| `supabase/migrations/001_phoenix_core_schema.sql` | `item_availability` schema |
| `supabase/migrations/002_phoenix_rls_policies.sql` | RLS policies |
| `supabase/migrations/003_phoenix_rpc_lifecycle.sql` | `get_public_qr_payload` RPC |
| `supabase/migrations/013_phoenix_user_identity_snapshot_foundation.sql` | Actor snapshot columns |
| `supabase/migrations/019_phoenix_availability_editor_institution_ux.sql` | Gap documented |
| `supabase/migrations/020_phoenix_availability_material_fields_and_status_editor.sql` | Material identity columns |

---

## 3. `item_availability` Full Column Set (pre-027)

All columns exposed to anon via `avail_select_anon using (true)` before this migration:

| Column | Source migration | Sensitivity |
|---|---|---|
| `id` | 001 | low |
| `local_item_id` | 001 | low (FK) |
| `distribution_point_id` | 001 | low (FK) |
| `organization_id` | 001 | medium — reveals org membership |
| `quantity` | 001 | internal |
| `condition` | 001 | internal |
| `batch_number` | 001 | **HIGH** — pharmaceutical batch tracking |
| `expiry_date` | 001 | **HIGH** — internal procurement metadata |
| `notes` | 001 | **HIGH** — free-text internal staff notes |
| `last_updated_by` | 001 | medium — auth.users UUID |
| `created_at` | 001 | low |
| `updated_at` | 001 | low |
| `actor_name_snapshot` | 013 | **CRITICAL** — real staff full name (PII) |
| `actor_email_snapshot` | 013 | **CRITICAL** — real staff email (PII) |
| `actor_role_snapshot` | 013 | medium |
| `actor_org_snapshot` | 013 | medium |
| `actor_identity_version` | 013 | low |
| `port_name` | 019 | low |
| `supply_type` | 019 | internal |
| `scientific_name` | 020 | internal |
| `trade_name` | 020 | internal |
| `dosage_form` | 020 | internal |
| `concentration` | 020 | internal |
| `price` | 020 | **HIGH** — procurement pricing |

Any anonymous user worldwide could call `supabase.from('item_availability').select('*')`
and receive all 23 columns for all rows across all organizations — with no rate limit,
no organization filter, and no authentication required.

---

## 4. `get_public_qr_payload` RPC — Pre-027 Output Fields

The RPC runs as `SECURITY DEFINER` and curates a much narrower set than the raw table.
Pre-027 output for `distribution_point` target type:

| Field | Value source | Exposed pre-027 | Exposed post-027 |
|---|---|---|---|
| `ok` | literal | ✅ | ✅ |
| `target_type` | literal | ✅ | ✅ |
| `org_name` | `organizations.name` | ✅ | ✅ |
| `org_name_ar` | `organizations.name_ar` | ✅ | ✅ |
| `point_label` | `qr_targets.label` / `dp.name` | ✅ | ✅ |
| `items[].name` | `central_items.name` | ✅ | ✅ |
| `items[].name_ar` | `central_items.name_ar` | ✅ | ✅ |
| `items[].condition` | `item_availability.condition` | ✅ | ✅ |
| `items[].quantity` | `item_availability.quantity` | ✅ (all conds) | ✅ (null for expired) |
| `items[].unit` | `central_items.unit` | ✅ | ✅ |
| `items[].expiry_date` | `item_availability.expiry_date` | ✅ (all conds) | ✅ (near_expiry/expired only) |
| `batch_number` | — | ❌ never exposed | ❌ never exposed |
| `price` | — | ❌ never exposed | ❌ never exposed |
| `trade_name` | — | ❌ never exposed | ❌ never exposed |
| `notes` | — | ❌ never exposed | ❌ never exposed |
| `actor_name_snapshot` | — | ❌ never exposed | ❌ never exposed |
| `actor_email_snapshot` | — | ❌ never exposed | ❌ never exposed |

**Key finding:** The RPC itself was reasonably safe (correct field curation). The critical
vulnerability was the parallel `avail_select_anon using (true)` policy that allowed the
RPC to be bypassed entirely by a direct table query.

---

## 5. Defects Found and Fixed

### D1 [CRITICAL] — `avail_select_anon` policy is `using (true)`

**Location:** `supabase/migrations/002_phoenix_rls_policies.sql` lines 253–258  
**Documented as gap:** `supabase/migrations/019_phoenix_availability_editor_institution_ux.sql` lines 69–83

```sql
-- PRE-027 (VULNERABLE):
create policy "avail_select_anon" on item_availability
  for select to anon
  using (true);   -- ← grants anon SELECT on ALL rows, ALL columns, ALL orgs
```

**Impact:** Any anonymous user could call:
```js
const { data } = await supabase.from('item_availability').select('*')
```
and receive all availability records — including `actor_name_snapshot` (staff names),
`actor_email_snapshot` (staff emails), `price`, `batch_number`, `notes` — for every
organization in the system. No organization filter. No pagination limit on fields.

**Why the RPC alone was insufficient protection:** The `avail_select_anon` policy
creates an entirely separate access path that bypasses the RPC. The public QR page only
uses `getPublicQrPayload()`, but the policy made the table itself available to any
JavaScript that happened to use the same anon Supabase client.

**Fix in 027:**
```sql
drop policy if exists "avail_select_anon" on item_availability;
create policy "avail_select_anon" on item_availability
  for select to anon
  using (false);  -- deny all direct anon table access
```

**Why this is safe:** `get_public_qr_payload` is `SECURITY DEFINER`, meaning it runs
as the function owner (Supabase `postgres` superuser), not as the anon caller.
Superusers bypass RLS entirely. Removing the anon table policy has **zero effect**
on QR scan results served through the RPC.

---

### D2 [HIGH] — RPC returns `quantity` for `expired` items

**Location:** `supabase/migrations/003_phoenix_rpc_lifecycle.sql` lines 73–79, 126–132

```sql
-- PRE-027 (items aggregation):
'quantity', ia.quantity   -- ← always included, even for expired condition
```

**Impact:** A patient or member of the public who calls the RPC endpoint directly
(e.g. via `curl` or a custom script) sees a non-zero quantity for drugs marked
as expired. This is medically misleading — it implies the drug is available stock
when it has in fact expired. The frontend UI correctly hides this with
`variant !== 'err'`, but the raw JSON does not.

**Fix in 027:**
```sql
'quantity', case when ia.condition = 'expired' then null else ia.quantity end
```
Applied in both `distribution_point` and `local_item` branches.

---

### D3 [MEDIUM] — RPC returns `expiry_date` for all conditions

**Location:** `supabase/migrations/003_phoenix_rpc_lifecycle.sql` lines 79, 132

```sql
-- PRE-027:
'expiry_date', ia.expiry_date   -- ← always included regardless of condition
```

**Impact:** Drugs marked `available`, `surplus`, or `low_stock` have their `expiry_date`
included in the raw RPC JSON. This leaks internal procurement metadata (when the in-stock
drug batch expires). The frontend filters this correctly, but direct API callers see it.

**Fix in 027:**
```sql
'expiry_date', case when ia.condition in ('near_expiry', 'expired')
               then ia.expiry_date else null end
```

---

### D4 [MEDIUM] — `distribution_point` branch has no `status = 'active'` guard

**Location:** `supabase/migrations/003_phoenix_rpc_lifecycle.sql` lines 64–89

**Background:** `archive_entity()` (migration 003) sets `distribution_points.status = 'archived'`
but does **not** disable the associated QR token. If a point is archived while its QR
token is still active, the public QR scan continues to return item data for the retired point.
The `warehouse` branch correctly filters sub-points with `dp.status = 'active'` (line 109),
but the `distribution_point` branch had no equivalent guard.

**Fix in 027:**
```sql
when 'distribution_point' then
  if not exists (
    select 1 from distribution_points
    where id = v_target.target_id and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'error', 'DISTRIBUTION_POINT_NOT_ACTIVE');
  end if;
  -- ... payload build continues only for active points
```

**Frontend behavior for D4:** `PublicQrScreen.tsx` already handles `ok === false`
by showing the "invalid QR / scan again" message. No frontend change needed.

---

## 6. Defects Documented but Not Fixed in Migration 027

### D5 [LOW] — `qrtk_select_anon` allows QR token enumeration

**Location:** `supabase/migrations/002_phoenix_rls_policies.sql` lines 357–359

```sql
create policy "qrtk_select_anon" on qr_tokens
  for select to anon
  using (status = 'active');
```

An anonymous user can page through all active QR tokens:
```js
supabase.from('qr_tokens').select('id, public_id, organization_id').range(0, 999)
```

**Risk assessment: LOW.** The `public_id` values are embedded in physical QR codes
posted in public spaces — they are intentionally public. Enumerating them yields no
additional data beyond what a person standing in front of a posted QR code can see.
The token `id` (UUID) exposes nothing sensitive, and `organization_id` alone does not
reveal any PHI or PII.

**Recommended future action:** Add a rate-limit or require a known `public_id` in the
WHERE clause (policy: `using (false)` + serve only through RPC). Low priority.

---

### D6 [MEDIUM-FUNCTIONAL] — New editor items invisible on public QR

**Location:** `supabase/migrations/003_phoenix_rpc_lifecycle.sql` line 82

```sql
from item_availability ia
join local_items li on li.id = ia.local_item_id   -- ← INNER JOIN on nullable column
join central_items ci on ci.id = li.central_item_id
```

Migrations 019–020 made `local_item_id` nullable and added `scientific_name` directly
to `item_availability` to support the new `AvailabilityEditor`. Items entered through the
new editor have `local_item_id = NULL` and a non-null `scientific_name`. The RPC inner-joins
`local_items`, so these records are **silently excluded** from public QR results.

**Risk:** Functional gap (missing data on public QR page), not a privacy concern.
Admins entering data via the new editor may believe the public page shows accurate
inventory when it does not.

**Recommended fix:** Update the RPC to use `LEFT JOIN local_items` and `LEFT JOIN central_items`,
and use `coalesce(ci.name, ia.scientific_name)` for the item name. Separate migration scope.

---

### D7 [LOW-DESIGN] — `near_expiry` is manually assigned

`item_availability.condition` can be set to `near_expiry` only by a human operator
changing the dropdown in the editor. The `expiry_date` field is not used to auto-compute
whether a drug is near expiry. A drug could have `condition = 'available'` with an
`expiry_date` of tomorrow.

**Impact:** Public QR page will show the drug as "Available" (green) even if it expires
tomorrow. The `expiry_date` fix in D3 ensures this date is not leaked in the raw JSON,
but the `condition` label itself may be misleading.

**Recommended fix:** A database trigger or scheduled Edge Function that auto-sets
`condition = 'near_expiry'` when `expiry_date` is within a configurable window
(e.g. 30 days), and `condition = 'expired'` when `expiry_date < current_date`.
Separate migration scope — requires policy decision on the warning window.

---

## 7. Fields Never Exposed by the RPC (Confirmed Safe)

The following fields are confirmed absent from all three target-type branches of
`get_public_qr_payload` (migration 003 original and migration 027 update):

- `batch_number`
- `price`
- `trade_name`
- `dosage_form`
- `concentration`
- `supply_type`
- `notes`
- `actor_name_snapshot`
- `actor_email_snapshot`
- `actor_role_snapshot`
- `actor_org_snapshot`
- `actor_identity_version`
- `last_updated_by`
- `created_at` / `updated_at`

The privacy label displayed in `PublicQrScreen.tsx`:
```
🔒 لا كشف لبيانات الدُفعات (No batch data exposure)
```
is accurate for the RPC output. After migration 027 (D1 fix), it is also enforced
at the database layer — anon can no longer bypass it by querying the table directly.

---

## 8. Frontend Analysis — `PublicQrScreen.tsx`

The public QR screen (`src/features/qr/PublicQrScreen.tsx`) was reviewed in full.

**Correct behaviors (no changes needed):**
- Calls only `getPublicQrPayload()` — no direct table queries
- Hides `quantity` for `err` variant (missing/expired): `variant !== 'err'`
- Shows `expiry_date` only for `near_expiry`/`expired`: `isNearExpiry` flag
- Shows expired items with red badge (`CONDITION_VARIANT.expired = 'err'`) — intentional UX
- Language toggle works without re-fetching data
- Privacy label displayed at bottom of every result

**No frontend changes required for this migration.**

The UI's field-filtering is now backed by DB-level enforcement (D2, D3 fixes in RPC),
making the behavior correct for both the UI consumer and direct API callers.

---

## 9. Migration 027 Safety Summary

| Property | Status |
|---|---|
| MANUAL APPLY ONLY | ✅ Documented in file header |
| No DROP TABLE / TRUNCATE / destructive DELETE | ✅ Confirmed |
| No auth.users writes | ✅ Confirmed |
| No service_role exposure | ✅ Confirmed |
| No anon write | ✅ Confirmed — only anon SELECT policy changed |
| No DELETE grant | ✅ Confirmed |
| No RLS weakening | ✅ Confirmed — all authenticated policies unchanged |
| Preserves valid QR access | ✅ SECURITY DEFINER RPC bypasses RLS |
| Idempotent | ✅ DROP POLICY IF EXISTS + CREATE OR REPLACE |
| Includes VERIFY block | ✅ 5 assertions |
| Non-destructive to existing data | ✅ No rows modified |

---

## 10. Apply Instructions

1. Read this document and migration 027 in full before applying.
2. Take a verified backup of the Supabase project.
3. Open the Supabase Dashboard → SQL Editor.
4. Paste the full content of `027_phoenix_public_availability_privacy_hardening.sql`.
5. Run the script. The `VERIFY` block will raise `NOTICE` on success or `ASSERT FAILURE` on any defect.
6. Run the five manual verification queries from the migration file's footer.
7. Perform a functional QR scan test on a real active token to confirm items still appear.

**Do NOT apply via `supabase db push`.**

---

## 11. Test Coverage

New guardrail tests added to:
`src/shared/supabase/__tests__/phoenix-guardrails.test.ts`

Test suites added:
- **Section 32** — Migration 027 file content verification (19 tests)
- **Section 32** (continued) — Public QR service uses only RPC (3 tests)
- **Section 32** (continued) — Privacy label now DB-enforced (3 tests)

All 25 new tests pass as static assertions against migration file content.
No live database connection required.
