# P1 — preserve resumable annual-needs workbook captures

## Outcome and boundary

P1 is implemented as an **unnumbered SQL candidate**, with a human-readable
Arabic/English refusal and executable regression coverage. It has been applied
only to disposable local PostgreSQL. It is not a production migration or a
deployed application change.

The source combines PR256 `1db8a46ec5c66018ccda6b8b8c853d50343a36f0` with master
`ef265d0b9745867f3727cafa01d809e0f0fb7e5d`. The resolved integration base tree is
`64f5077b08899412c267f9307eeb531f830595bb`. The single merge conflict was the RAC-3
dependency guard: the solution retains the exact dossier SQL allowlist and one
equivalent Vite 6.4.5 transformation. Both automatically merged manual-needs
components retain the dossier logic and the newer presentation classes.

## Reproduced failure

At M235, a captured workbook reserved a future write plan without creating its
manual events yet. A manual writer could take that scope first. The reproduced
fixture captured **11,520**, then committed a manual **7**. The workbook batch
failed with `manual_need_line_stale`; submission then failed with
`dossier_intake_incomplete`. One manual event remained and no receipt existed.

Review and native experiments exposed three related paths that must be closed
together:

| Path | Why the capture could become stranded |
|---|---|
| Institution total versus warehouse split | M225 permits one representation for a beneficiary/material in a revision. A pending institution total therefore also conflicts with a live warehouse split. |
| Carry-forward into an explicitly opened correction | The generic manual correction RPC can open a named dossier without automatically carrying its predecessor. Carry-forward wrote directly after capture, outside the add writer. |
| An unrelated material claims `intake:<id>:<row>` | Manual add, correct or void could consume a batch's plan-wide idempotency key. The batch subsequently failed with `idempotency_conflict`. |

These were verified in isolated databases with fixture identities and quantities;
they are not assertions about existing production records.

## Authoritative repair

`supabase/candidates/P1_dossier_workbook_reservation_NOT_APPLIED.sql` checks the
exact seven predecessor bodies before any definition changes. The numbered
migrations are preserved.

The add implementation moves to a private, sealed function. The public signature
is unchanged and always passes `false`; the already-authorized batch passes
`true`. API roles and PUBLIC cannot execute the private function. No client flag,
session variable, text prefix or declared reason grants a reservation bypass.

After authorization, the existing plan lock and matching replay check, a new
manual add refuses an overlapping pending cell. The scope is revision,
beneficiary and canonical item. Workbook rows are institution totals, so their
reservation covers conflicting warehouse splits too. A receipt releases only
its own 100-row batch; the first 100 completed rows are not frozen because the
last five remain pending.

Capture symmetrically refuses a live warehouse projection. It retains the old
refusal of any institution-level event chain, including a voided chain, because
the workbook does not silently reset an expected-event fence.

Carry-forward checks its latest non-void source events against pending cells,
under the same existing lock and before its first insert. A conflict rejects
the entire carry. A non-overlapping carry and its existing replay still work;
the predecessor's provenance is not converted into ordinary add events.

All three public manual event writers reserve the `intake:` namespace for new
writes. Matching historical replays remain ahead of this check. The internal
batch continues to use its deterministic keys and atomic receipts.

The existing capability seal includes the private writer and explicitly rejects
an authenticated execute grant. FF2 keeps its closed census of 63 public RPCs,
27 exact public writer bodies and the private implementation body/ACL. Negative
controls prove that body drift and a private execute grant are detected.

## Employee behavior

The normal manual form keeps the employee's typed quantity when the server
refuses the overlapping write. It does not add an optimistic row, retry by
itself or display a success message. Both languages direct the employee to
resume the captured workbook in source history, then edit the saved need if
required. The message is stored in the canonical shared translation dictionary,
so the workspace and journey use the same explanation.

## Verification at this checkpoint

| Check | Result |
|---|---|
| Native PostgreSQL 18.4, READ COMMITTED | 50 passed, none skipped |
| Independent-session ordering cases | 16, using observed blocking backend PIDs; manual/carry × institution/warehouse × first writer × commit/rollback |
| Affected manual UI, services, dossier flow and guards | 302 passed, none skipped |
| Numbering and C5 guards | 54 passed, none skipped |
| TypeScript and Vite production build | Passed |
| ESLint with the repository's established command | Passed |
| Numbered migration source 001..235 | All 235 byte-identical to PR256 |
| package.json, package-lock.json and FF1 | Unchanged |

The build reports existing ExcelJS chunking and bundle-size warnings. No
dependency version, application flag, permission default, stock movement,
navigation destination or year-allocation policy changes are part of P1.

The compact machine-readable checkpoint is
`docs/phoenix/evidence/P1-WORKBOOK-RESERVATION-20261031.json`. Independent source
review verified the before/after function bodies and all FF2 pins. Local native
tests do not attest hosted Auth, PostgREST, production data or remote CI.

## Recovery and release

The new guards prevent new conflicts. They do **not** repair already-conflicted
captures, replace their source quantities or advance their expected event IDs.
Such drafts retain the existing governed whole-draft withdrawal path, including
the distinct authorized actor requirement; no single-workbook evidence deletion
or automatic recovery exception is introduced.

Before promotion, inspect the intended target's actual migration history, body
pins, active/pending captures and authorization surface; prove the hosted
transport and recovery requirements on that target. Assign any forward migration
number only after that history is known. The P1 candidate and FF2 are separate:
FF2 contains writers during an incident and does not repair the reservation bug.

The next product work remains the governing-memory sequence: the annual catalog
and unified needs workspace, with year isolation and required beneficiary scope.
No page retirement is bundled into this repair.
