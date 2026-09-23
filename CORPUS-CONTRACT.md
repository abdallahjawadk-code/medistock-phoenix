# CORPUS-CONTRACT.md — Annual Needs real-corpus evidence chain

Owner task: "Simple Annual Needs — Corpus Contract + Local Implementation".
Authoritative master: `cee31ef586ae79c174f9d8306e7fce00649358cd` (tree `854703c5bc1e3d937a71e0c636b3302787ca4b4c`), verified fresh against `origin/master` and the local commit object before this analysis ran.

Archive under audit: `"احتياج 2026.zip"`, verified SHA256 `b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2`, byte size `942720`.

All figures below were **re-measured fresh** for this task by running the exact production parser contract (`replayArchive()` in `src/features/central-needs/import/node-replay.ts` — the same CN-2A shared core the browser Worker runs, per its own documented runtime-parity guarantee) against the verified archive. No figure here is carried over from an earlier task's report. Raw measurement scripts and JSON outputs are in the evidence bundle (`D:\phoenix-evidence\ANNUAL-NEEDS-SIMPLE-UX-LOCAL-20260917\`), never in this repository.

## 1. Structural counts

| Metric | Value |
|---|---|
| Archive entries total | 71 |
| Accepted workbooks | 57 |
| Rejected workbooks | 0 |
| Excluded entries | 14 (8 lock files, 6 directories) |
| Aggregate sheet count | 75 |
| Empty sheets | 4 |
| Hidden sheets | 9 (8 hidden-but-non-empty) |
| Workbook family: `individual_institution_annual_needs` | 52 |
| Workbook family: `all_institutions_annual_needs` | 5 |
| Parser diagnostic `DUPLICATE_HEADER_TEXT` | fired 51 times |

## 2. Material — evidence vs. authority

The material text in a workbook cell is evidence only. Canonical material authority is, and remains, the existing `central_needs_record_mappings` disposition (`setRecordDisposition`), keyed one row (`targetEntity = sheet:{i}:row:{r}`) at a time. No second material-mapping system was introduced. `CentralNeedsDispositionTable.tsx`'s own header note already states the operative rule precisely: *"it never pre-selects, guesses or infers [a mapping] from the shape of the row... a subtotal line and a medicine line look identical to it, which is the honest state of the evidence."* Simple Mode's material card (`SimpleMaterialCard.tsx`) follows the same rule and shows every non-empty field of a row as evidence rather than fabricating a single "material name" — see §4 for why picking one field by header text is not currently safe for this corpus.

`SimpleMaterialCard` extends the codebase's existing "exact match, never fuzzy" discipline (already used for institutions) to materials: an **exact, trimmed** name match against `central_items.name` is offered as a *suggestion*; there is no automatic persisted decision, and a row with no exact match has no suggestion at all — the same as current Advanced Mode, which has never attempted material suggestion.

## 3. Unit column discovery — freshly classified per sheet

Every accepted sheet was classified by scanning `usedRange.startRow`'s own header cells (the row the current parser's `buildSourceRecords()` actually uses to assign `fieldName`) for an exact, case-insensitive match against `unit | units | uom | الوحدة | وحدة | وحده | الوحده`.

| Classification | Sheets |
|---|---|
| `EXPLICIT_NAMED_UNIT_COLUMN` | **0** |
| `DETERMINISTIC_UNNAMED_UNIT_COLUMN` | **0** (no structural proof found for any sheet) |
| `AMBIGUOUS_UNIT_SOURCE` | 0 |
| `NO_UNIT_SOURCE` | 69 |
| `NON_DATA_SHEET` | 6 |

**Zero sheets, out of 75, expose a unit column the current parser's own `fieldName` output can identify.** This is not because the corpus lacks unit information — it is present — but because of the structural defect documented in §4.

### 3a. C3 re-measurement (2026-09-22) — the unit evidence that IS there, and why it still cannot be read automatically

The table above measures one specific thing: an exact unit-word match against `fieldName`, i.e. the header-row text. C3 re-measured the corpus against `fieldName` **and** the B2 `columnHeaderEvidence` candidates, which matters for anyone tempted to "just detect the unit column":

| Header label carrying a unit word | Physical columns | Really a unit of measure? |
|---|---|---|
| `وحدة القياس` | 73 (19 of them have a `col:N` fieldName — the label sits on another row) | yes |
| `Measuring unit` | 5 | yes |
| `UNIT` + `DOSE` (two-line header) | 3 | yes (dose unit) |
| `UNIT` | 1 (its `fieldName` is `col:N`, so the exact-match rule never sees it) | yes |
| `وحدة قياس`, `وحدة القياس /العبوة` | 2 | yes |
| **`وحدة المناعة`, `وحدة الهرمونات`** | **19** | **NO — laboratory DEPARTMENTS** |

Those columns hold 7,262 non-blank values across **326 distinct strings**, including case variants (`pcs`/`PCS`/`Pcs`), abbreviations (`doz`, `Doz.`), compound descriptions (`vial or ampoule`, `(1ml vial)concentrated`) and the value `0` (108 times).

The fail-closed conclusion of §3/§4 therefore stands, and C3 adds the reason it must stay: a "contains وحدة" rule would read 19 department columns as units of measure, and free-text values in 326 variants cannot be mapped onto the 8-value canonical vocabulary without inventing meaning. Source unit remains evidence; the approved unit remains a human election. C3 closed the two places where that separation leaked in the UI: the need-line editor no longer preselects `box` (a new line cannot be saved until a human elects a unit or declares `conversion_required`), and Simple Mode now labels a catalog item's own unit as the CATALOG unit instead of "the approved unit in the system".

## 4. Parser/import contract finding — REPORTED, not worked around

Per the owner task's instruction ("If a parser/import contract defect is discovered: REPORT IT. Do not expand scope silently"), this finding is reported here and **no change was made to any parser/replay file** (`parser-core.ts`, `archive-core.ts`, `contract.ts`, `node-replay.ts`, `node-inflate.ts`, `browser-inflate.ts`, `worker.ts` are byte-identical to master).

`buildSourceRecords()` (`parser-core.ts`) assigns every column's `fieldName` from the single row `sheet.usedRange.startRow`. A structural proof scan of this real corpus (grouping each sheet's columns by the *earliest* row, within `usedRange.startRow .. +4`, on which that specific column carries a string-valued cell) found:

- **32 of 71 sheets checked (~45%)** have columns whose real header text sits on a **different row** than `usedRange.startRow` — not wrapped/continuation text, but genuinely different columns with different own-header-rows (example: a sheet where 5 columns' real headers are on row 0 and the other 15 columns' real headers, including a literal `"UNIT"` cell, are on row 1).
- In several of these sheets the row‑0‑anchored parser recovers headers for only a **small minority** of columns (e.g. 5/50, 1/42) while the **majority** of columns — including, where present, the unit column — fall back to the generic `col:N` field name and the true header text is instead ingested as an ordinary (mislabeled) data value on the row directly below.
- This independently corroborates the parser's own `DUPLICATE_HEADER_TEXT` diagnostic, which fires on 51 of the 57 accepted workbooks — consistent with mirrored header labels across the two column regions this same layout produces.
- Separately, where the word "unit" does appear on the sheet, it is frequently **embedded inside a long free-text material description** (e.g. "...15000 Units per vial dry powder...") rather than in a discrete unit column at all — meaning even a corrected header-row assignment would not, by itself, guarantee a clean per-row unit field for every layout in this corpus.

**Consequence for this task:** there is no deterministic, already-proven source-unit rule for any layout family in this real corpus, as currently exposed by the frozen parser contract. Per the owner task's own instruction ("DO NOT solve it by heuristic persistence... mark those records/layouts as needing review"), Simple Mode's material+unit card fails closed: a source unit is shown **only** when a row happens to carry a field whose header is an exact unit-word match (a narrow, honest, structural rule with zero false positives — see `SimpleMaterialCard.tsx`'s `sourceUnitOf()`), and otherwise shows "⚠ تحتاج مراجعة الوحدة" (needs unit review), matching the owner task's own §13 fallback branch. For this corpus, that fallback is the outcome for effectively every record. This is a measured fact about the real archive, not a shortcut.

**Recommended follow-up (separately authorized task, NOT performed here):** teach `buildSourceRecords()` to resolve each column's header from its own earliest-populated header row within a small bounded window, re-running the full CN-2A/CN-2B parity and adversarial test suites. Out of scope here because it touches the frozen parser core, which this task's file scope does not include and which the mission explicitly gates ("Do not change parser/replay core... unless a defect is proven" — proven here, but fixing it is a separate, independently-authorized change).

### 4a. What C3 (contract 1.2.0) did and did NOT change about this finding

C3 was that separately-authorized package. It did **not** promote a second-row
header into `fieldName`: doing so is exactly the inference this document warns
against, and the evidence for it already exists in B2's
`columnHeaderEvidence`, which C3 measured at **468 of the 510 `col:N` columns**
carrying real header text on another row. The header-band text is still emitted
as ordinary data (520 evidence cells across 29 rows in 29 sheets), and a human
dispositions those rows — fail-closed, never a silent quantity.

What C3 did change is the header predicate itself: `fieldName`,
`duplicateHeaderGroups` and `columnHeaderEvidence` now share one rule, so a
header cell must be a string carrying at least one VISIBLE character. This
closed two real defects — an invisible-only header (zero-width space, RLM, word
joiner) used to become a field name, and an error or date cell used to name a
field from text that is not header text — and it aligned the duplicate
diagnostic with the fieldName rule. On this corpus that moved exactly one
figure: `DUPLICATE_HEADER_TEXT` **51 → 50**, because two single-space headers
(`" "`, at A1 and AQ1 of sheet `المجرد` in `من 42 تشخيصية 2026 مواد!.xls`) are no
longer "duplicate header text". Both columns already produced `col:0`/`col:42`,
so no field name changed. Every other figure in this document is unchanged, and
§6's quantity rule is untouched.

## 5. Beneficiary column — unaffected by the header-row finding

M213's column-identity model keys a beneficiary decision on `(importSessionId, sheetIndex, columnIndex)`, read from `source_provenance`, never from header text as authority. Because this identity is a physical **position**, not a label, it survives the header-row ambiguity in §4 without modification. `SimpleInstitutionCard.tsx` reuses `exactMatchSuggestion()`, `mappingFor()` and `reasonRequiredFor()` verbatim from `CentralNeedsBeneficiaryColumnPanel.tsx` (now exported, unchanged in behavior).

## 6. Quantity-cell rule

Quantity values themselves are captured correctly regardless of §4's header-row issue — the coordinate, session, and exact raw value of every cell are unaffected; only the associated `fieldName` label may be generic (`col:N`) instead of meaningful for the columns described in §4. Exact-decimal handling, `sourceRecordId` lineage, and `NeedLineQuantitySource`/`NeedLine` semantics in `central-needs.service.ts` were **not modified**. Simple Mode never computes or persists a quantity total — see §7.

## 7. Hard boundary honored

No file under `src/features/central-needs/simple/` calls `setNeedLine` or `deleteNeedLine` (enforced by an automated static test, see `simple-mode-static-contract.test.ts`). The "اعتماد الكميات كما وردت في Excel" action is rendered but permanently disabled in this build (a bare `disabled` attribute, not state-gated) pending a separately authorized task once §4's contract is resolved.

## 8. Known scope limitation (open finding, not fixed here)

`records`/`dispositions` loaded into `CentralNeedsScreen` (and therefore into Simple Mode) are scoped to the currently active **import session**, matching current Advanced Mode behavior exactly. A single finalize-import of this real archive produces up to 57 import sessions (one per accepted workbook). A production-ready Simple Mode would need a revision-wide aggregation or session-cycling affordance to show one true "57 institutions, 1,842 materials" summary across every session at once; this task's summary counts are correct **per the currently active session**, matching the existing architecture, and multi-session aggregation is reported here as follow-up work rather than solved silently.
