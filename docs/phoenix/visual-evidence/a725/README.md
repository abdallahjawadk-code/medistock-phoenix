# A7.2.5 visual and interaction evidence

Final local verification target: branch `feat/phase-a-claude-a7-visual-convergence-acceptance`, starting at `7fa3c7bf8a7ea33ad3c9626060011b7b0e68b43e`.

## Password reveal contract

- Runtime tests prove the initial `password` type, `button` semantics, exact dynamic AR/EN accessible names, dynamic `aria-pressed`, unchanged value, focus/caret/selection restoration, form reset, successful-submit reset, remount reset, disabled/busy behavior, and the unchanged `signIn(resolveLoginIdentifier(email), password)` call.
- The implementation has no storage, cookies, timer, telemetry, or logging path and retains `autocomplete="current-password"`.
- Live browser measurements recorded a `44 × 44 px` toggle, zero input position/width delta when changing `password ↔ text`, zero positive horizontal overflow, and zero failed image loads.
- The focused-button capture was produced with the reveal control as `document.activeElement`; the focus-visible rule uses a two-pixel tokenized outline.
- Submit loading is covered by a real pending-promise runtime test: both fields and the reveal control become disabled until the existing submit promise settles. No production handler or QA-only branch was added to manufacture this state.

## Screenshot matrix

| Surface | Locale / theme | Viewport or state | Evidence |
|---|---|---|---|
| Login | AR / Light | 1440×900, hidden | `login-ar-light-desktop-hidden-1440x900.png` |
| Login | AR / Light | 1440×900, visible | `login-ar-light-desktop-visible-1440x900.png` |
| Login | AR / Light | 1440×900, toggle focused | `login-ar-light-desktop-toggle-focused-1440x900.png` |
| Login | AR / Light | 1440×900, invalid | `login-ar-light-desktop-invalid-1440x900.png` |
| Login | EN / Dark | 1366×768, hidden | `login-en-dark-desktop-hidden-1366x768.png` |
| Login | EN / Dark | 1024×768, hidden | `login-en-dark-tablet-hidden-1024x768.png` |
| Login | AR / Light | 430×932, hidden / visible | `login-ar-light-mobile-hidden-430x932.png`, `login-ar-light-mobile-visible-430x932.png` |
| Login | AR / Light | 412×915, hidden | `login-ar-light-mobile-hidden-412x915.png` |
| Login | EN / Dark | 390×844, hidden | `login-en-dark-mobile-hidden-390x844.png` |
| Login | AR / Light | 375×812, hidden | `login-ar-light-mobile-hidden-375x812.png` |
| Login | EN / Dark | 360×800, hidden | `login-en-dark-mobile-hidden-360x800.png` |
| Welcome | AR / Light | 1440×900 | `welcome-ar-light-desktop-1440x900.png` |
| Welcome | EN / Dark | 390×844 | `welcome-en-dark-mobile-390x844.png` |
| Shell | AR / Light | 1440×900 sidebar | `shell-ar-light-sidebar-1440x900.png` |
| Shell | EN / Dark | 390×844 shell / open drawer | `shell-en-dark-mobile-390x844.png`, `shell-en-dark-mobile-drawer-open-390x844.png` |
| Shared states | AR / Dark | 430×932 loading/empty/error | `states-ar-dark-mobile-loading-430x932.png` |

All required viewport widths were exercised in the live app: 1440×900, 1366×768, 1024×768, 430×932, 412×915, 390×844, 375×812, and 360×800. Browser-side measurements at each size reported no positive horizontal overflow and no failed image assets.

## Motion, PWA, and accessibility

- The calm Login/Welcome entry animations remain under the Phase-A/daylight root. The existing central `prefers-reduced-motion: reduce` contract collapses every descendant animation and transition to 1 ms; the focused contract test verifies that inheritance.
- PWA prompt presentation is tokenized and scoped without changing its install/dismiss logic. The existing focused PWA suite passes all 60 tests, including native prompt, iOS instructions, accessibility, install action, dismissal, and shell placement.
- RTL/LTR uses logical properties for the divider, toggle spacing, and drawer edge. Browser evidence confirms `dir=rtl/lang=ar` and `dir=ltr/lang=en` in both themes.
- Invalid fields expose `aria-invalid` and a shared `aria-describedby` error target. Disabled fields and the reveal button use native `disabled` semantics.

## Asset and performance evidence

- Phoenix full SHA-256: `6cc0c11affc54ab0101d5570b84dd785439d43fa167ef6094381f29893af7e09`
- Phoenix compact gold SHA-256: `b2412f895e5339a5d60559de67f040a5aa88c7ebbf30aaa9b1c79d020370dfe1`
- Phoenix compact teal SHA-256: `d8c9b2bf07ff3326f3476c5c2e26020f7ffb86f1fa66079ddec2e989476573a1`
- Source gzip delta from the starting HEAD: CSS `+1,507 bytes`; Login JavaScript/TSX `+755 bytes`.
- Production build: 436 modules; main CSS 160.91 kB / 26.45 kB gzip; login-bearing main JS 261.40 kB / 68.93 kB gzip. No image, font, package, lockfile, or dependency was added.

## Verification summary

- Focused A7.2.5/UI/PWA suite: 136/136 passed.
- Full suite: 12,431/12,431 passed with `--maxWorkers=1` to avoid Windows PowerShell process contention.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- Architecture boundary: presentation/auth-screen component, scoped CSS, one narrow runtime test, and this evidence directory only. No database, migration, Supabase, auth/session service, RBAC/RLS, route, screen ID, RPC, workflow, dependency, package, lockfile, or Phoenix raster file changed.
