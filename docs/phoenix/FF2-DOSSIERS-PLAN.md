# FF2 — dossier-aware emergency writer closure

Status: unnumbered candidate, never applied to Production or Staging. Disposable
local test application is evidence, not release authority. Parent: PR256 head
62b91e3aaaa9dc70c5eec69d0061970d87f68a13; requires the revised M235 matrix-v2.

FF1 and applied migrations 001..231 remain byte-identical. FF1's historical test
continues to prove its intended M230 shape (18 original writers); its previous
unbounded latest-chain invocation was not an exhaustive current-writer census.
The new tests do not waive that failure: they execute FF1 counterfactually,
prove the six uncovered current wrappers remain callable, then roll it back.
FF2 is applied directly to the untouched current 27-writer shape.

FF2 binds all 63 public Central Needs RPC signatures and exact prosrc MD5s of 27
manual/material/intake writers. Any extra/missing RPC or changed writer body
refuses the transaction before revocation. It revokes PUBLIC/anon/authenticated/
service_role EXECUTE on every exact signature. No grants, new objects, table
DML, staff changes, marker changes, deletion or Excel unfreeze occur. A second
apply refuses cleanly. This is a manual-entry/catalog-intake writer switch, not
an assertion that historical generic lifecycle APIs or all application workflows
are disabled; those pre-existing ACLs and read/history access stay unchanged.

Executable cases cover unlisted RPC and body drift, actual invocation refusals
for every writer under all three API roles (81 calls), data/permission/marker/
audit digests unchanged, actor_scope definition unchanged, annual summary still
readable and capability seal clean. Native CI must execute these cases as well;
local WASM results cannot prove independent-session races or PostgREST/Auth.

Operational use is a separate owner decision: immutable reviewed bytes, current
schema/body readback, compatible backup/restore evidence, protected application,
then independent readback. The historical tested restore ceiling M221 must not
be represented as a tested restore of this future schema. This file is neither
a numbered migration nor an automatically applied recovery action.
