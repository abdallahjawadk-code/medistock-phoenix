# P1 publication: minimatch security follow-up

## Reason and scope

The first PR #260 CI run (`41173889309`) on published P1 commit
`b115fca1f8d5073c8125d5d0941bebcb2babb71c` stopped the quality job at
`npm audit --audit-level=moderate`. Its native PostgreSQL job passed.
Audit reported GHSA-g3hv-75wg-m249 against minimatch 10.2.5 and twelve
affected dependency nodes. Those nodes do not represent twelve distinct CVEs.
Later quality steps were skipped, not passed.

The advisory covers versions below 11.0.1. No patched version in the 10.x
line was available in the official registry at review. The automatic force
suggestion would change ExcelJS and is not used. This follow-up retains all
direct dependencies, parent versions, scripts, workflows and SQL, and changes
only the existing minimatch consumers' overrides plus the exact lock graph.

## Exact graph change

- `@eslint/config-array`, `eslint`, `@typescript-eslint/typescript-estree`,
  and `readdir-glob` each explicitly select minimatch **11.0.3**.
- The nested `.` override prevents the existing estree child override from
  leaving an older minimatch installed. The brace-expansion pin stays **5.0.12**.
- The lock replaces `node_modules/minimatch` and adds only
  `node_modules/@isaacs/nonrecursive-glob-match` **1.0.3**. No other lock entry
  or root field changes. Both tarball integrity values are pinned in RAC-3.
- RAC-3 keeps every historical graph pin, version exception and serialized
  whole-graph assertion. It inserts the single new key before its recorded
  successor without reordering the historical graph or dropping fields.

## Compatibility boundary

Minimatch 11 is a real major change: its matching engine changes and several
APIs, including `makeRe`, `regexp` and `matchOne`, are removed. The four locked
consumers use the retained constructor, `match` (including partial traversal),
`pattern`, and `minimatch()` APIs. Their Node engine and CJS/ESM entry points
remain compatible with the project's Node 22 runtime.

`minimatch-consumer-compatibility.test.ts` exercises installed-consumer
resolution, real ESLint/config-array discovery and ignores, readdir-glob
globstar/brace/dot/Arabic paths, and estree's real allowDefaultProject boundary.
It does not claim equivalence for every minimatch 10 pattern. Existing ExcelJS
round-trip, export and browser-path guards are included in the targeted checks.

## Verification and retained failures

Before this commit, the targeted compatibility/Excel group passed **67 cases**
with no skips, and the corrected graph returned **zero audit findings**.
Final commit guard/build/CI outcomes belong to the publication evidence and
PR #260, rather than being inferred from these pre-commit results.

Independent source review found that appending the new lock key would break
the existing serialized comparison. That finding was corrected by exact
insertion. A local TypeScript run also found an inferred-key typing error in
the new guard; it was corrected without a broad type cast or rule suppression.
The initial CI audit failure and local first failure remain evidence, not flakes.

This change does not apply the P1 SQL candidate, repair historical conflicted
captures, enable features, retire navigation, or authorize a release.

## Primary sources

- [GitHub reviewed advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Maintainer advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
- [Official minimatch 11.0.3 changelog](https://github.com/isaacs/minimatch/blob/v11.0.3/changelog.md)
- [Upstream 11.0.1 to 11.0.3 changes](https://github.com/isaacs/minimatch/compare/v11.0.1...v11.0.3)
- [npm overrides documentation](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#overrides)
