# Vercel hardening checklist

This checklist is intentionally conservative. It separates account-level controls from repository controls so Phoenix cannot be broken by simulating platform security in application code.

- [x] Ignore `.env.*` files in Git while preserving `.env.example`.
- [x] Keep `.vercel` out of Git.
- [x] Add CI coverage for the ignore contract.
- [ ] Protect Preview/generated deployment URLs with Vercel Authentication / Standard Protection.
- [ ] Keep the Production QR domain public.
- [ ] Introduce only narrow firewall rules and observe/log before deny/challenge.
- [ ] Keep broad Bot Challenge disabled unless traffic evidence justifies it.
- [ ] Do not spend the Hobby rate-limit rule on `/login`; Supabase Auth is the real authentication boundary.
- [ ] Verify Preview environment scope excludes service-role/database credentials.

Items left unchecked require Vercel project-setting access and are not changed by this branch.
