# FF2 — dossier-aware emergency writer closure

Status: unnumbered candidate. This P1 execution applied it only to disposable
local PostgreSQL; it does not attest any hosted application or live history.
Source: PR256 head 1db8a46ec5c66018ccda6b8b8c853d50343a36f0, combined with current
master. Requires M235 matrix-v2 followed by the exact P1 reservation candidate.

FF1 and all numbered source migrations 001..235 remain byte-identical. FF1's historical test
continues to prove its intended M230 shape (18 original writers); its previous
unbounded latest-chain invocation was not an exhaustive current-writer census.
The new tests do not waive that failure: they execute FF1 counterfactually,
prove the six uncovered current wrappers remain callable, then roll it back.
FF2 is applied to the P1-adjusted 27-writer shape. The former M235-only FF2 body
pins intentionally do not authorize revocation against different writer bodies.

FF2 binds all 63 public Central Needs RPC signatures and exact prosrc MD5s of 27
manual/material/intake writers, plus the exact private reservation implementation.
It also refuses if that implementation is executable by an API role or PUBLIC.
Any extra/missing RPC or changed writer body refuses the transaction before
revocation. It revokes PUBLIC/anon/authenticated/
service_role EXECUTE on every exact signature. No grants, new objects, table
DML, staff changes, marker changes, deletion or Excel unfreeze occur. A second
apply refuses cleanly. This is a manual-entry/catalog-intake writer switch, not
an assertion that historical generic lifecycle APIs or all application workflows
are disabled; those pre-existing ACLs and read/history access stay unchanged.

Executable cases cover unlisted RPC, public/private body drift, an authenticated
grant to the private implementation, actual invocation refusals
for every writer under all three API roles (81 calls), data/permission/marker/
audit digests unchanged, actor_scope definition unchanged, annual summary still
readable and capability seal clean. P1 passed 50 local native PostgreSQL 18.4
cases, including 16 independent-session order/commit/rollback cases. Native CI
must execute these cases as well; local PostgreSQL does not prove hosted
PostgREST/Auth behavior. See P1-WORKBOOK-RESERVATION.md for the scoped evidence.

Operational use is a separate owner decision: immutable reviewed bytes, current
schema/body readback, compatible backup/restore evidence, protected application,
then independent readback. The historical tested restore ceiling M221 must not
be represented as a tested restore of this future schema. This file is neither
a numbered migration nor an automatically applied recovery action.
