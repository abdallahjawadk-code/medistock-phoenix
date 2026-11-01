# P4-A — PRISM shell visual convergence (implementation gate)

Date: 2026-11-01. Branch: `feat/p4a-prism-shell-convergence-20261101`, isolated from the C2 / #265 annual-originals branch.

## Authoritative visual target

The owner requires the real React application to match the approved PRISM references, rather than a separate synthetic preview. The first PRISM slice (#261) is confined to annual needs; the global application shell still imports Molecular styling. The approved PRISM language uses platinum/ink/cobalt, Changa and Noto Sans Arabic for Arabic, Sora for Latin, and responsive RTL/LTR, light/dark behavior. Do not silently treat the earlier Molecular pine/ivory/sage/brass references as identical to PRISM: they conflict and need explicit source selection per surface. For this track, the most recent owner request for PRISM parity governs the shell.

## P4-A first functional implementation slice

1. Convert the **real** `PhoenixAppShell`, `PhoenixSidebar`, `PhoenixMobileDrawer`, and `PhoenixTopbar` presentation to PRISM via a narrowly scoped shell marker and self-hosted fonts; do not alter navigation projection, permission guards, handlers, or routes.
2. Keep the established app tokens and Molecular styling for nonmigrated screens. PRISM shell rules must be scoped and reversible, and preserve nested page readability in both themes. Do not replace the entire global token file.
3. Reuse the existing Phoenix icon/mark, responsive breakpoint owner, language/theme toggles, skip link, keyboard focus, drawer close and notification behaviors. Preserve the prior owner decision to omit the mobile bottom navigation and interactive guide.
4. Test actual authenticated screens, not fixture-only HTML. Cover desktop 1366px, tablet 1024px, mobile 390px and 320px in AR/EN × light/dark. Compare screenshots to approved references for geometry, typography, spacing, contrast, sidebar/header and overflow. Document deltas with before/after images and a testable acceptance checklist.
5. Maintain accessibility: logical CSS properties, bidirectional isolation, touch targets, reduced motion, forced colors, keyboard and screen-reader landmarks.

## Nonbreak gates

- No SQL, Supabase changes, RLS, RPC, role changes, FEFO, stock flows, annual need quantities, material identities, or saved history changes.
- No preview-only or QA fixture content in Production; no auth bypass.
- Before merge: isolated source review, typecheck, lint, production build, visual matrix, navigation/auth regression, GitHub CI and authenticated E2E. Merge and Vercel Production publish only after those gates complete.
- #265 and later C3/R2 functional branches remain separate. No claim of complete PRISM parity until every real screen is migrated and compared.

## Execution status

This is the committed P4-A acceptance/implementation contract, **not a claim that shell code has been converted**. Next engineering commit must implement the scoped real-shell presentation and test it against the reference screenshots. Do not merge this documentation-only branch as a completed visual redesign.
