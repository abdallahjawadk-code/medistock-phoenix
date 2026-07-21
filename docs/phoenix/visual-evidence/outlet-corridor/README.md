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

## Return-receipt corridor

`scripts/phoenix-capture-return-receipts.mjs` closes the gap the first pass
reported. The canonical receipt surface only exists AFTER a receive, so it was
unreachable from SELECT fixtures alone.

```bash
node scripts/phoenix-capture-return-receipts.mjs http://127.0.0.1:5191
```

It reaches the queue through real controls only — sidebar → Inventory Center →
warehouse picker → "Receive outlet returns" — then receives, and captures the
optional/locked print-field selector, the live print preview, the QR canonical
UUID, and the receive outcome, in EN/dark and AR/light. Screen 18 → Movement
status resolves the return REQUEST from its canonical UUID.

Migration-071 fixtures cover submitted / partially-fulfilled / completed /
rejected requests and in-transit / partially-received / received shipments, with
a short-shipped line carrying a stated difference. Ids are canonical UUIDs
because the QR payload and the status lookup both reject anything else.

### Simulated mutation outcomes — read this

`QA_MUTATION_OUTCOMES` registers a small, explicit allowlist of migration-071
write RPCs that resolve to a deterministic LOCAL outcome. Nothing is written, no
database is contacted, and no permission is decided or bypassed — the real RPC
is untouched and re-checks authorization server-side. Every RPC outside the
allowlist still fails closed with `QA_READONLY`, which
`src/features/qa/__tests__/qa-fixture-client.test.ts` asserts explicitly.

**These captures prove the screen renders correctly after a write. They prove
nothing about whether the real write would be permitted.**

### XLSX validation

`docs/phoenix/visual-evidence/outlet-corridor/xlsx/` holds the workbooks
downloaded from the real browser export. Validation is not a ZIP-signature
sniff: the bytes are re-loaded with `ExcelJS.xlsx.load` and asserted for three
sheets, the locked trace key and shipment number, canonical fixture values
(`Amoxicillin`, `B4471X`), AR vs EN sheet names, `rightToLeft` on the AR
workbook only, no live formula cells, and no unneutralised `= + - @` lead.

## Defects found and fixed by this evidence

1. `SCREEN_TITLE_KEYS` had no entry for screen 18, so the topbar fell back to
   `nav_status_center`: the corridor rendered **"Status Center"** above an
   Outlet Operations page, AR and EN. Fixed, and asserted by `assertTopbarTitle`.
2. `MANDATORY_HEADER_FIELDS` carries `'qr'`, but `mv_h_qr` had no string, and
   `t()` falls back to its own key — so the print dialog listed a literal
   **`mv_h_qr`** among the mandatory traceability fields, in both languages.
   Fixed, and asserted by `assertNoRawI18nKeys`.
3. `CurrentMovementStatus` sampled `navigator.onLine` during render without
   subscribing, so its offline banner was latched at mount. Replaced with the
   subscribed `useOnlineStatus` hook; `readOnlineStatus` also now guards the
   PROPERTY, because modern Node defines a global `navigator` with no `onLine`.

## Known gaps and observations

- **The Screen-18 Returns tab receipt is still not captured.** Its actions
  appear only after the composer CREATES a request, and the create path is not
  in the mutation allowlist. The return REQUEST document is instead evidenced
  through Movement status, which resolves it from canonical server rows.
- `useReturnReceivePermission` calls the module-level `supabaseRbacTransport`
  directly rather than the injected `authz` transport, so the harness cannot
  influence it and only `super_admin` (which short-circuits) reaches the Returns
  tab. Not a security defect — the RPC re-checks server-side — but it makes the
  preflight untestable through the service seam.
- `Accept all safe lines (0)` is correctly `disabled` when there is nothing to
  accept, but keeps primary-button styling, so it reads as actionable. Cosmetic,
  not a permission defect.
- Shipment `status` renders as the raw enum (`in_transit`) inside the receipt in
  both languages. Not an i18n key leak; a polish item.

## Inventory

`INVENTORY.json` lists every captured file with the capture timestamp and base
URL. 39 screenshots across AR/EN × dark/light × desktop/tablet/mobile, all five
tabs, all six personas, and the movement-status idle / not-available / offline
states.
