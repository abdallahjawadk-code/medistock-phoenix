# P3-B — owner instruction and implementation boundary

Owner instruction, 2026-10-31:

> افوضك بالاكمال مع اضافة امكاتية تعديل معلومات الماده مع ذكر السبب مع تثبيت اسم الموظف الذي قام بالتعديل

This authorizes continuing the previously described P3-B journey and adding a reasoned material-information editor with an attributable employee identity. The governing memory is r9, especially §§5–6,13,23. The exact published starting commit is `821e01312c1be7609766d72c04be30dba34b4a76`; its tree is `c293bb94979afeaf0aefbf77bc51759c16f90079`.

## Required outcome

- Explicit owner/year catalog selection, a required beneficiary for each need, and atomic annual item/field-version references in the existing quantity-writing transaction.
- Material information edits have a nonblank reason, an immutable prior/new field version, server-recorded time, and actor ID plus the employee name captured from the trusted profile at the time of the edit. The client cannot supply these attribution fields.
- Editing a yearly display name does not rewrite past records. Proposed identity, strength, form, code or unit changes that differ from the locked lawful canonical record remain explicitly awaiting legal review; they cannot become selectable simply because a browser saved them.
- Canonical registration/review, year isolation, beneficiary scope, append-only historical records, current permission checks and the stock ledger remain authoritative.
- New-year quantities are never inferred from previous years or from selecting a material. Historical events lacking an annual version remain explicitly unbound; no fabricated historical snapshot.

## Execution and evidence

Work uses a separate worktree and a new unnumbered SQL candidate. Historical migrations, the accepted P1 candidate and the accepted P3-A1 candidate are preserved. Database verification runs on a disposable native PostgreSQL target with its existing identity guards. The existing employee journey remains compatible when the new capability is absent; an annual-mode error never silently becomes global catalog search.

No merge or hosted SQL application is authorized by this continuation. Local acceptance, GitHub publication, target activation and a production release are separate recorded outcomes. The public PRISM v10 Site is synthetic design reference material; it is not proof of the P3-B persistence or authorization behavior.
