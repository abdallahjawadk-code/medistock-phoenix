# CN-2B — Upload / Preview / Mapping / Review

Status: implemented locally, not applied, not deployed.
Base: master `6ad1ecf3f8d6094da12e6d2dc3bc092247d74559`, tree `ca336860…`.
Migration ceiling before this slice: **210**. This slice adds **211**.

---

## 1. What CN-2B is, and what it deliberately is not

CN-2B is the human-facing half of Central Needs: choose a workbook, look at what
the parser found, prove the server agrees, decide what each imported row means,
and move the revision through review.

It is **not** a new authorization system, a second stock ledger, a transfer
engine, or an allocation mechanism. It creates no permission key. There is still
deliberately no `central_needs.send`; physical send remains
`warehouse_transfer.send`. No stock, movement, transfer request or supply
integration is touched anywhere in this slice.

---

## 2. The four contracts the entry gate demanded

### A. Authoritative replay

Browser parsing is **provisional**. The authoritative pass runs the same frozen
CN-2A parser core under Node 22, on the exact bytes stored in private storage —
never on anything the browser sends as a parse result.

The two results must agree on **every** frozen contract field except the two the
contract itself exempts: `ParserIdentity.runtime` and
`SourceProvenance.extractedAt`. For an archive the comparison covers the whole
`ArchiveParseResult` — container fingerprint, entry order, per-entry
diagnostics, excluded entries, reconciliation totals and every workbook cell —
not merely `sourceRecords`.

`api/_lib/parity.ts` is deliberately **stricter** than JSON: it separates
`undefined` from an absent key, `-0` from `0`, and non-finite numbers from
`null`. Any of those differences is a real anomaly, and none of them survives
`JSON.stringify`.

The trusted runtime is a **Vercel Node 22 serverless function**. Supabase Edge
Functions were rejected: they run Deno, and labelling a Deno parse `runtime:
'node'` would be the same false identity claim as letting the browser assert it.

### B. Canonical digest

**PostgreSQL is its own canonicalizer.** No TypeScript reimplementation of
`jsonb::text` exists anywhere in this slice, and a guard asserts it.

The trusted server computes `preview_digest` by calling M210's own
`_phoenix_central_needs_payload_digest_v1(...)` on the **browser's** records, as
`service_role`. Parity with the persisted digest is then *structural rather than
empirical*: `apply_authoritative_replay` persists

```
record_ordinal := e.ord
target_entity  := btrim(r->>'targetEntity')
field_name     := btrim(r->>'fieldName')
source_values  := r->'sourceValues'
source_provenance := r->'sourceProvenance'
```

and `_semantic_digest_v1` hashes exactly those columns, in that order, with the
same separators. So `payload_digest(X) ≡ semantic_digest(persist(X))` for every
valid `X`, by construction.

Why a TypeScript canonicalizer was refused: reproducing `jsonb::text` requires
jsonb key ordering (by length, then bytewise — *not* lexicographic), numeric
normalization (`1e21` → `1000000000000000000000`, `1e-7` → `0.0000001`, `1.0`
keeping its scale) against JS shortest-round-trip, duplicate-key elision, and
`, ` / `: ` separators. Spreadsheet cells reach every one of those classes.

The digest remains the browser's own commitment: computing its hash server-side
changes nothing about whose data is being hashed, and the Node parse is still
the authority.

### C. Review completeness

`targetEntity` is `sheet:{i}:row:{r}` — positional, one per row. Nothing in the
evidence distinguishes a medicine row from a subtotal, a footer, a note or a
continuation row, and CN-2A's contract records continuation grouping as
explicitly **DEFERRED** for that reason.

So the server is never asked to infer which rows *need* mapping. It requires
instead that a human made an **explicit decision** about every row:

| decision | `central_item_id` | `decision_reason` |
|---|---|---|
| `mapped` | required | optional note |
| `not_applicable` | must be NULL | **required, non-blank** |

M211 enforces five submission preconditions through one shared predicate
(`_phoenix_central_needs_review_blockers_v1`), which the read-only
`phoenix_central_needs_review_readiness` RPC also projects — so a green badge in
the UI and a refused submit cannot disagree:

1. at least one authoritative completed import exists;
2. no session for the revision is `pending` or `processing`;
3. every completed session belongs to a registered trusted batch;
4. every registered batch's declared entry count matches its rows;
5. every distinct `target_entity` in completed evidence has exactly one decision.

`failed` sessions are terminal history and never block.

### D. Private storage

One private bucket, `central-needs-source-files`, two namespaces:

```
staging/{organization}/{revision}/{user}/{upload_uuid}/source.bin
staging/{organization}/{revision}/{user}/{upload_uuid}/preview.json
permanent/{organization}/{revision}/{container_sha256}
```

Every segment is a server-generated UUID or a lowercase SHA-256 hex digest. Both
alphabets are closed and contain no `/`, `\`, `.` or control characters, so
traversal is **structurally impossible** rather than filtered out afterwards.
The key builders take no filename argument at all.

The original filename is preserved as metadata
(`central_needs_source_files.original_filename`,
`central_needs_import_batches.container_filename`) and is **validated, never
rewritten** — rewriting it would break the very parity check it participates in,
so a name carrying control characters or a path separator is refused instead.

A ZIP member gets **no object of its own**. The archive is stored once, whole and
immutable, and an entry is addressed by encoding its *ordinal and own content
hash* into the locator. The verbatim `archiveEntryPath` is preserved separately
as evidence in `central_needs_import_batch_entries.archive_entry_path`, where it
is data rather than an address.

The browser uploads directly to signed staging URLs, so a workbook never travels
through a serverless request body. Download requires `central_needs.view`,
proven **before** a signed URL is minted.

---

## 3. Batch atomicity — why a crashed ZIP stays blocked

A ZIP can carry many accepted workbooks; each becomes its own source file and
its own M210 session. If a worker died after finalizing three of five, the
database would hold three completed sessions and no way to know two more were
supposed to exist.

`central_needs_import_batches` / `central_needs_import_batch_entries` close that.
Registration is a single trusted RPC that validates the **whole** manifest before
writing any of it, and a completed session outside a registered batch can never
make a revision submittable.

Orchestration, in order:

1. browser preview (provisional);
2. upload source + preview JSON to private staging;
3. Node 22 downloads the exact bytes;
4. Node parses the entire container;
5. full masked browser/Node comparison;
6. any rejected non-excluded entry, or any parity difference → **abort, nothing persisted**;
7. per accepted entry: PostgreSQL digest → user-authorized session → trusted replay;
8. only after every entry completed: **one** trusted batch registration;
9. remove staging objects only.

Steps 7 and 8 are separate on purpose. A crash between them leaves the import
fail-closed until it is retried to completion — every step is idempotent — or
abandoned with a stated reason.

### Container hash is not an entry hash

The archive has its own `container_sha256`; each entry keeps its own
`InputFingerprint.sha256`, which is what M210 keys the source file and session
on. M211 refuses a manifest whose entry hash is not the hash of that session's
source file, and its VERIFY block asserts the batch table carries no entry-level
hash column at all.

---

## 4. Retry and abandonment

M210's `start_import_session` returned whatever session already existed, with no
state discrimination. M211 gives it explicit semantics:

| existing state | behaviour |
|---|---|
| `completed` | exact idempotent reuse |
| `pending` / `processing` | reuse the open attempt rather than race it |
| `failed` | a **new** attempt against the same immutable source file |
| anything else | fail closed |

`phoenix_central_needs_abandon_import_session` moves an open attempt to `failed`
with a mandatory reason, on a draft revision, requiring `central_needs.import`,
fully audited. It never touches source evidence, and there is deliberately **no
automatic timeout** anywhere.

---

## 5. Trust boundary in the server layer

* **Authenticate first.** No work happens for an unproven caller.
* **Authorize through the canonical model.** `phoenix_status_center_authorized`
  is called on a **user-scoped** client, so the answer is computed for the real
  `auth.uid()`. CN-2B adds no authorization decision of its own.
* **The organization is never a request input.** It is read from the revision
  row, on the caller's client, so RLS decides visibility first; an unauthorized
  caller gets 404 and learns nothing.
* **`service_role` does three things only:** private storage, the M210
  authoritative replay, and the M211 batch registration — the operations the
  database itself refuses to expose to `authenticated`.
* **The secret never reaches a browser.** The variable is deliberately not
  `VITE_`-prefixed (Vite inlines those at build time), no file under `src/`
  mentions it, and no endpoint returns it.

---

## 6. What the reviewer sees

The interface separates, and never collapses:

```
SOURCE  →  PARSER EVIDENCE  →  CANONICAL MAPPING  →  MANUAL OVERRIDE  →  REVIEW STATE
```

Source and effective value are **different columns**. An override is shown
beside the value it corrects, with its reason and provenance — never in place of
it. Every value is rendered as text: no cell HTML, no formula evaluation,
`formattedText` never used as the value.

Four status words, used with exact meanings and nowhere else:

* **PROVISIONAL** — a browser-only parse; nothing persisted.
* **AUTHORITATIVELY VERIFIED** — Node reproduced the preview and the database
  recomputed an agreeing digest.
* **INCOMPLETE** — the server lists at least one blocker.
* **READY FOR REVIEW** — the server lists none.

Family detection is displayed with its confidence and its reasons and gates
nothing at all. Bulk disposition always states how many rows it will change and
requires a second explicit confirmation, because `targetEntity` is row-level and
real workbooks have many.

Arabic and English, RTL and LTR from logical CSS properties only, a mobile
breakpoint, tables that scroll inside their own container, and a visible
keyboard focus ring on every control.

---

## 7. Navigation authorization

Screen **23**, capability-gated on `central_needs.view`, mirroring what RLS
already enforces. Two distinct mechanisms keep people out, and they are worth not
confusing:

* `health_center_manager` is the only **facility-scoped** role; 23 is absent from
  `FACILITY_SAFE_SCREENS`, so it is refused before the capability is consulted.
* `outlet_officer`, `warehouse_officer` and `institution_admin` are **not**
  facility-scoped. They reach the capability gate and are refused there for the
  same reason the database refuses them: they hold no `central_needs.view`.
  Migration 209 ships all four keys with **zero role defaults**.

This gate is not what protects source workbooks. RLS is: every Central Needs
policy re-evaluates `central_needs.view` for the row's own organization.

---

## 8. What is NOT done here

* M211 is **not applied** to Production.
* The Storage bucket is **not created** — it must exist before the endpoints work.
* `PHOENIX_SUPABASE_SERVICE_ROLE_KEY` is **not set** in any Vercel environment.
* Nothing is pushed, PR'd, merged or deployed.
* No `central_needs` permission is granted to anyone; the screen is unreachable
  until an explicit grant is made under a separate authorization.

---

## 9. Independent-review corrective pass

The first implementation failed independent pre-commit review. What changed, and why.

### Trust boundary

**The authoritative replay now runs for every session, completed ones included.**
The finalizer used to skip it when `start_import_session` returned `completed`.
That looked like a harmless optimisation and was not: M210's completed-session
branch is the *only* thing that re-digests the supplied payload and refuses a
retry carrying different evidence. Skipping it meant a second finalize with
altered records was silently accepted as "already done". The RPC is now called
unconditionally and M210 — not the API — decides exact-retry versus conflict.

**Role eligibility is enforced in the database.** Zero role defaults is a
statement about today, not a boundary. One accidental row in
`profile_permission_overrides` would have exposed source workbooks and annual
quantities to an institution or outlet actor. M211 adds
`_phoenix_central_needs_role_eligible_v1()` (`super_admin`,
`central_warehouse_manager` — the class migration 092 already uses) and applies
it two ways: as a **RESTRICTIVE** RLS policy on all nine Central Needs relations,
which ANDs with M209's permissive policies without editing M209, and inside the
client write guard. Access now requires **role eligible AND capability
authorized**. The predicate is `COALESCE(...) IN (...)`, not a bare `IN`, because
`phoenix_my_role()` is NULL without a JWT and `IF NOT NULL THEN` would skip its
own RAISE — fail-open. The VERIFY block asserts it never returns NULL.

**Permanent evidence is create-only.** `upsert: true` was an overwrite path over
immutable evidence justified by an argument ("the key is the content hash") rather
than an enforcement. The write is now `upsert: false`, and a collision is resolved
by independently re-hashing the stored object: identical bytes reuse, anything
else fails closed. Nothing deletes or replaces a permanent object.

### Identity

**One accepted archive entry, one import session.** A ZIP may legitimately carry
byte-identical workbooks at two paths. Keyed on `(revision, file hash)` alone,
both entries resolved to one session — so a batch either failed to register or
one session silently stood for two members and one entry's provenance vanished.
`central_needs_import_sessions` gains `entry_path`, a partial unique index makes
"at most one live session per revision + file + entry" declarative, and
`phoenix_central_needs_start_import_entry_session` carries the entry. Source
*bytes* stay content-deduplicated in `central_needs_source_files` — that part was
right. The batch writer additionally refuses a manifest entry whose session
recorded a different path. M210's 7-argument signature is preserved and delegates
with a NULL entry.

**Source-file lineage.** A ZIP member's `original_filename` was being set to its
archive path. CN-2A defines `originalFilename` as a basename and keeps
`archiveEntryPath` separate; the two are no longer conflated.

### Idempotency

**A batch retry is exact or it fails.** Comparing only the manifest and kind let a
retry rewrite the container's recorded metadata while looking idempotent.
Registration now binds every persisted semantic — filename, byte size, storage
locator, excluded count, reconciliation, parser identity, accepted count and the
complete ordered manifest — under the same container identity.

### Honesty

**Signed-URL TTLs are stated truthfully.** `createSignedUploadUrl()` takes no
expiry argument; Supabase fixes the token at two hours. Reporting 300 seconds for
an upload ticket was a promise the provider does not keep. The two TTLs are now
separate constants with separate names, and the upload response reports the
provider's real contract and its source. No shorter window is faked locally.

**Object size is proven before download.** A ceiling checked after `download()`
documents a limit it does not impose. The size now comes from Storage's own
listing first; the post-read check remains as a second line.

**Staging lifecycle is recorded as a prerequisite.** `finalize-import` removes the
staging pair on success, but an abandoned upload or an aborted finalize leaves
orphans. `STAGING_LIFECYCLE_REQUIREMENT` states what the bucket owner must apply:
a 24-hour expiry on `staging/`, explicitly **not** on `permanent/`. Deliberately
not a delete sweep in application code — a background deleter holding credentials
over the evidence bucket is a bigger risk than the orphans it would collect.

### Completed workflow

The screen can now create its first revision: a plan-year control and an explicit
**Open annual draft** (`open_next_revision = false`, which reuses an open draft
rather than creating a second). **Open next revision** appears only for an
approved or rejected revision. Every revision label carries its plan year, because
revision numbers restart per plan and a bare "#1" is ambiguous. Nothing creates a
revision automatically.

Field overrides have a real write path: the reviewer states the value **kind**
(number / text / boolean / blank) explicitly, so a zero is never confused with a
blank and a "0" typed as text stays text. A reason is required. The immutable
source value stays on screen beside the editor throughout.

Source evidence is searchable by filename, fingerprint prefix and archive entry
path, scoped to the revision, with RLS as the boundary and storage locators never
rendered.

### Permission catalog (closed by the corrective pass)

The permission-catalog finding is closed. The four `central_needs.*` keys that
migration 209 seeded (`view`, `import`, `edit`, `approve`) are now in the frontend
`PERMISSION_KEYS` catalog with the same module, action, dangerous flag and
bilingual labels as `permission_keys`, so the existing permission-matrix screen
can grant or deny them per profile through the existing `assign_profile_permissions`
path. This creates no authority: migration 209's zero role defaults are untouched,
no explicit frontend role fallback names a Central Needs key, and the server
(RLS plus every 210/211 RPC guard) remains the boundary. `super_admin`'s
catalog-wide frontend derivation now spans these keys exactly as the server already
admits that role unconditionally (`phoenix_status_center_authorized`, migration 092;
eligibility, migration 211). There is still no `central_needs.send`.
