# Outlet corridor (070/071) — runtime evidence & QA repro

Covers the outlet return corridor shipped in PR #41 §A–E: OutletReturnComposer,
InstitutionReturnReceipts (mounted in Inventory Center), Screen 18 Outlet
Operations, canonical receipts + XLSX + QR, and Current Movement Status.

## How to capture the evidence matrix (visual-QA harness)

The visual-QA harness renders the real screens against network-free fixtures, so
the matrix can be captured **without a live session**. It is DEV-only and
tree-shaken from production (`tests/qa-harness-production-safety.test.ts`).

1. From this worktree: `npm run dev` (or the `phoenix-visual-qa` launch config).
2. Open the harness with per-cell URL params:

```
http://localhost:<port>/?qa=1&persona=<persona>&lang=<ar|en>&theme=<light|dark>&scene=<scene>&org=qa-org-a1
```

- `scene=outlet` → Screen 18 Outlet Operations (incoming / stock / returns /
  history / **status** tabs). Newly wired for §C–E.
- `scene=inventory` → Inventory Center, including the **Receive outlet returns**
  tab (§E1) for a super_admin persona.
- `persona` ∈ `super_admin`, `warehouse_officer`, `outlet_officer` (see
  `src/features/qa/qaFixtures.ts`). super_admin sees every outlet/warehouse;
  scoped personas see only their assignments.

### Matrix cells to capture

For each of `scene=outlet` and `scene=inventory`:
`{ar,en} × {light,dark} × {desktop 1280, tablet 768, mobile 375}` — 12 cells
each — plus the persona axis for gating (super_admin vs warehouse_officer vs
outlet_officer). Within `scene=outlet`, capture each tab; within the Returns
tab, compose a draft and open the receipt actions (print preview + XLSX); within
the Status tab, paste a canonical UUID / QR payload and capture the result,
not-available, offline and error states.

> Writes resolve to the fixture client's read-only error by design, so the
> harness proves layout/theme/RTL/gating and the receipt/print/XLSX/QR **render**
> path; genuine mutation flows (actual receive → ledger move) require a live
> authenticated session with seeded data.

## Status of the automated capture in THIS environment

The in-app Browser pane could not capture screenshots here for two
environment-level reasons, independent of the application code:

1. **`computer{screenshot}` hangs** (30s timeout) against the preview — a
   pre-known issue in this workspace.
2. **A persistent preview proxy served stale module transforms.** After editing,
   a fresh dev server (new PID, `node_modules/.vite` cleared) still returned
   pre-edit module content through the preview's proxy layer (the `previewId`
   was identical across every server restart), so the harness rendered an old
   bundle without the new `scene=outlet` / Screen-18 nav.

Neither is a defect in the shipped code (disk + CI reflect the current code).
The harness wiring above is committed and will render correctly in a clean
preview environment or a plain local `npm run dev` + browser.

## Structural verification standing in for runtime (all CI-green)

Because this repo has no DOM test environment, behaviour is pinned by
DI-behavioural + contract tests that CI runs on every checkpoint:

- Composer draft-first discipline, provenance-mandatory, no free-text/OCR:
  `outlet-return-composer-contract.test.ts`, `outlet-return-draft.test.ts`.
- Institution receipt (individual/bulk, disposition, canonical reload, shipment
  receipt reachable): `institution-return-receipt*.test.ts`.
- Screen 18 route + nav across sidebar/drawer/palette + scope-not-role gate:
  `outlet-operations-screen-contract.test.ts`.
- Inventory-Center mount + exact scoped receive permission:
  `return-receipts-mount-contract.test.ts`.
- Canonical receipts server-sourced + XSS-safe render + QR of opaque UUID:
  `outlet-receipt-source.test.ts`.
- Current Movement Status RLS-only, no existence leak, all UI states:
  `movement-status*.test.ts`.
- Idempotency under lost responses / retries / bulk partial / permissions /
  concurrency: `outlet-return-commit.test.ts`, `institution-return-receipt.test.ts`,
  `outlet-dispatch-receive.test.ts`.

## Standing blockers (do not deploy)

1. **migration-065 expected-generation protection** — accumulating warehouse
   receipt can double-post cross-device; fail-closed in prod by
   `warehouse-intake-safety.ts`. See
   `blocker-migration-065-accumulating-receipt-concurrency.md`.
2. **unified movement-timeline RPC** — Current Movement Status is current-state
   only; the full historical timeline needs a server RPC. See
   `proposals/movement-timeline-rpc.md`.
