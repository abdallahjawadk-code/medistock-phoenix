# C3 internal XLSX admission, separate from the legacy parser

Standalone XLSX previously reached SheetJS after only compressed-input and worker limits. V8 worker limits exclude external ArrayBuffer allocations, and the pinned SheetJS reader uses local ZIP size/ZIP64 claims before reconciling them with central-directory claims. This is a blocker before enabling C3 layouts; the deployed empty registry remains unavailable before reading or parsing any retained source.

`workbook-preflight.ts` adds a C3-only check before either accepted parser pass. Content-based ZIP detection also covers renamed files. A captured byte snapshot is hash/size checked, admitted and then used unchanged for both layout recognition and extraction. The CN2A parser, ZIP reader, contracts and earlier source semantics are unchanged.

C3 admits at most 3 MiB input, 1,000 ZIP entries, 8 MiB expanded per entry, 32 MiB aggregate expansion and a 300:1 ratio. These are explicit resource-admission limits, not a claim that all valid workbooks fit. Excess, unsupported ZIP64/multidisk forms, local/central size/method/flag disagreements, descriptor inconsistencies, directory payloads, overlaps, traversal, duplicates, CRC failures and malformed bounds remain held without truncation. Existing `readZipSafely` plus bounded `nodeInflate` independently checks actual inflated output, length and CRC. Expanded preflight entries are discarded before parsing.

The negative control demonstrates that the old central-only reader safely accepts a small real payload despite a huge inconsistent local allocation claim, while the new C3 admission rejects it without invoking SheetJS. Tests also include an actual compressed payload whose two declared size claims lie, descriptor-based ZIP, actual XLSX and parser-routing/source-snapshot checks. No process OOM experiment or hard whole-process memory guarantee is claimed.

Real corpus regression must reuse the frozen 54-registration v3 registry and retain earlier results; it is not a new independent evaluation. Source files, definitions and candidate values remain private. No endpoint activation, Production SQL or platform-role change is included.

Reference: [Node worker resource limits](https://nodejs.org/download/release/latest-v22.x/docs/api/worker_threads.html#new-workerfilename-options); pinned implementation inspected locally in the existing SheetJS 0.20.3 dependency.
