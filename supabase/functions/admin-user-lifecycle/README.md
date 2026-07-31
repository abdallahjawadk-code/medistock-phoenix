# Edge Function — `admin-user-lifecycle`

Secure server-side disable, enable, password rotation, and guarded hard-delete
for MediStock Phoenix V2.

## Authentication and key contract

- The caller supplies `Authorization: Bearer <user-jwt>`.
- A caller-scoped client uses the `default` key from
  `SUPABASE_PUBLISHABLE_KEYS` and verifies the JWT with `auth.getUser()`.
- A separate privileged client uses the `default` key from
  `SUPABASE_SECRET_KEYS` only for Auth Admin operations.
- There is no fallback to `SUPABASE_SERVICE_ROLE_KEY`.
- Invalid key configuration fails closed without logging key material.

The lifecycle RPCs remain the final authority for active actor status,
permission, organization scope, self-action denial, last-super-admin safety,
operational-history protection, reservation, compensation, and commit.

## Deployment boundary

A3-3A is local hardening only. Do not deploy from this document. The separately
authorized A3-3B window must keep production `verify_jwt=true` for the first
modern-key deployment and run authenticated positive and negative smoke tests
before any gateway-auth transition.

## Request and response

```text
POST /functions/v1/admin-user-lifecycle
Authorization: Bearer <caller-jwt>

{ action: disable|enable|delete|rotate_password, target_user_id, ... }

→ { ok: true, action, user_id, correlation_id? }
→ { ok: false, error, correlation_id? }
```

Passwords and key material are never logged or returned. Database state changes
remain delegated to the existing atomic RPC contracts.
