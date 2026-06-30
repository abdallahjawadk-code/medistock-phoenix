# QR Audit Center — Polish

**Phase**: QR-AUDIT-CENTER-POLISH-A  
**Scope**: Frontend only — no SQL, no migrations, no RLS changes, no service_role usage.

---

## Purpose

The QR Audit Center (`src/features/qr/QrScreen.tsx`, screen 6) gives admins a unified,
operational view of all QR tokens issued for their organization. It replaces the previous
minimal token list with:

- Summary metric cards (active, disabled, risk, ports without QR, total scans)
- Risk detection: active QR tokens pointing to inactive/archived distribution points
- Port-coverage detection: active ports not covered by any active QR token
- Per-token audit cards with status badges, scan stats, timestamps, and safe actions
- Filter chips and search
- Print-to-window using the QR image (same pattern as Institution screen)

---

## Difference from Institution / Port QR Actions

| | Institution Screen (Port Card) | QR Audit Center (screen 6) |
|---|---|---|
| **Scope** | Per-port QR lifecycle management | Org-wide QR audit overview |
| **Generate QR** | ✅ (qr.generate gated) | ❌ — create from port card |
| **Regenerate QR** | ✅ (qr.generate + qr.revoke) | ❌ — do from port card |
| **Revoke QR** | ✅ (qr.revoke gated) | ✅ (qr.revoke gated, with confirm dialog) |
| **Print QR** | ✅ (via modal) | ✅ (on-demand, active tokens only) |
| **Copy URL** | ✅ (click URL text) | ✅ (dedicated button + click URL) |
| **Open public page** | ❌ | ✅ |
| **Risk detection** | ❌ | ✅ (inactive target badge + banner) |
| **Ports without QR** | ❌ | ✅ (computed cross-referencing getPointsByOrg) |
| **Total scan count** | ❌ | ✅ |

---

## Data Sources

| Data | Service | Query |
|------|---------|-------|
| QR tokens + target status | `getQrTokensByOrg(orgId)` | `qr_tokens` joined with `qr_targets (id, target_type, target_id, label, status)` |
| Distribution points | `getPointsByOrg(orgId)` | `distribution_points` where `organization_id = orgId` and `status != 'archived'` |

Both are loaded in parallel. No new RPCs, no new migrations.

---

## Metrics Implemented

| Metric | How computed | Source |
|--------|-------------|--------|
| Active QR codes | `rows.filter(r => r.status === 'active').length` | `qr_tokens.status` |
| Disabled QR codes | `rows.filter(r => r.status !== 'active').length` | `qr_tokens.status` |
| QR linked to inactive port | Active tokens where `qr_targets.status !== 'active'` | `qr_targets.status` |
| Ports without active QR | Active points not in `activeDpTargetIds` Set | Cross-reference between `qr_tokens` + `distribution_points` |
| Total QR scans | `rows.reduce((sum, r) => sum + r.scan_count, 0)` | `qr_tokens.scan_count` |

---

## Metrics Intentionally Omitted / Documented Limitations

- **Scan analytics over time** (scans per day/week): `qr_tokens` only stores `scan_count` (integer) and `last_scanned_at` (timestamp). Time-series analytics are not available without a dedicated `qr_scan_events` table. Future phase: `QR-AUDIT-RPC-SUPPORT-MIGRATION-A`.
- **Warehouse-type QR ports without QR**: `getPointsByOrg` only returns distribution points. Warehouse-level QR coverage requires a separate query. Currently not computed; omitted rather than faked.
- **Local item QR coverage**: Same limitation — `getPointsByOrg` returns distribution points only.
- **Scan history / per-scan location**: No scan logging beyond count + last timestamp.

---

## Permission Behavior

| Action | Permission check |
|--------|----------------|
| View audit page | Existing QR nav access (screen 6) |
| Revoke / disable QR | `myPermissions.has('qr.revoke')` |
| Generate QR | `myPermissions.has('qr.generate')` — shown only in ports-without-QR CTA advisory |
| Copy link | No permission gate (public URL is safe by design) |
| Open public page | No permission gate (public URL is safe by design) |
| Print QR | No permission gate for active QR (prints public URL only) |

Permission check uses `myPermissions` from `AppContext` (same as InstitutionScreen), not
a hardcoded role check.

---

## Public-Safe Fields Displayed

The audit center displays only fields that are safe to show authenticated admins:

| Field | Source | Safe? |
|-------|--------|-------|
| `public_id` | `qr_tokens.public_id` | ✅ Embedded in printed QR codes; public by design |
| `status` | `qr_tokens.status` | ✅ Operational status |
| `scan_count` | `qr_tokens.scan_count` | ✅ Aggregate count, no PII |
| `last_scanned_at` | `qr_tokens.last_scanned_at` | ✅ Timestamp only, no identity |
| `created_at` | `qr_tokens.created_at` | ✅ |
| `disabled_at` | `qr_tokens.disabled_at` | ✅ |
| `qr_targets.label` | `qr_targets.label` | ✅ Custom display label |
| `qr_targets.target_type` | `qr_targets.target_type` | ✅ Structural info |
| `qr_targets.status` | `qr_targets.status` | ✅ Target entity status |

**NOT displayed**:
- `token_hash` — never surfaced
- `actor_name_snapshot`, `actor_email_snapshot` — never surfaced
- `batch_number`, `price`, `notes` — not queried
- Internal audit fields — not queried

---

## Risks Detected

### 1. Active QR linked to inactive/archived port (Critical)

Active `qr_tokens` where the joined `qr_targets.status !== 'active'`. This happens when
a distribution point is archived/deactivated but its QR token was not explicitly revoked.

**Visual signal**: Red border on card, `⚠ QR linked to inactive port` badge, advisory text,
risk banner at top of list, metric card with "Risk" badge.

**Suggested action**: Review the port or disable the QR (revoke button if `qr.revoke`).

**Detected by**: `archive_entity()` (migration 003) does not automatically disable the
associated QR token — this was documented as defect D4 in migration 027 (which fixed the
_public QR payload_ but did not add an automatic revoke on archive). The audit center
exposes this gap at the admin UI level.

### 2. Ports without active QR (Warning)

Active distribution points (from `getPointsByOrg`) with no active `qr_tokens` entry of
type `distribution_point`.

**Visual signal**: Amber metric card, "Ports without active QR" filter chip, dedicated
section under `no_qr` filter with CTA pointing to Institution screen.

### 3. Disabled QR codes (Informational)

Tokens with `status !== 'active'` — revoked, expired, or manually disabled.

---

## Future Work

- **`QR-AUDIT-RPC-SUPPORT-MIGRATION-A`**: Dedicated `get_qr_audit_summary` RPC returning
  pre-computed coverage stats and time-series scan analytics in a single query.
- **QR scan analytics**: Track individual scan events (`qr_scan_events` table) to enable
  per-day scans, geographic breakdown, device types.
- **Bulk print**: Print all active QR codes for an org in a single print job.
- **QR issue acknowledgement**: Admin can mark a risk as "acknowledged" to suppress the
  banner while investigation is underway.
- **Export report**: CSV/PDF export of QR audit state for compliance review.
- **Warehouse QR coverage**: Extend `portsWithoutQr` to also cover warehouse-level targets.

---

## Verification

```bash
npm test -- --run          # 2053 tests, all pass (+65 new QR audit tests)
npm run lint               # 0 warnings
npm run build              # clean production build
npm audit --audit-level=high  # pre-existing vulnerabilities only (no new ones)
```
