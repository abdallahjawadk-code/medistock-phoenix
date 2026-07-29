# A3-3A Edge authentication and key hardening

This document records the read-only legacy evidence and the local-only
hardening contract. It is not a deployment authorization.

## Production evidence

The four legacy deployments were downloaded with `--use-api` into an external
temporary directory, inspected, and deleted. No recovered legacy source was
copied into a deployable repository path.

| Function | Legacy request | Legacy success response | Audit marker | Classification |
|---|---|---|---|---|
| `create-user` | names, username, password, role, `hospital_id` | `success`, `userId` | `CREATE/users`, role/hospital details | `SAFE_TO_RETIRE` |
| `reset-user-password` | `userId`, `newPassword` | `success` | `UPDATE/users`, password-reset details | `SAFE_TO_RETIRE` |
| `update-user` | `userId`, names, role, `hospital_id`, status | `success` | `UPDATE/users`, changed-fields details | `SAFE_TO_RETIRE` |
| `delete-user` | `userId`, `hardDelete` | `success`, `authDeleted`, optional warning | `DELETE/users`, soft-delete details | `SAFE_TO_RETIRE` |

Evidence supporting the classification:

- no repository production caller for any of the four names;
- zero matching Edge invocations in seven consecutive 24-hour query windows;
- zero matching legacy audit markers in `public.audit_logs`;
- `public.get_current_user_profile()` and
  `public.count_active_super_admins()` do not exist;
- `public.roles` and `public.user_roles` do not exist;
- the legacy `profiles` and `audit_logs` column sets do not exist.

The functions therefore cannot pass their first identity RPC against the
current schema. A compatibility adapter would have to guess both role semantics
and response behavior while preserving direct privileged writes and non-atomic
failure modes. No adapter is proposed.

## Canonical local contract

Only these functions are canonical:

- `admin-create-user`
- `admin-user-lifecycle`
- `admin-recycle-user`

They resolve the `default` `sb_secret` and `sb_publishable` values from the
Supabase JSON key-set variables. Invalid configuration fails closed, and no
legacy service-role fallback exists. Caller authentication uses a distinct
publishable-key client plus the presented Bearer token and `auth.getUser()`.
The privileged client is never accepted as caller identity. Existing database
RPCs remain the final authorization and organization-scope authority.

## Future verify-JWT transition

`supabase/config.verify-jwt-future.toml` is intentionally inactive. A3-3B may
activate it only after:

1. the modern key-set deployment is verified for all three functions;
2. authenticated positive and negative RBAC/RLS smoke tests pass;
3. malformed, expired, suspended-actor, cross-organization, and IDOR requests
   are rejected by the explicit authentication and RPC contracts;
4. no caller depends solely on the platform `verify_jwt` gateway;
5. the owner gives separate Production authorization.

The legacy functions must not be redeployed. Their later retirement is a
separate, explicitly authorized control-plane action.
