# Stage J — J-3 Final Release Audit

Date: 2026-08-24  
Project: MediStock Phoenix  
Audit mode: independent read-only evidence review before release tagging

## 1. Release candidate identity

| Evidence | Result |
|---|---|
| Live `master` at audit entry | `cb8bb31e3429f7cfef4e6c86222477f65b2854ce` |
| Master tree | `b517b548b085eaecd2bfe561634ac3e53b255be7` |
| J-2 checked head | `199718c4b1cabbec911b22ab901cb3a0f311cd9f` |
| J-2 checked tree equals master tree | **YES** |
| `package.json` version | **2.0.0** |
| Existing `v2.0.0` ref at audit entry | **ABSENT** |
| Vercel Production for live master | **READY** |
| Supabase project | **ACTIVE_HEALTHY**, PostgreSQL 17 |

The final tag must not be created until this audit PR itself passes the four
required checks and merges. If the release tree changes after that, this audit
must be repeated.

## 2. Major-J closure evidence

| Gate | Result |
|---|---|
| J-1 D3 CORS disposition | **CLOSED — RESIDUAL_ACCEPTED_RISK** |
| Cold-start permanent-loading blocker | **CLOSED** by PR #162 |
| Mobile viewport / overlay convergence | **CLOSED** by PR #161 |
| Mobile browser matrix | **PASS — 116/116 assertions** |
| J-2 release record | **CLOSED** by PR #160 |
| Production database mutation during UI/auth/J-2 work | **NONE** |
| New migration after M198 | **NONE** |

The cold-start repair bounds session, profile and permission reads and fails
closed on silence. The mobile convergence covers 320×568, 360×800, 390×844,
430×932 and 667×375 landscape, including settled drawer/dialog geometry,
document horizontal overflow and keyboard focus ownership.

## 3. Production migration and database security audit

Fresh read-only Production queries at J-3 entry returned:

| Invariant | Result |
|---|---|
| Migration history rows | **198** |
| M197 row | **1** |
| M198 row | **1** |
| M199+ by canonical migration name | **0** |
| Highest canonical migration name | `198_phoenix_secdef_search_path_convergence` |
| Public-schema SECURITY DEFINER total | **321** |
| SECURITY DEFINER with PUBLIC EXECUTE | **0** |
| SECURITY DEFINER on bare `search_path=public` | **0** |
| SECURITY DEFINER on `public, pg_temp` | **321** |
| Expected critical trigger bindings | **8/8 present** |
| Disabled expected trigger bindings | **0** |

The 321 definers are 320 owned by `postgres` plus
`phoenix_demo_purge(...)` owned by `phoenix_demo_purger`; all 321 carry the
same hardened `public, pg_temp` search path.

### Anonymous RPC surface

`get_public_qr_payload(text)` is the only data-returning public-schema RPC
intentionally executable by `anon`. `phoenix_set_updated_at()` also appears
as executable through the default ACL, but it returns `trigger`, is
SECURITY INVOKER, and PostgreSQL does not permit calling a trigger function as
an ordinary RPC.

## 4. Supabase security-advisor adjudication

The live advisor returned no separate finding that contradicts the hardened
SECURITY DEFINER invariants above. Its classes were adjudicated as follows:

* **210 `authenticated_security_definer_function_executable` WARNs** —
  expected architecture: signed-in users reach explicitly granted RPCs whose
  server-side contracts re-derive authority. PUBLIC EXECUTE remains zero.
* **1 `anon_security_definer_function_executable` WARN** —
  `get_public_qr_payload(text)`, the intentional anonymous QR contract.
* **8 `rls_enabled_no_policy` INFOs** — RLS-with-no-policy is deny-by-default
  for direct API roles; no widening is performed for release.
* **3 `function_search_path_mutable` WARNs** —
  `phoenix_provenance_reconciliation()`,
  `phoenix_warehouse_source_balances(uuid)`, and
  `phoenix_set_updated_at()`. All three are SECURITY INVOKER, not definer.
  The two SQL readers schema-qualify their relations; the trigger helper uses
  only `NEW` and `now()`. No SECURITY DEFINER search-path regression exists.
* **1 `auth_leaked_password_protection` WARN** — accepted limitation.
  Supabase documents leaked-password protection as available on Pro and above;
  this release does not authorize a paid-plan mutation.

The leaked-password limitation is a plan capability gap, not evidence that
password hashes are stored insecurely. It should be revisited if the project
moves to a qualifying paid plan.

## 5. Supabase performance-advisor posture

The live performance advisor reports optimization backlog:

* 240 unindexed-foreign-key INFO items,
* 53 Auth/RLS init-plan WARN items,
* 51 unused-index INFO items,
* 37 multiple-permissive-policy WARN items.

These are retained as post-release optimization work. They are not converted
into release blockers without measured correctness or acceptance impact.
The final release candidate has green database replay, TLS acceptance and
authenticated browser corridors. PR #117 remains future performance scope and
is not part of this release.

## 6. Edge Function audit

The canonical source tree contains four functions:

1. `admin-create-user`
2. `admin-user-lifecycle`
3. `admin-recycle-user`
4. `phoenix-outbox-dispatcher`

Production currently also retains four active legacy deployments:

1. `create-user`
2. `reset-user-password`
3. `update-user`
4. `delete-user`

Repository audit evidence in
`docs/phoenix/a3-3a-edge-auth-hardening.md` classifies all four legacy
deployments **SAFE_TO_RETIRE**: no repository production caller, zero matching
invocations across seven consecutive 24-hour query windows, and schema
contracts that no longer match their legacy assumptions. The same document
states that retirement is a separate explicitly authorized control-plane
action. J-3 therefore records, but does not delete, this residue.

D3 remains the previously accepted non-credentialed wildcard-CORS residual
risk for the three admin functions. No cookie auth or
`Access-Control-Allow-Credentials` is introduced.

## 7. Delivery and CI evidence

The exact J-2 head whose tree equals live master passed all four required
release gates before merge:

1. **Security and quality gates — PASS**
2. **PostgreSQL pg-rig — PASS**
3. **Vercel — PASS**
4. **Authenticated browser acceptance (disposable local Supabase) — PASS**

The immediately preceding mobile candidate additionally recorded the standard
suite at **431 files / 15,455 tests passed**, dependency audit at
**0 vulnerabilities**, and authenticated browser acceptance at
**116/116 assertions**.

Fresh GitHub branch evidence reports `master` as protected. Repository
operations evidence records ruleset `21216543` ("Phoenix Master Production
Gate") as active on master with the four contexts above and zero bypass actors.
The current connector does not expose a dedicated live ruleset-object read, so
the ruleset object itself was not independently re-fetched in this J-3 session;
enforcement evidence is the protected branch plus the required-check behavior
observed on the final PR sequence.

## 8. Vercel state

The latest Production deployment is **READY** and is pinned to live master
`cb8bb31e3429f7cfef4e6c86222477f65b2854ce`.

No manual `vercel --prod` deployment is part of J-3.

## 9. Open PR and dependency risk

Open work does not expand this release:

* PR #117 — draft future performance scope; do not merge into v2.0.0.
* Dependabot PRs #135, #61, #60, #59, #6 and #5 — post-release dependency
  maintenance; the release-candidate audit reports zero known vulnerabilities.
* Draft design/experiment PRs #40, #36, #35, #34 and #30 — not release scope.
* PR #8 — old draft CI/preflight work, not part of the canonical release path.
* PR #39 — future/experimental scope, not part of v2.0.0.

None is required to make the audited release tree correct.

## 10. Accepted operational limitations

The owner accepts these as limitations, not capabilities:

* RPO / RTO: **NOT_FORMALLY_COMMITTED**
* backup / PITR / retention: **EXTERNAL_PLATFORM_EVIDENCE_REQUIRED**
* restore rehearsal: **NOT PERFORMED**
* monitoring / alerting: **MANUAL**
* on-call rota: **NONE CLAIMED**
* D3 wildcard CORS: **RESIDUAL_ACCEPTED_RISK**
* leaked-password protection: **ACCEPTED_LIMITATION / paid-plan feature**
* four legacy Edge deployments: **SAFE_TO_RETIRE / NOT REMOVED**
* performance-advisor backlog: **POST-RELEASE**

## 11. Final audit decision

```text
J1 = CLOSED
J2 = CLOSED
J3_READ_ONLY_AUDIT = PASS
COLD_START_RELEASE_BLOCKER = CLOSED
MOBILE_UI_CONVERGENCE = PASS

PRODUCTION_DB_DRIFT = NONE FOUND
MIGRATION_DRIFT = NONE
M199_PLUS = NONE
SECDEF_PUBLIC_EXECUTE = 0
SECDEF_BARE_PUBLIC_SEARCH_PATH = 0
EXPECTED_TRIGGER_BINDINGS = 8/8
PRODUCTION_PROJECT = ACTIVE_HEALTHY

RELEASE_TREE = b517b548b085eaecd2bfe561634ac3e53b255be7
PACKAGE_VERSION = 2.0.0
V2_0_0_TAG_AT_AUDIT_ENTRY = ABSENT

J3_REQUIRED_CHECKS = PENDING_THIS_PR
FINAL_TAG = NOT_YET_CREATED
```

**Decision:** the read-only whole-program audit finds no unresolved release
blocker. The remaining release gate is mechanical and fail-closed: this J-3
documentation PR must pass the same four required checks, merge without tree
drift, and Vercel Production must reach READY. Only then may `v2.0.0` be
created on that exact final master commit.
