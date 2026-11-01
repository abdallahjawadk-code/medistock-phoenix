# Employee C3/C4 client boundary

This additive client is not mounted in a page yet. The deployed reviewed-profile registry remains empty; no real workbook, real template or Production SQL is introduced. It supplies explicit profile discovery, bounded source-page reads, one frozen membership intent, employee HTTP commit and a separate receipt read.

Discovery returns identifiers/versions/hashes, not a recognition decision. The employee must choose a reviewed profile explicitly. C3 registration SHA and its string version are distinct from the core template SHA and numeric version. Pages retain original ID/hash/size/name and owner/year bindings, deterministic preparation keys, cell/header witnesses, held results and opaque continuation. The old persisted A1 response validator still requires UUID occurrence keys. Only its existing witness-cell validator is additionally exported; no old rule is loosened.

C4 sends exactly the existing thirteen review choices, never cells/maps, actor authority, service keys, quantities or a canonical creation command. A current session belonging to the intent actor is required. The server still re-reads C2, runs the worker and owns authorization, legal identity, seal and commit. The client's structural validation is not approval.

The acknowledgement preserves `sourceAttestation: client_attested` from A1 and validates the separate `c4Verification` extension against the initiating actor, original and registration. Receipt replay must be unselectable and require a separate current membership read. A malformed or lost acknowledgement is an unknown outcome, not proof of rollback.

The UI must retain the complete frozen intent while unresolved, read its receipt first, and offer only an explicit same-intent retry after a missing/prepared receipt. Failed receipt reads remain unresolved. These services never replay a write automatically or fall back to a legacy membership writer. A committed result requires a fresh catalog read before selection. Actor/owner/year/source changes must discard stale read responses while retaining any in-flight write lock. These UI controls require their own component/browser acceptance before mounting.
