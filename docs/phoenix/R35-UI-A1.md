# R35 UI-A1 — annual planning workbench and monthly proposal

Baseline: master `d5b6236bbac117077dcb47c71c2c4452ff748510` (PR297). This patch changes the annual-needs composition, not the global shell alone.

## Before / after

| Before | After |
|---|---|
| Annual scope, lines, lifecycle actions and history in one long journey | Common PRISM frame and separate Needs & materials, Review & approval, Revision history tabs |
| Different outer presentation for contract-ready and previous-files paths | Shared frame, typography, context and responsive panels for both paths |
| Monthly proposal represented by a table only | Calendar and detailed-table views, policy provenance, unit step, explicit nonbinding state and exact total |
| Presentation mixed into contract routing | Display-only frame/tabs; existing activation, server-capability and lifecycle logic still owns availability |

Tabs keep panels mounted to preserve typed quantities, outstanding-operation locks and stale-response fencing. They do not load data or invoke writes. The original services, routes, quantity arithmetic, approval decisions and reference validation are unchanged. Previous files remain usable under their historical permissions. No automatic material, quantity or policy creation is added.

## Verification and evidence boundaries

The private owner evidence package contains real BEFORE/AFTER browser captures, 12 annual AR/EN × light/dark × desktop/tablet/mobile cases, 12 monthly component cases, legacy desktop/mobile captures, test JSON and independent source-security review. Screenshots are not uploaded publicly because the app is authenticated.

Local validation: 2,816 affected-scope cases passed after rerunning only initially failed files and corrected negative tests; TypeScript, ESLint and production-mode builds passed. Initial Windows CRLF-sensitive source assertions were checked against an LF checkout equivalent to Linux CI; unrelated files were restored and are absent from the patch. No assertion was dropped. The read-only Staging employee's command-center/statistics refusal remains visible; this is not a claim that every application console path is error-free.

Staging-only browser verification uses the existing R33 employee, owner, beneficiary and material `00012-A-R33` / `box`. A separate `R35 UI-A1` synthetic dossier preserves the previously accepted dossier. Quantity starts blank; `1200` was entered manually, retained across tab changes, saved once and reread after reload. No submission/approval or stock operation was performed. No monthly policy was created: Staging continues to show **Awaiting distribution policy**.

`tools/ui-a1-preview` renders the actual monthly component with a clearly labelled synthetic reference. This is component acceptance, not a real policy or hosted R2 acceptance. Its separate Vite config aliases the Supabase client to a throw-on-use stub and sends `connect-src 'none'`; it is outside the application entry and absent from the application bundle. A static build can be served on loopback with the same network prohibition. It needs no credentials.

Independent review identified and closed two issues: fixture client initialization despite injected readers, and negative permission tests querying a hidden tab. The corrected tests navigate to the relevant visible tab before checking denials. No source authorization bypass was found after corrections.

## Unchanged and not claimed

- No SQL, migrations, RLS/ACL, auth client, feature flags, deployment settings, SEND/RECEIVE, FEFO or A−C/C−D changes.
- No executable R2 approval workflow is introduced. Annual approval does not approve monthly allocation.
- This is not Production backend activation, a full-system acceptance, or completion of W01–W07.
- PR295 remains HOLD; W05 remains 22 NOT_RUN. Independent R35 corpus work is not merged into this branch.
- Production's absent contracts still select the historical path. Preview UI must never be described as activating those contracts.

Rollback is a code revert of this UI-only change; it requires no data migration or flag change. This PR is for review, not authorization to merge or activate Production SQL.
