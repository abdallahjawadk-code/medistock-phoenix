# P3-C1 — annual material source witnesses

## Purpose and boundary

An employee reviewing an annual material needs to see where its recorded identity
values came from, next to the existing material-change history. C1 adds that
read-only view to the current annual editor. It uses the existing
`listAnnualCatalogOccurrences` service and its validation contract.

This slice adds no SQL, upload, original-file download, quantity import, allocation,
stock operation, deletion, or year-copy command. The previous annual page remains.
P1, A1 and B candidates and historical migrations retain their accepted bytes.

The implementation is prepared for draft review. Hosted activation and acceptance
remain separate from local component and service verification.

## Employee view

- Each source entry identifies the filename, worksheet and spreadsheet row.
  Row numbers shown to the employee are one-based; supplied A1 cell addresses
  remain unchanged.
- Source classification and proposed classification have different labels.
- The nine source fields remain distinct, including national code, current national
  code and previous national code. Leading zeroes and source unit text are preserved.
- A value, an unmapped field, a missing cell, a blank cell, empty text, and invalid
  content have explicit presentations. Formula evidence is displayed as text and
  is never evaluated.
- Cell/header evidence and parser, mapping and SHA-256 metadata are available
  through expandable details. Filenames and cell values are rendered as text;
  they do not become HTML or download links.
- The view states that the system has not verified the recorded witnesses against
  the original file. The existing `client_attested` contract does not establish
  possession of original bytes, trusted extraction, or an approved legal identity.
- The reader supplies no uploader identity or upload time. C1 does not infer those
  from the current account or from an employee recorded in material-change history.

## Read lifecycle and isolation

The data scope remains the catalog owner, planning year and annual material.
The component context additionally includes the actor and parent workflow context;
beneficiary changes reset the view but do not partition the catalog source query.
A keyed inner component clears the previous scope before it can paint, and request
and unmount fences discard obsolete successes, errors and completion updates.

Reads request 25 entries at a time. The existing adapter validates scope, item,
strict cursor ordering and a server-supported size of at most 50. Only the returned
cursor drives the next read. The displayed count describes loaded witnesses,
not the number of unique materials or a complete catalog of the year.

An empty state requires a successful first read. Initial failure has its own retry
and is never converted into an empty source list. A failed next-page read retains
the earlier entries and its cursor, with an explicit retry of that page. A failed
reload retains earlier entries with a stale-read warning; the first-page reload
must succeed before paging can continue. No read retry resubmits a write.

Refreshing sources does not reset unsaved editor fields or the reason, and does
not change historical employee attribution or a saved need's immutable binding.
Source reading remains available when the annual editor is read-only, subject to
the existing server read authorization.

## Verification scope

The bounded verification covers pagination, initial/reload/next-page failures,
late responses across actor/owner/year/item contexts, preserved source states,
and integration with unsaved edits and historical attribution. Actual browser
inspection uses real components with explicitly synthetic services; it proves
rendering and supported interactions only.

The preceding local P3-B rendered acceptance required fixing editor grid overflow,
stacking narrow annual action groups and replacing secure-context UUID calls in
the test fixture with a synthetic-only generator. The exact managed proxy hostname
was admitted temporarily in an isolated QA configuration. That configuration is
excluded from the review commit and is not a wildcard or authentication change.

Hosted database behavior, authentication, RLS and persistent writes are not
established by these synthetic browser checks. C2 must provide a separately
reviewed contract for stored originals before the product offers that capability.
