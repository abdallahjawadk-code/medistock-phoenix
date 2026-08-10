# Vercel hardening non-goals

The following are intentionally outside this repository-only hardening change because they can alter live access behavior and must be configured at the Vercel/Supabase platform boundary after direct verification:

- Production-domain access restrictions.
- Global bot challenge.
- Country or user-agent blocking.
- Broad rate limits.
- CSP tightening that could affect the UI.
- Service Worker behavior changes without a real `/api/*` surface.
- Supabase Auth changes.
- Database ACL/RLS changes (handled separately by the database-security workstream).

This branch must remain behavior-neutral for Phoenix runtime code.
