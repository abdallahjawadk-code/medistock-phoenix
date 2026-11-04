# MediStock Phoenix — Preview readiness gate (r19, 2026-11-01)

**Read-only audit / Draft PR.** This work is deliberately separate from Codex's active R2/C4 branches; it does not alter application runtime, Vercel configuration, SQL, access grants, service-role handling, or Production.

## Verified root causes

1. Vercel `medistock-qr-network` has browser variables `VITE_PHOENIX_SUPABASE_URL` and `VITE_PHOENIX_SUPABASE_ANON_KEY` configured for **Production only**; Preview had no corresponding values. Vite embeds these during build. Therefore READY Preview displays «الاتصال بقاعدة البيانات غير مهيأ».
2. The committed `vercel.json` CSP `connect-src` permits HTTPS/WSS to Production project `eyrzxgfkvqybjdgyphap` only; simply adding a Staging URL would be blocked by browser CSP. Do **not** expand the Production CSP without an independent security review.
3. Existing Staging `knndhlczdlparjfmlxis` is active but did not expose the new `phoenix_central_needs_annual_catalog_contract()` RPC on read-only verification. Production remained at migration M231 without the new annual/catalog contract. A configured Preview does not prove a completed feature.
4. Vercel Preview protection is SSO-enabled for non-custom domains. Do not promise an anonymous preview or bypass security controls.

## Machine-verifiable preflight

Run inside a correctly scoped **Preview** environment, never Production:

```bash
PHOENIX_STAGING_SUPABASE_REF=knndhlczdlparjfmlxis \
VERCEL_ENV=preview \
node tools/preview-readiness/check.mjs --json
```

To include the C4 trusted HTTP layer: add `--require-c4`. The script checks mandatory frontend/backend config *presence and scope*, public-vs-service key boundaries, exact Supabase URL, and the static CSP; it never prints credentials, accesses the database or logs into a user account. Node tests: `node --test tools/preview-readiness/check.test.mjs`.

`CONFIG_PRECHECK_PASS` means **configuration-only PASS**, not an authenticated end-to-end acceptance or hosted-schema compatibility proof. `HOLD` means the Preview is not ready.

## Path to an honest interactive preview

- Use an isolated Staging target; never link a Preview with Production to evade a missing variable, and never pass service keys under `VITE_`.
- Configure actual branch-targeted Preview env values (public URL + anon/publishable key; private backend values server-only), then redeploy the intended **new commit**. Previously built assets remain without values.
- Establish a narrowly scoped CSP for that isolated Preview while preserving Production CSP. Because `vercel.json` is shared/static, do not claim that a branch-specific CSP has been implemented without verified deployment evidence.
- Complete Staging SQL/RLS compatibility, including inherited hosted roles, exact RPC contracts, no default grants and isolation. Do not apply `NOT_APPLIED` candidates without explicit safety gates. Protect historical data.
- Verify signed-in browser journeys with disposable test identities and real Staging data: classification → national-code/name search → immutable material identity → employee annual quantity → nonbinding monthly suggestion → reasoned adjustment → authorized approval. Reject cross-owner/year and unauthorized writes.
- Deliver the exact Preview URL, branch/commit SHA, environment, screenshot evidence, passing CI/E2E and test-account availability; no `PREVIEW_READY` label until these all pass.

## Source anchors

- `src/shared/supabase/client.ts` — two exact browser env names.
- `api/_lib/env.ts` — separate server env and service key.
- `vercel.json` — Production-only CSP.
- `docs/deployment-readiness.md` — Vercel Preview needs explicit variable scope.
- MediStock governing r18 / original skills K03, K04, K09, K17, K18, K19, K20, K33, K37, EXT-PTEA.
