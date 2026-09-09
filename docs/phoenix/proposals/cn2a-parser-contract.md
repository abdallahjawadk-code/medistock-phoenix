# Central Needs — CN-2A Parser Contract Freeze + Safe Import Engine

Local implementation only (not committed, not pushed, no PR). Base at time of
writing: `f136bc173fd85cf922ec965f1beaed1bd74ea7d4` (tree
`b5b3094d201127c45417e36279b6cd87dfa01e8d`, migration ceiling 209, Production
M209 applied via run `34326395567`). Builds on CN-0C's proven parsing strategy
(`D:\cn0c-work\REPORT.md`: `LEGACY_XLS_STRATEGY_PROVEN = YES`,
`CN2A_GO = YES`) and on migration 209's schema (`docs/phoenix/proposals/209-central-needs-registry.md`).

## 1. What CN-2A is

A shared, isomorphic parser core (`src/features/central-needs/import/`) that
turns an XLS/XLSX/CSV file — standalone or inside a ZIP archive — into
deterministic, JSON-serializable evidence shaped to become a future
`central_needs_source_records` row's `source_values`/`source_provenance`
(migration 209) once CN-1B ships the RPC that persists it.

CN-2A does not:
- open a database connection or call Supabase in any way;
- create or apply a migration;
- write to `warehouse_stock`, any movement ledger, `inventory_transfer_suggestions`,
  or any RBAC/authorization table;
- wire itself into any screen or route (no UI surface exists for it yet — the
  same "architecture only, nothing wired in" boundary CN-0C found before this
  work, now filled in for the parsing layer specifically, still not for
  upload/staging/RPC);
- persist a manual correction — that is CN-1B's override RPC
  (`central_needs_field_overrides`); this contract only documents the shape
  (`FieldOverrideDraft`) a future override would take.

## 2. File layout

```
src/features/central-needs/import/
  contract.ts        — frozen types (this document's source of truth)
  parser-core.ts      — shared pure parsing core (SheetJS only used here)
  zip-reader.ts        — pure, isomorphic ZIP central-directory reader
  archive-core.ts       — ties zip-reader + parser-core together
  node-inflate.ts        — Node-only DEFLATE adapter (zlib.inflateRawSync)
  browser-inflate.ts      — browser-only DEFLATE adapter (DecompressionStream)
  node-replay.ts            — Node 22 authoritative replay entry points
  worker.ts                  — browser Web Worker adapter (message protocol)
  __tests__/
    contract.ts tests are exercised indirectly via parser-core.test.ts
    parser-core.test.ts  — determinism, provenance, identity, byte-fidelity
    adversarial.test.ts   — security/resource-limit suite
scripts/
  cn2a-node-replay.ts  — disk-reading CLI wrapper (verification tooling only,
                          not shipped to the app bundle)
```

## 3. Runtime parity — the one documented exception

"One shared pure parsing core" means `parser-core.ts`/`archive-core.ts` are
imported byte-identically by both `node-replay.ts` and `worker.ts`. The single
deliberate difference is the DEFLATE decompression primitive for ZIP entries.
The entire boundary is the injected `Inflate` function type in `zip-reader.ts`:

| Runtime | Primitive | Output bounding |
|---|---|---|
| Node (`node-inflate.ts`) | `zlib.inflateRawSync` | zlib's own `maxOutputLength` |
| Browser (`browser-inflate.ts`) | `DecompressionStream('deflate-raw')` | counts emitted bytes per chunk, cancels the reader on breach |

Both raise the same `InflateOutputLimitExceeded` at the same ceiling, so the
security policy is identical even though the primitive is not. DEFLATE has one
correct output for a given input, so no semantic drift is possible.

**Two separate parity claims, with separate evidence:**

1. **Standalone workbook parity** — a synthetic XLSX (merge, duplicate header,
   formula, cached error, comment-on-blank, real zero) parsed through the real
   browser Worker and through the Node replay adapter produced byte-identical
   JSON after masking `identity.runtime` and `sourceProvenance.extractedAt`.
   (For a standalone `FileParseResult` there is exactly one `identity` object,
   so that mask is complete for this shape.)
2. **ZIP archive parity — verified separately and later.** The first version of
   this document implied ZIP cross-runtime parity was already covered by (1);
   it was not, and that wording was wrong. It has since been verified directly
   against a real ZIP archive containing a workbook plus a directory entry and
   a `~$` lock file (`__tests__/fixtures/synthetic-archive.zip`, a committed
   SYNTHETIC fixture). Both runtimes produced `ArchiveParseResult` documents
   hashing identically to
   `9f8f45badbff4aae00f6ee6784c9effb0e67a8741dd20786c35bad717e85eca6`
   (8,025 masked bytes). Masks: `identity.runtime` at the archive level **and
   at each nested per-file result**, plus `sourceProvenance.extractedAt` —
   nothing else. Filenames, SHA-256 fingerprints, entry classifications
   (directory/lock-file exclusions), reconciliation counts, diagnostics and all
   workbook semantic content were compared verbatim.
   *A note on how that was reached honestly:* the first comparison run reported
   FAIL with a 10-byte delta. Investigation showed the cause was an incomplete
   mask on my side — the nested per-entry `identity.runtime` was not masked
   (`"browser_worker"`, 16 bytes, vs `"node"`, 6 bytes = exactly 10). The mask
   was corrected on both sides and the comparison then passed. The parser was
   never at fault, but the failure was real and is recorded rather than
   quietly re-run until green.

Reproduce with `scripts/cn2a-zip-parity-node.ts` (Node side) and
`scripts/cn2a-browser-evidence.html` served by the dev server (browser side).

## 4. Determinism

- Archive entries: ZIP central-directory order, post-filtering.
- Sheets: native workbook tab order.
- Cells: only non-`missing` presence, row-major (row asc, then col asc).
- Merged ranges: lexicographic by A1 string.
- Two parses of byte-identical input produce byte-identical JSON except the
  two fields named above.

## 5. Three-way cell presence (never collapse)

`missing` (coordinate never visited) / `blank` (a cell object exists but
carries no value — e.g. a SheetJS `t:'z'` stub anchoring a comment) / `value`
(a real value, which may itself be the number zero — zero is always `value`,
never `blank`). Verified against the real corpus: `numericZeroCellCount`
45,009, `explicitBlankCellCount` 31,824 — both matched CN-0C's golden figures
exactly (see verification report).

## 6. Errors, formulas, comments — never coerced, never evaluated

An error cell (`#VALUE!`, `#DIV/0!`, etc.) keeps `valueType: 'error'` and its
error-code string as `rawValue` — never 0, never null. A formula cell keeps
its cached result AND its verbatim formula text; this parser calls
`XLSX.read` with default (non-evaluating) options and never calls a formula
engine. `cellHTML: false` is fixed in `parser-core.ts` regardless of caller,
so `cell.h` is never populated and injection-like text (`javascript:...`,
`=cmd|...`, `<img onerror=...>`) is stored byte-identically as a plain string,
never rendered. Verified against the real oncology file
(`سرطانية 2026 مجرد.xls`): all 21 `#VALUE!` formula-error cells preserved as
errors (CN-0C's own named requirement), reproduced exactly by this
independently-written implementation.

## 7. Resource limits (`DEFAULT_PARSER_LIMITS` in contract.ts)

There are three distinct enforcement stages. Conflating them was a real defect
in the first version of this work and is called out here deliberately.

**(a) Pre-parse raw input ceiling — `maxStandaloneInputBytes` (64 MiB).**
Enforced on raw byte length at the very top of `parseWorkbookBytes`, before
magic sniffing and before `XLSX.read()` is handed anything. This exists because
the row/column/cell ceilings are *post-parse* bounds — by the time they run,
SheetJS has already materialised the whole workbook in memory, so they provide
no protection at all against a huge raw standalone input. This is a
security/resource policy, not a corpus-derived business rule: the largest real
corpus workbook is ~0.5 MB (CN-0C §7 benchmark), so 64 MiB leaves ~2 orders of
magnitude of headroom while still bounding a single parse.

**(b) ZIP DECLARED-metadata preflights.** Entry count, per-entry declared
uncompressed size, aggregate declared uncompressed size, and compression ratio
are checked against the central directory *before* an entry is decompressed.
These operate on attacker-controlled metadata and are therefore a cheap first
filter only — **they are not bomb protection**, because a bomb simply lies.

**(c) ZIP ACTUAL inflated-output ceiling — the real bomb defence.**
`maxZipEntryUncompressedBytes` is enforced a second time on the *actual* number
of bytes produced, inside the decompressor itself (Node: zlib
`maxOutputLength`; browser: per-chunk byte counting with reader cancellation).
The ceiling handed to the decompressor is always the policy limit, never the
entry's declared size. On top of that, actual inflated length must equal the
declared length or the entry is rejected (`ZIP_INFLATED_SIZE_MISMATCH`), and
CRC-32 verification is preserved. Distinct diagnostic codes keep the stages
separable: `ZIP_UNCOMPRESSED_SIZE_LIMIT_EXCEEDED` (declared) vs
`ZIP_INFLATED_OUTPUT_LIMIT_EXCEEDED` (actual).

Verified with a genuine DEFLATE bomb, not a STORE-method fixture: 8 MiB of
zeros compressed to ~8 KB, with the central directory declaring only 1,024
uncompressed bytes so that *both* declared-size and compression-ratio
preflights pass cleanly. The entry is rejected with
`ZIP_INFLATED_OUTPUT_LIMIT_EXCEEDED`, and the test asserts the two preflight
codes are *absent* — so it cannot pass for the wrong reason. Both runtimes were
exercised: Node via `adversarial.test.ts`, browser via
`scripts/cn2a-browser-evidence.html` (8,157 compressed bytes aborted at a
64 KiB ceiling with `InflateOutputLimitExceeded`). Each has a positive control
proving the same stream inflates fully when the ceiling permits (4 MiB and
8,388,608 bytes respectively), so the abort is demonstrably the ceiling firing
rather than a decompression failure.

**Timeouts.** `parseTimeoutMs` is a contract value for the **host page's own**
`worker.terminate()` timer, not something `parser-core.ts` enforces internally:
a pure synchronous function cannot self-interrupt on a timer (matches CN-0C's
own finding re: Worker self-interruption). The row/column/cell-count ceilings
are the actual bounding mechanism inside the parse. Verified: a hand-built
OOXML declaring ~700 columns × ~1,000,000 rows but writing one cell is rejected
with `SHEET_DIMENSION_LIMIT_EXCEEDED` in under a second on the read side.

## 8. Family detection — best-effort, not authoritative

`detectFamily` in `parser-core.ts` is a documented heuristic (non-empty sheet
count + an institution-header-text hint), not a proven classifier: CN-0C's
corpus was not labeled by family, so no ground truth existed to validate
against for this task. `FamilyDetection.confidence` is capped at 0.75 and
every non-`unknown` result carries `evidence` strings explaining the signal.
This is flagged explicitly as the least-verified part of this contract.

## 8b. Continuation rows — status: DEFERRED (stated, not silently absent)

CN-2A does not group continuation rows into a single logical record; every row
is its own `targetEntity`. Deciding that row N continues row N-1 requires
knowing the family's key column, which is the same per-family business-semantics
gap flagged in §9 — guessing it would bake an unvalidated rule into frozen
evidence. Deferring is safe because everything needed to derive the grouping
later is already preserved coordinate-exactly: merged ranges, the three-way
`missing`/`blank`/`value` presence distinction, and exact row/column indices on
every cell. A later package can group continuation rows from stored evidence
without re-parsing, and without CN-2A having collapsed anything first.

## 9. Source-record generation — a generic mechanism, not business semantics

`buildSourceRecords` emits one `SourceValueRecordDraft` per non-header,
non-blank data cell: `targetEntity` is a stable `sheet:{index}:row:{row}`
logical id, `fieldName` is the header-row text at that column (or `col:{n}`
when no header text exists). This satisfies "source_values and
source_provenance compatible with M209" and "normalized records without
database persistence" as a structural mechanism. **What it deliberately does
not do**: map real annual-needs business fields (item name vs. quantity
requested vs. unit of measure, etc.) to specific semantic meaning — M209's own
proposal doc states "the real parser output contract lands in CN-2A" for the
*structural* contract, but assigning business meaning to each corpus family's
actual columns is a larger effort than this contract-freeze pass could
honestly complete against real workbook content without deeper, per-family
domain analysis. Recorded here as an explicit scope boundary for CN-1B/a
follow-up CN-2A increment, not silently left unstated.

## 10. What was verified, and how (see the accompanying verification report for full evidence)

1. **Real 57-workbook corpus replay** — all 12 of CN-0C's golden aggregate
   metrics (sheets, hidden sheets, hidden-nonempty, empty, merges, formulas,
   cached-formula split, numeric zeros, comments, explicit blanks) matched
   exactly, plus the exact 71/57/14 file/accept/exclude breakdown, on the
   first real run of freshly-written code (not copied from CN-0C's harness).
2. **Named coordinate-level checks** — the oncology file's 21 `#VALUE!`
   cells and the one documented comment-on-blank-cell case (kirkh/madina file,
   cell I1) both reproduced exactly.
3. **Contract + adversarial test suite** — 22 vitest tests, run under the
   pinned Node 22.23.2 toolchain: determinism, provenance, byte-fidelity,
   bad-magic rejection (both a genuinely-non-text binary blob and confirming
   plain ASCII text is correctly treated as a CSV candidate, not bad-magic),
   truncated-container handling, corrupted-record-stream non-crash, VBA
   detection, injection-text safety (`cell.h` never populated), oversized-
   dimension rejection, ZIP path-traversal/absolute-path/symlink/entry-count/
   bomb-ratio/oversized-entry rejection, lock-file (`~$`) and directory
   exclusion, and a well-formed small ZIP accepted end-to-end.
4. **Real bugs found and fixed during this work, not silently patched over**:
   (a) the original magic-byte "CSV candidate" heuristic checked only for a NUL
   byte, which is actually valid UTF-8 and would have accepted some binary
   garbage as a CSV candidate — fixed to require strict UTF-8 validation of the
   probe; (b) an early version of the oversized-dimension adversarial test
   constructed its fixture via SheetJS's own writer with a post-hoc `!ref`
   overwrite, taking ~530 seconds to serialize — replaced with hand-built
   minimal OOXML, which also proved the real read-side dimension check
   completes in under a second.
   **(c) Found by independent review, not by me: the ZIP decompression-bomb
   defence was inadequate.** The original code checked only the central
   directory's *declared* uncompressed size and compression ratio before
   inflating, then called `inflateRawSync` with no output ceiling — so an
   archive that simply lied about its declared size could expand without bound.
   Fixed by enforcing the ceiling on *actual* inflated output inside both
   decompressors, adding declared-vs-actual reconciliation, and adding distinct
   diagnostic codes (§7). The original "bomb" test used a STORE-method fixture
   and therefore only ever exercised the declared-size preflight; it has been
   renamed to say so and replaced by a genuine DEFLATE bomb test.
   **(d) Also found by independent review: standalone inputs had no pre-parse
   size ceiling** — the row/cell limits are post-parse and cannot protect that
   stage. Fixed with `maxStandaloneInputBytes` (§7a).
5. **Repository gates** under the pinned Node 22.23.2 toolchain: `npm ci`,
   `npm audit --audit-level=moderate` (0 vulnerabilities before and after
   vendoring SheetJS), `npm run typecheck`, `npm run lint` (one genuine
   unused-import warning found and fixed), `npm run build` (clean; `xlsx`
   does not reach the production bundle because nothing in `src/` outside
   this feature imports it yet — consistent with CN-0C's own 0-byte finding,
   confirming this work did not accidentally wire the feature into a
   reachable code path), and the full existing non-DB test suite.

## 11. SheetJS identity (pinned, never the npm registry's stale 0.18.5)

- Version: `0.20.3`
- Source: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (authoritative
  upstream origin of the pinned tarball).
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- **Vendored inside this repository** at `vendor/sheetjs/xlsx-0.20.3.tgz`,
  installed as `"xlsx": "file:vendor/sheetjs/xlsx-0.20.3.tgz"`. This is a
  repository-relative path with no dependency on any sibling or parent
  directory outside the checkout — a fresh clone/CI checkout/Vercel build is
  self-contained for this dependency. (An earlier revision of this repair
  referenced `file:../sheetjs-vendor/xlsx-0.20.3.tgz`, a path one level above
  the repo root that exists only inside the specific local disposable
  workspace this feature was developed in; that reference could never resolve
  on a fresh checkout — confirmed as the exact cause of PR #194's GitHub
  Actions and Vercel install failures — `ENOENT` opening
  `/home/runner/work/medistock-phoenix/sheetjs-vendor/xlsx-0.20.3.tgz`, one
  directory above the checked-out repo. Fixed by vendoring the byte-identical
  artifact into the repository itself.) The bytes are unchanged: the SHA-256
  above was independently re-verified against both the original CN-0C source
  cache (`D:\cn0c-work\sheetjs-vendor\xlsx-0.20.3.tgz`, read-only, historical
  evidence) and the copy now committed at `vendor/sheetjs/xlsx-0.20.3.tgz`,
  and both matched the pin exactly before the copy was trusted.
- License: Apache-2.0. Obligations unchanged from CN-0C's assessment (LICENSE
  present, attribution headers untouched, package vendored unmodified, no
  NOTICE file ships upstream for this version). This artifact is a public
  third-party npm package tarball, not workbook corpus data.
