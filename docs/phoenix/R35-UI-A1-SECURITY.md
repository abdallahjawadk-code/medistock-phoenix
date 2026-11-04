# R35 UI-A1 — independent security review

Reviewer: separate read-only review agent. Baseline: `d5b6236bbac117077dcb47c71c2c4452ff748510`. Reviewed local working diff on 2026-11-04; not an immutable released SHA. No application files or hosted services modified by this reviewer.

## Verdict

**PASS_SOURCE_SECURITY_REVIEW — scoped to the reviewed UI diff.** No newly introduced authorization bypass found. Both review findings below are closed by inspected code corrections. Release acceptance still requires passing the implementation agent's final tests and preview checks; this verdict is not Production activation authorization.

## Findings closed after independent reinspection

1. **Preview network isolation (medium):** `tools/ui-a1-preview/main.tsx` imports the actual `MonthlyProposalPanel`, whose default service transitively imports `src/shared/supabase/client.ts`. Supplying a synthetic `readReference` prevents the explicit policy RPC but does not prevent real client initialization when VITE Supabase credentials are inherited. Auth session detection/refresh can then communicate with a hosted database. The fixture's “No hosted reads or writes” claim needs a fixture-only exact module alias to an inert throw-on-use Supabase stub and `connect-src 'none'` CSP. Do not change the production client.

   **Closed:** `tools/ui-a1-preview/no-hosted-client.ts` now has a type-only SDK import, exports `supabaseConfigured = false`, and throws on every proxy access. The fixture Vite config resolves the exact `@/shared/supabase/client` alias before the generic `@` alias, binds to loopback, disables HMR, and sets `connect-src 'none'`. The production client remains unchanged. This prevents client creation as well as network calls through the fixture. The synthetic fixture is not imported by the application entry.

2. **Negative permission test visibility (medium):** tests querying absence of Approve/Reject while the Review tab is hidden, or absence of entry controls while the Entry tab is hidden, no longer prove capability enforcement. Affected examples: `manual-needs-journey.runtime.test.tsx` maker/no-approve/entrant tests and `forbiddenEntry`; `annual-needs-journey.runtime.test.tsx` wrong canonical-label approval denial. Open the relevant tab before each negative assertion (or use a justified hidden-inclusive query). Keep the assertions; do not weaken them.

   **Closed:** manual tests use `queryReviewControl`, which explicitly selects Review before querying forbidden decision controls. `forbiddenEntry` selects Entry before checking entry controls and then selects Review for readiness/submission absence. The annual wrong-canonical-label denial now opens Review before asserting Approve is absent. Existing denial expectations remain intact. Targeted rerun results belong to implementation evidence; this reviewer did not rerun the suites.

## Verified boundaries

- `AnnualNeedsEntryScreen` retains activation and contract checking/absent/failed routing; presentation does not authorize modern writes.
- `ManualNeedsJourney` retains existing handlers and `caps`, `approveExcludedForRevision`, `identitiesReady`, status and `controlsBusy` gates.
- `NeedsWorkspaceTabs` renders stable-key mounted panels, changing only hidden state and keyboard focus. No API calls or extra write behavior are introduced by tab selection.
- `MonthlyProposalPanel` retains reference-context fencing and the existing calculation function; numeric rows still require a ready proposal and reference. Missing policy/failure do not produce numeric allocations. No monthly approval action was added.
- No substantive service, SQL, migration, RLS/ACL, authentication, stock movement, SEND/RECEIVE, FEFO, production configuration or feature-flag change appears in the reviewed application diff.
- Legacy heading duplication reported earlier is corrected: frame h1, inner Simple/Advanced h2.
- Existing tests were adapted to navigate new tabs/table view rather than replacing expected permission outcomes; the negative-query corrections above preserve meaningful capability denial checks.

## Evidence limits

This is source-level review, not independent hosted RLS/ACL execution or approval of Production activation. Staging interactions and test-run totals are supplied by the implementation agent and must be cited from its evidence artifacts. The monthly synthetic fixture is component acceptance only, not proof of a real approved monthly policy or R2 executable approval workflow. A−C/C−D, SEND/RECEIVE and FEFO remain unchanged; their full operational acceptance is not established by this visual batch. PR295 remains HOLD; W05 remains 22 NOT_RUN.

## PR298 browser-test follow-up

Reviewed only `tests/simple-annual-needs.visual.test.ts` and `tools/e2e-acceptance/monthly-proposal-ui.mjs` after CI exposed old selectors. The heading adaptation correctly asserts one frame h1, zero inner h1 and one inner h2; no accessibility assertion was removed. Opening Detailed table before retaining the existing exact quantity, nonbinding and no-approval assertions matches the new default calendar UI without weakening those guards.

One new assertion initially expected twelve calendar rows, which conflicts with this E2E policy's fixed January and eligible February/April/June. The unchanged proposal algorithm returns exactly months 1, 2, 4 and 6. Requested correction: assert that exact month list, preserving fixed January 2.5 and no initial table. Do not manufacture twelve months or change the policy/calculation to satisfy this test. Closure of this test correction is recorded separately after reinspection.

**Closed on source reinspection:** the calendar check now compares the actual `data-month` list exactly with `['1', '2', '4', '6']`, still checks January `2.5`, and still requires no initial table. The pre-existing detailed-table assertions for January `2.5`, February `2.75`, total `10.25`, responsive behavior and no effective approval control remain. No outstanding security-review finding in these two test-only changes. Implementation reports 21/21 legacy visual retest PASS and JavaScript syntax PASS; this reviewer verified source, not those executions. Scoped `PASS_SOURCE_SECURITY_REVIEW` remains valid.
