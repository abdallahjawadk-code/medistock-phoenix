# Reporting Closure — operational verification pass 1

Real authenticated browser verification against PR #56's Vercel Preview
deployment (`feat/phoenix-reporting-closure` @ `f8179b1`), which targets the
**Production Supabase project** (`eyrzxgfkvqybjdgyphap` — confirmed via the
live `Content-Security-Policy` `connect-src` header). Per the read-only
constraint for this backend, only navigation, loading, filtering, and
export/print actions were performed — no snapshots, corrections, approvals,
movements, or cycle-starts were created.

## Status Center and Reports (screen 12)

- Loads with real live data (5 institutions, correct Arabic RTL layout).
- Institution filter switches correctly; quantity-movement report, inventory
  intelligence panel, internal alerts, and transfer suggestions all render.
- CSV export and print buttons present on both the availability report and
  the quantity-movement report.
- Zero console errors.

## Decision Intelligence Reporting Center (screen 21)

All 9 tabs opened and inspected individually: Executive Overview, Institution
Status, Materials & Batches, Stock Movements, **Custody Chain**, Supplementary
Purchases, Differences & Corrections, Audit-Sensitive Actions, Official
Report Library. Zero console errors, zero blank pages, on any tab.

- **Custody Chain (previously "blank page" defect): confirmed genuinely
  fixed.** All three sections (dispatches, return requests, return shipments)
  render correctly with a legitimate empty state for this org/filter
  combination — no crash, no blank screen.
- **CSV export (Stock Movements tab) — verified with real captured bytes**:
  `text/csv;charset=utf-8;`, 459 bytes, correct Arabic metadata block (title,
  filters, generation timestamp, honest `إجمالي السجلات: 0`), correct 13-column
  Arabic header row.
- **Print (Stock Movements tab) — verified with real captured content**: this
  environment's browser is detected as a mobile print context, correctly
  routing to the in-app fallback modal (not a defect — working as designed
  per `BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A`). The in-app iframe preview
  was inspected directly: correct title, organization branding, filters,
  generation timestamp, honest zero-row output, `dir="rtl"` confirmed on the
  printable document.
- **XLSX export (Executive Overview tab) — verified with real captured
  bytes**: magic bytes `50 4b 03 04` (`PK\x03\x04`, genuine ZIP/OOXML
  signature), MIME type
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 7485
  bytes, real internal ZIP structure (`[Content_Types].xml`, `_rels/.rels`,
  `xl/worksheets/sheet1.xml`).

## Reports (screen 9)

- All 6 tabs present: Summary, Low Stock, Missing, Comparison, **Global
  Material Search**, Audit Log.
- **Global Material Search confirmed reachable** for the super_admin role,
  correctly labeled "متاح للمشرف العام فقط" (super_admin-only), with correct
  filters and rate-limiting notice.
- Zero console errors.

## Monthly Inventory Position (screen 20)

- Loads cleanly, correct empty state ("لا يوجد تقرير مفتوح حاليًا" / start a
  new cycle). Did **not** click "إعداد الموقف" (Prepare position) — that
  action writes a real record and is out of scope for read-only verification.
- Zero console errors.

## Not yet verified (next pass)

- Drill-down/export row parity when real non-zero data exists for a
  filter/org combination (all combinations tested so far had genuinely zero
  matching rows — an honest empty state, but not yet a populated-state proof).
- Print output specifically for the DIRC official-report / other
  surfaces' print buttons (only the Stock Movements print path was tested).
- Live-vs-snapshot correctness (Official Report Library snapshot creation is
  a mutating action — needs a disposable-fixture test, not this session).
- Organization and role scoping across different roles (this session is a
  single super_admin session — cross-role verification needs disposable
  Postgres fixtures per the agreed strategy, not this authenticated session).
- Desktop vs. mobile viewport layout comparison.
