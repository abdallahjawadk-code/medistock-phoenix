# Edge Function — `admin-create-user`

Secure server-side user creation for MediStock Phoenix V2.

## Authentication and key contract

- The caller supplies `Authorization: Bearer <user-jwt>`.
- A caller-scoped client uses the `default` key from
  `SUPABASE_PUBLISHABLE_KEYS` and verifies the JWT with `auth.getUser()`.
- A separate privileged client uses the `default` key from
  `SUPABASE_SECRET_KEYS`.
- Missing or invalid key-set JSON, a missing `default`, or the wrong key class
  fails closed as `NOT_CONFIGURED`.
- There is no fallback to `SUPABASE_SERVICE_ROLE_KEY`.
- Key JSON, values, and fingerprints are never logged or returned.

The database RPC `phoenix_admin_provision_profile` remains the final authority
for actor status, permission, official role, and organization scope.

## Deployment boundary

A3-3A is local hardening only. Do not deploy from this document.

In the separately authorized A3-3B window:

1. Confirm `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, and
   `SUPABASE_SECRET_KEYS` are present by name without printing values.
2. Keep production `verify_jwt=true` for the first modern-key deployment.
3. Deploy only the reviewed commit through the manual Production workflow.
4. Run authenticated RBAC/RLS, cross-organization, IDOR, suspended-actor, and
   malformed-token smoke tests.

## Request and response

The existing wire contract is unchanged:

```text
POST /functions/v1/admin-create-user
Authorization: Bearer <caller-jwt>

{ full_name, organization_id, role, login_mode, ... }

→ { ok: true, user_id, role, invited, password_mode }
→ { ok: false, error, correlation_id? }
```

Temporary passwords are never logged, stored in `profiles`, or returned.
Provisioning failure rolls back the newly created Auth user; rollback failure is
reported using the correlation id without exposing provider details.
