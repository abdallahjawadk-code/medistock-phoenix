# FIX-AVAILABILITY-UPSERT-UNIQUE-A

**Phase**: FIX-AVAILABILITY-UPSERT-UNIQUE-A  
**Scope**: Frontend TypeScript + docs + migration doc only. No schema change applied here.

---

## Problem

`upsertAvailability` in `src/shared/supabase/services/availability.service.ts` failed with
Postgres error **42P10**:

> there is no unique or exclusion constraint matching the ON CONFLICT specification

### Root cause

The `onConflict` option specified two columns:

```ts
.upsert(row, { onConflict: 'distribution_point_id,scientific_name' })
```

But no unique index on exactly `(distribution_point_id, scientific_name)` existed in the DB.
Migration 020 created `item_availability_dp_sci_conc_form_uniq` was not created yet.
The 2-column index `item_avail_point_sciname_idx` from migration 020 is not enough — it still
requires all 4 columns to be in the conflict target.

Additionally, the service sent `concentration` and `dosage_form` as `null` when the user left
those fields blank:

```ts
dosage_form:   input.dosageForm       ?? null,  // ← was null
concentration: input.concentrationValue ?? null, // ← was null
```

The DB index uses `COALESCE(concentration, '')` and `COALESCE(dosage_form, '')` as the key
expressions. Postgres matches index keys by evaluating the expression — so a row with `null`
maps to `''` in the index. But supabase-js cannot express `COALESCE` in `onConflict`; it only
accepts plain column names. Therefore the service must send `''` so that the column value and
the COALESCE expression both evaluate to `''`, producing a match.

---

## Fix Applied

### 1. DB index (migration 029 — manually applied)

File: `supabase/migrations/029_phoenix_availability_scientific_name_unique.sql`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_uniq
ON public.item_availability (
  distribution_point_id,
  scientific_name,
  COALESCE(concentration, ''),
  COALESCE(dosage_form, '')
)
WHERE scientific_name IS NOT NULL;
```

Applied manually via Supabase SQL Editor (not `db push`).

### 2. Service layer (`availability.service.ts`)

Two fields changed from `?? null` to `?? ''`:

```ts
// Before:
dosage_form:   input.dosageForm        ?? null,
concentration: input.concentrationValue ?? null,

// After:
dosage_form:   input.dosageForm        ?? '',
concentration: input.concentrationValue ?? '',
```

`onConflict` updated to 4 columns:

```ts
// Before:
.upsert(row, { onConflict: 'distribution_point_id,scientific_name' })

// After:
.upsert(row, { onConflict: 'distribution_point_id,scientific_name,concentration,dosage_form' })
```

A JSDoc comment above `upsertAvailability` documents the `''` vs `null` invariant and the
reason (COALESCE / 42P10) so future maintainers do not revert to `null`.

---

## Why `''` and not `null`

supabase-js translates `onConflict: 'col1,col2,...'` into a Postgres
`ON CONFLICT (col1, col2, ...)` clause. Postgres requires those columns (or expressions)
to exactly match an existing unique index. The index uses `COALESCE(concentration, '')`,
meaning it stores `''` for both `null` and `''` column values. Since the `ON CONFLICT` clause
uses raw column names (not expressions), the only way to hit the index is for the actual column
value to match what `COALESCE` returns — i.e., `''`.

---

## Tests Added

File: `src/features/editor/__tests__/availability-editor-institution-ux.test.ts`

| Test | Assertion |
|------|-----------|
| scientific_name is trimmed | `.trim()` present in upsert function |
| concentration uses `''` when absent | `?? ''` present; `?? null` absent |
| dosage_form uses `''` when absent | `?? ''` present; `?? null` absent |
| onConflict has all 4 columns | full 4-column string present |
| old 2-column onConflict is gone | old string absent |
| comment documents COALESCE / 42P10 | keywords present in service file |

The pre-existing test `'upsert targets scientific_name conflict key'` was updated to assert
the new 4-column key instead of the old 2-column key.

---

## Security Guardrails (unchanged)

- No RLS policy created, modified, or dropped.
- No `service_role` or `auth.admin` in frontend.
- No DELETE grant added.
- `FULL_PUBLIC_APP_WIPE_APPROVED` remains empty in `.env.local`.
