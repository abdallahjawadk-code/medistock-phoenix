# C3 caller-scoped original reader

`api/_c3-core/original-reader.ts` is a Node read bridge, currently unwired. Its caller must be authenticated through the existing server helper. It uses only that caller's C2 download RPC, so current owner/year authority remains owned by C2. It never constructs a service client or accepts browser bytes, source cells, hashes or a filename.

The bridge snapshots the requested scope, validates the returned scope/original identity, 3 MiB size ceiling, canonical base64 and safe C2 first filename, and independently hashes the bytes. It returns the narrow C3 source envelope. Renamed uploads remain separate C2 history; this bridge identifies the retained original by its first filename. Transport and authority failures are closed, bounded errors, without backend details or automatic retries.

Synthetic transport tests and a real XLSX parser integration verify this boundary. They do not constitute real Auth acceptance, a persisted extraction attestation, template approval or legal catalog/quantity approval. No endpoint, SQL, original workbook or real template is added by this increment. Trusted persistence, immutable receipt/audit and activation remain subsequent independent gates.
