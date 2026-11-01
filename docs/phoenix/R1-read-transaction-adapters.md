# Manual annual journey transaction adapters — candidate only

Real employee PostgREST acceptance exposed SQLSTATE 25006 from the original STABLE dossier and annual-summary reads. Their unchanged authorization guard takes `FOR KEY SHARE`. The dossier-revisions reader has the same declaration and guard and is called after a plan exists. PostgREST runs even POST calls to STABLE functions in read-only transactions; M214 documents the same defect for readiness.

The separate `R1_read_transaction_adapters_NOT_APPLIED.sql` adds three VOLATILE, SECURITY INVOKER PL/pgSQL entry points. Each delegates exactly to its original function with the original arguments and return type. Normal POST RPC can acquire the original guard's lock. There is no new definer, data writer, policy, operational table, activation, credential or role-membership change. Only authenticated callers receive EXECUTE; they must still pass the delegate's existing authority. The candidate verifies old full routine definitions, ownership and ACLs byte-for-byte before committing.

Native verification reproduces read-only failures and proves invoker metadata, caller/foreign/revoked/anonymous/service boundaries, unchanged business counts and prior seals. Real Auth/PostgREST acceptance separately reproduces all three old failures and exercises the new entry points, existing dossier revisions, foreign/anonymous refusal and same-JWT view revocation. Native success alone does not prove PostgREST transaction behavior.

This candidate is separate from design changes and is not a Production migration. Hosted compatibility remains HOLD. The annual journey may opt into these adapters after its annual contract is present; absence/refusal must remain unavailable with no silent legacy fallback. Existing legacy callers retain their current functions.

Source: [PostgREST transaction access mode](https://docs.postgrest.org/en/stable/references/transactions.html#access-mode-on-functions).
