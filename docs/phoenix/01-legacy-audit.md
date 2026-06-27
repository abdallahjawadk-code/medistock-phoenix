# MediStock Phoenix V2 — Legacy Audit

**Created:** 2026-06-27  
**Old project:** `C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project`

This document classifies everything in the old project into one of four dispositions:

- **KEEP** — reuse the concept, rewrite the code
- **REWRITE** — same feature, new implementation
- **REMOVE** — dropped entirely in Phoenix
- **FREEZE** — exists in Phoenix but is locked/read-only

---

## Screens / Pages

| Old Route | Old Component | Disposition | Notes |
|-----------|--------------|-------------|-------|
| /login | Login page | REWRITE | New design, same role-chip concept |
| /central/dashboard | CentralCommandCenter | REWRITE | New DashboardScreen with metric cards |
| /app/dashboard | App dashboard | REWRITE | Merged into single DashboardScreen |
| /app/editor | Availability Editor | REWRITE | EditorScreen — single+batch form |
| /central/drug-master | Drug Registry | REWRITE | RegistryScreen — read+search only |
| /app/inventory-nodes | Inventory Nodes | REWRITE | MeshScreen — 4 nodes, bridge view |
| /app/qr-hub | QR Management | REWRITE | QrScreen — QR-safe, no parent delete |
| /app/system-health | System Health | REWRITE | HealthScreen — module accordion |
| /app/smart-intake | Smart Intake Hub | FREEZE | IntakeFrozenScreen — blocked workflow |
| /app/ocr-import | OCR Import | REMOVE | Dropped entirely |
| /app/doc-intel | Document Intelligence | REMOVE | Dropped entirely |
| /app/excel-import | Excel Import | REMOVE | Dropped entirely |
| /app/pharma-network | Pharma Network | REMOVE | Dropped entirely |
| /central/data-reset | Data Reset Center | REMOVE | Safety rule: never bring back |
| /app/users | User Management | REMOVE | Not in Phoenix V2 scope |
| /app/transfer-alerts | Transfer Alerts | REMOVE | Not in Phoenix V2 scope |

---

## Supabase Tables

| Table | Disposition | Notes |
|-------|-------------|-------|
| organizations | KEEP | Renamed to `organizations` in Phoenix |
| profiles | KEEP | Same concept, new RLS |
| drug_status | REWRITE | Becomes `item_availability` |
| drug_points | REWRITE | Becomes `distribution_points` |
| warehouses | KEEP | Same concept |
| central_drugs | REWRITE | Becomes `central_items` (SA-only write) |
| drug_categories | KEEP → `item_categories` | Simplified |
| qr_access_tokens | REWRITE | Becomes `qr_tokens` with stable public_id |
| qr_entry_registry | REWRITE | Merged into `qr_targets` |
| audit_logs | KEEP | Same concept, new schema |
| document_intake_* | REMOVE | Intake frozen |
| excel_import_* | REMOVE | Dropped |
| ocr_import_* | REMOVE | Dropped |
| transfer_recommendations | REMOVE | Dropped |
| pharma_network_* | REMOVE | Dropped |
| command_alerts | REMOVE | Dropped |
| user_permission_overrides | REMOVE | Too complex for V2 |
| drug_name_aliases | REMOVE | Part of frozen intake |

---

## RPCs

| Old RPC | Disposition | Notes |
|---------|-------------|-------|
| get_public_qr_payload | REWRITE | Kept, simplified |
| create_qr_for_target | REWRITE | Allowlist: warehouse / point only |
| disable_qr_token | KEEP | Same concept |
| purge_drug_point_with_all_data | REWRITE | New safe purge: QR-first, parent-last |
| get_purge_impact | REWRITE | Preview before purge |
| archive_drug_point | REWRITE | Becomes `archive_entity` (allowlisted) |
| get_low_stock_summary | KEEP | Dashboard metric |
| get_institution_health | KEEP | HealthScreen |
| purge_drug_point_with_all_data (071) | SUPERSEDED | Phoenix rewrites from scratch |
| upsert_document_intake_rows | REMOVE | Intake frozen |
| apply_document_batch | REMOVE | Intake frozen |
| All excel_import_* RPCs | REMOVE | Dropped |
| All ocr_import_* RPCs | REMOVE | Dropped |

---

## Services / Frontend Files

| Old File | Disposition |
|----------|-------------|
| src/services/lifecycle-purge.service.ts | REWRITE → Phase 5 RPC wiring |
| src/services/supabase/*.ts (10 files) | REWRITE → src/features/*/service.ts |
| src/lib/status.ts (statusLabel) | KEEP concept → shared/i18n/strings.ts |
| src/lib/intake/* | REMOVE |
| src/lib/ocr-parse-engine.ts | REMOVE |
| src/lib/exceljs-loader.ts | REMOVE |
| src/pages/InventoryNodesCommandCenter.tsx | REWRITE → MeshScreen |
| src/shared/ui/Phoenix*.tsx | KEEP (already built in Phoenix) |

---

## Known Problems to Avoid

1. **Point-purge signature mismatch** — migrations 068–071 in old project never fully resolved the `point_id = point_id` ambiguity. Phoenix RPC will use `v_point_id` consistently everywhere.
2. **PostgREST cache stale after migration** — Phoenix deploy checklist must include cache reload step.
3. **`service_role` in frontend** — Never. All writes go through RPC or RLS-gated table access.
4. **Intake module complexity** — OCR / DocIntel / ExcelImport caused months of debugging. Phoenix does not include them. IntakeFrozenScreen is a hard block with visual explanation.
5. **Optional table guard (42703 column error)** — Old purge RPCs failed because optional tables were guarded at table level but not column level. Phoenix RPCs use `information_schema.columns` checks.
6. **QR reuse after parent delete** — Old tokens survived parent deletion. Phoenix: disable QR token BEFORE deleting parent (enforced by purge RPC order).
