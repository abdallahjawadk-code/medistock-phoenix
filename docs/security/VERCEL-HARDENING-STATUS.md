# Vercel hardening status

This document records only the low-risk repository hardening that is safe to stage without changing Production behavior.

## Implemented in this branch

- `.gitignore` now ignores every `.env.*` variant while explicitly preserving `.env.example`.
- `.vercel` remains ignored.
- A Vitest contract pins both invariants so future edits cannot silently re-open them.

## Deliberately not changed here

These controls live in the Vercel account/project configuration and must not be approximated in application code:

- Deployment Protection / Vercel Authentication for Preview deployments.
- Firewall custom rules / Bot Protection / rate limiting.
- Production vs Preview environment-variable scoping.

The intended deployment posture is:

- Production public domain stays public so the anonymous QR workflow remains reachable.
- Preview and generated deployment URLs are protected.
- Firewall rules are introduced in observation/log mode before any deny/challenge action.
- No broad rate limit is applied to `/login`; authentication is handled by Supabase and must be hardened at that boundary.
- Preview builds must not receive service-role or database credentials.

No Production deployment, Vercel setting, Supabase setting, migration, RLS/RBAC rule, CSP rule, Service Worker behavior, or application runtime logic is changed by this branch.
