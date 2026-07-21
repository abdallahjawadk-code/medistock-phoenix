# Outlet Corridor (Screen 18) — visual evidence

Captured by `scripts/phoenix-capture-outlet-corridor.mjs` against a Vite dev
server started **from this worktree**, driven by `playwright-core` connecting
**directly to `127.0.0.1`** — never through an editor/preview proxy, which has
previously served a stale transform from a different checkout.

## Reproducing

```bash
# 1. Serve THIS worktree on an unused strict port.
VITE_ENABLE_VISUAL_QA=true npm run dev -- \
  --host 127.0.0.1 --port 5191 --strictPort --force

# 2. Capture. Exits non-zero on any failed check.
node scripts/phoenix-capture-outlet-corridor.mjs http://127.0.0.1:5191
```

Each capture runs in a disposable browser context: no shared user profile,
service workers blocked, and the HTTP cache disabled via CDP.

## Runtime provenance of this capture

| Fact | Value |
| --- | --- |
| Dev server PID | 2380 |
| Vite binary | `D:\phoenix-worktrees\pr41-supply-return\node_modules\vite\bin\vite.js` |
| Base URL | `http://127.0.0.1:5191` |
| Browser | installed Chrome, headless, isolated context |

The served source was confirmed over plain HTTP to carry the Screen-18 markers
(`or_tab_status`, `outlet-stock-list`, `confirm-create-outlet-return`,
`movement-status-lookup`) before any browser was launched.

## Scene URLs

The harness is DEV-only and gated on `VITE_ENABLE_VISUAL_QA=true`.

```
http://127.0.0.1:5191/?qa=1&persona=<persona>&lang=<ar|en>&theme=<dark|light>&scene=<shell|outlet>
```

`scene=shell` is the QA shell — every grid cell starts there and reaches Screen
18 through the **real sidebar or mobile drawer**. `scene=outlet` is used only to
set up state variants, never as the reachability proof.

`super_admin` additionally takes `&org=qa-org-a1`: its profile carries
`organization_id: null` exactly as in production, and the harness cannot drive
the `<PhoenixOrgScope />` picker.

## Scoped-permission personas

Outlets are scoped by ACTIVE migration-062 `profile_scope_assignments` rows, via
`useInventoryScopes.manageableOutlets` — never by role name. Each assigned
persona shares its role with an unassigned twin, so these captures prove the
gate is **scope**, not role.

| Persona | Assignment | Outlets reached |
| --- | --- | --- |
| `super_admin` | none needed (full-access control) | Emergency, Pediatrics |
| `warehouse_officer_assigned` | warehouse `qa-wh-inst-a` | Emergency, Pediatrics |
| `warehouse_officer` | none | denied — empty scope |
| `outlet_officer_assigned` | point `qa-outlet-1` | Emergency only |
| `outlet_officer` | none | denied — empty scope |
| `central_warehouse_manager` | none | denied — empty scope |

`outlet_officer_assigned` reaching Emergency but **not** its sibling Pediatrics
under the same warehouse is the point-level scope proof.

## What the runner asserts (it exits non-zero on any of these)

- any uncaught page error or console error;
- a stale/fallback bundle — the harness banner must report the requested
  persona, which a stale bundle cannot do for a newly-added persona id;
- Screen 18 reached through the real sidebar / drawer, with the nav item marked
  `aria-current="page"`;
- the mobile drawer closing itself after navigation;
- the topbar naming Screen 18 (see the defect below);
- no horizontal overflow (`scrollWidth > clientWidth`);
- every tab/nav touch target at least 44×44;
- no legacy `upsertAvailability` / manual-stock form markers in the DOM;
- no outlet rendered outside the persona's assignment (scope leak).

## Defect found and fixed by this evidence

`SCREEN_TITLE_KEYS` in `PhoenixAppShell` had no entry for screen 18, so the
topbar fell back to `nav_status_center`: the corridor rendered **"Status
Center"** above an Outlet Operations page, in both AR and EN. Fixed by mapping
`18: 'nav_outlet_ops'`, and now asserted by `assertTopbarTitle` so it cannot
regress silently.

## Known gaps

- **Returns receipt actions are not yet captured.** The QA fixture catalog has
  no outlet return-request rows, so the Returns tab renders its empty state and
  the canonical receipt actions (print preview, optional-field selector, QR
  lookup, XLSX export) are not reachable from the harness. The runner reports
  this rather than silently skipping. Workbook structure, locked trace fields,
  AR/EN headers and formula-injection neutralisation are covered directly by
  `src/features/movement/__tests__/receipt-xlsx.test.ts`.
- `Accept all safe lines (0)` is correctly `disabled` when there is nothing to
  accept, but keeps primary-button styling, so it reads as actionable. Cosmetic,
  not a permission defect.

## Inventory

`INVENTORY.json` lists every captured file with the capture timestamp and base
URL. 39 screenshots across AR/EN × dark/light × desktop/tablet/mobile, all five
tabs, all six personas, and the movement-status idle / not-available / offline
states.
