# MediStock Phoenix V2 — Keep / Remove Map

**Created:** 2026-06-27

Quick-reference for what crosses the boundary from old project to Phoenix.

---

## KEEP (concept + data)

These features have direct equivalents in Phoenix and their data will be migrated:

| Concept | Old name | Phoenix name |
|---------|----------|--------------|
| Hospital / org | organizations | organizations |
| User profiles + roles | profiles | profiles |
| Drug master list | central_drugs | central_items |
| Drug availability record | drug_status | item_availability |
| Physical location | drug_points + warehouses | distribution_points + warehouses |
| QR token | qr_access_tokens | qr_tokens |
| Audit trail | audit_logs | audit_logs |
| Low stock summary | get_low_stock_summary RPC | reused |
| Institution health | get_institution_health RPC | reused |

---

## REWRITE (same purpose, new implementation)

These are rebuilt from scratch in Phoenix but serve the same business need:

- Purge RPC — `purge_entity_with_all_data` (allowlist: warehouse / point / local_item only)
- Archive RPC — `archive_entity` (soft-delete with `archived_at/by/reason`)
- QR create/disable RPCs — hospital-scoped, stable `public_id`
- All frontend service files — one service.ts per feature, RPC-only writes
- Status/condition i18n — moved from `lib/status.ts` to `shared/i18n/strings.ts`
- App shell — PhoenixAppShell replaces old dual-shell central/app split

---

## REMOVE (not migrated, not referenced)

These modules are dropped and will not appear anywhere in Phoenix:

| Module | Why removed |
|--------|-------------|
| Smart Intake Hub | Frozen — complex, failure-prone, not core |
| OCR Import | Dropped — tesseract.js complexity + matching errors |
| Document Intelligence | Dropped — 8-tab workflow too complex |
| Excel Import | Dropped — replaced by manual entry via EditorScreen |
| Pharma Network | Dropped — transfer workflow out of scope |
| Transfer Alerts | Dropped — no auto-transfer in Phoenix |
| Data Reset Center | **Safety rule** — never brought back |
| User permission overrides | Dropped — too complex for V2; standard RBAC only |
| Command alerts | Dropped — pharma network dependency |
| Drug name aliases | Dropped — intake dependency |
| OCR batch tables | Dropped |
| Excel batch tables | Dropped |
| Document intake tables | Dropped |

---

## FREEZE (present in Phoenix but locked)

| Feature | How it appears |
|---------|---------------|
| Intake workflows | IntakeFrozenScreen — visual block with redirect to EditorScreen |

---

## Migration Data Scope

Only these tables will be migrated from old Supabase to Phoenix Supabase:

1. `organizations` → `organizations`
2. `profiles` → `profiles`
3. `central_drugs` → `central_items` (map columns)
4. `drug_status` → `item_availability` (map columns, drop intake-only rows)
5. `warehouses` → `warehouses`
6. `drug_points` → `distribution_points`
7. `qr_access_tokens` → `qr_tokens` (hash-only, regenerate public_id)
8. `audit_logs` → `audit_logs` (keep last 90 days only)

Everything else stays in the old database. The old database is NOT deleted.
