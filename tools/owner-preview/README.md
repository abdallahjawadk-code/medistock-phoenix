# Temporary owner preview

The opt-in `owner_preview` workflow-dispatch input runs the complete existing acceptance gates, then builds the actual published baseline and current application against a fresh, synthetic owner in that run's disposable Supabase. It is not a fixture-rendered UI or a Production activation.

The protected HTTPS link lasts at most one hour. Its gateway exposes only mapped build assets, selected Auth endpoints, employee-authorized REST/RPC and the actual C3/C4 HTTP handlers. It does not expose Studio, PostgreSQL, mailboxes, raw Kong, Realtime, Auth administration, original-workbook uploads or direct table writes. The two high-entropy owner credentials are supplied as task-owned Actions secrets and remain outside builds, logs, reports and screenshots. Remove those secrets after the preview has started; their values remain only in the running process until expiry.

Disposable signing keys are public development keys. Therefore the gateway additionally admits only the exact tokens observed from the real local Auth server for the single permitted test user. Tokens pass unchanged to real RLS and employee RPCs. This transport restriction grants no Product authority and is not a hosted compatibility solution.

`prove.mjs` verifies the public HTTPS link with real browser sign-in, source headers, the original and new Annual Needs navigation, national-code search, identity autofill with blank quantity, a manually entered annual need, an explicitly documented synthetic monthly policy, missing-policy handling, language/theme/viewport changes, real persistence, unchanged stock and closed capability seals. It also refuses real service credentials on loopback, valid but unobserved user tokens, foreign-owner RPCs and fixture-admin login. Only a successful public proof produces `ready.json`; artifacts contain no login password or gate credential.

The published baseline is pinned to `8cd7ccb45298939704fffcc44dcf1a25a27ed614`. Both builds use the same isolated backend and existing enabled flag. This distinguishes route behavior from data/environment changes. The new primary route still requires the existing server capability gate and the exact annual contract. Missing contracts show an explicit pending-activation status and retain the previous history surface. Contract read errors are surfaced with retry.

Hosted R2 compatibility, Production SQL, effective allocations and identity rollover remain separate gates. Nothing here changes Production roles, stock policy or migrations.
