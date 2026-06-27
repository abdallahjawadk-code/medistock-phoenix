# Public Schema Inventory — Before Full Wipe

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27  
**Status:** Template — run `inspect_public_before_wipe.sql` to populate actual results

---

## How to Generate This Report

```bash
psql "$PHOENIX_DATABASE_URL" \
  -f supabase/full_wipe_tools/inspect_public_before_wipe.sql \
  > docs/phoenix/full-wipe/01-public-schema-inventory-before-wipe-ACTUAL.txt
```

The `.txt` file is the live inventory. This `.md` template documents what to look for.

---

## Known Old App Objects (to be wiped)

### Tables (old MediStock schema — all to be dropped)

| Category | Tables |
|----------|--------|
| Core | `organizations`, `profiles`, `drug_status`, `drug_points`, `warehouses` |
| Central drug master | `central_drugs`, `drug_categories`, `drug_barcodes` |
| QR | `qr_access_tokens`, `qr_entry_registry` |
| Intake / OCR | `document_intake_batches`, `document_intake_rows`, `ocr_import_batches`, `ocr_import_rows` |
| Excel | `excel_import_batches`, `excel_import_rows`, `excel_mapping_configs` |
| Pharma network | `command_alerts`, `supply_match_opportunities`, `coordination_cases` |
| User governance | `user_permission_overrides` |
| Audit | `audit_logs` |
| Aliases | `drug_name_aliases` |

### Functions / RPCs (old — all to be dropped)

- `purge_drug_point_with_all_data` (multiple broken versions, 068–071)
- `get_point_purge_impact` / `point_purge_impact`
- `archive_drug_point` / `restore_drug_point`
- All `upsert_document_intake_*` variants
- All `apply_document_batch*` variants
- All `excel_import_*` RPCs
- All `ocr_import_*` RPCs
- All `pharma_network_*` RPCs
- `get_manageable_users`, `admin_update_user_status`
- `get_effective_user_permissions`, `grant_permission`, `revoke_permission`
- `validate_qr_public_id`, `create_qr_entry`, `archive_qr_entry`
- `get_central_command_summary`, `get_institution_health_scores`

### Triggers (old — all to be dropped with CASCADE)

- `set_updated_at` on old tables
- `on_auth_user_created` (old version with old schema)

### Enum Types (old — all to be dropped)

- `drug_status_condition` or similar
- `qr_entry_type`
- Any other public enums from old schema

---

## What Will Remain After Wipe + Phoenix Rebuild

### Phoenix Tables (10)
`audit_logs`, `central_items`, `distribution_points`, `item_availability`,
`local_items`, `organizations`, `profiles`, `qr_targets`, `qr_tokens`, `warehouses`

### Phoenix Enum Types (1)
`qr_target_type` — values: `warehouse`, `distribution_point`, `local_item`

### Phoenix Functions (8)
`phoenix_my_role`, `phoenix_my_org`, `phoenix_set_updated_at`,
`phoenix_handle_new_user`, `get_public_qr_payload`, `create_qr_for_target`,
`disable_qr_token`, `archive_entity`, `get_entity_purge_impact`,
`purge_entity_with_all_data`

### Phoenix RLS Policies
35+ policies across all 10 tables

### Supabase Internal (untouched)
`auth.*`, `storage.*`, `realtime.*`, `extensions`, `vault`, `graphql`

---

## Pre-Wipe Checklist

- [ ] Inventory SQL has been run and output saved
- [ ] Row counts reviewed for any data worth exporting manually
- [ ] `pg_dump` backup completed (see `00-backup-before-full-wipe.md`)
- [ ] `FULL_PUBLIC_APP_WIPE_APPROVED=yes` set in `.env.local`
