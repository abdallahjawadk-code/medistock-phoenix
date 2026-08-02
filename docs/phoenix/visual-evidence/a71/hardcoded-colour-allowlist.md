# A7.1 — Hardcoded colour allowlist

Full repo-wide audit (`#[0-9A-Fa-f]{3,8}` across `src/**/*.{ts,tsx,css}`,
excluding `__tests__/**`) run at the start of A7.1. Every hit was resolved one
of two ways:

1. **Converted to a Phoenix token** (see "Converted" below) — these were
   genuine operational-UI colours (or dead `var(--token, #fallback)` literals
   where the token is always defined) that had no reason to stay hex.
2. **Left as hex, and listed here** — each entry states the file, the
   selector/component, and why it does not belong in the token system.

No hex remains in any card, button, header, form, nav item, dialog, or
operational page background outside the categories below.

## Converted to tokens (this pass)

New tokens added to `src/shared/lib/tokens.css` (`:root`, constant across
themes — same value the literal it replaces already rendered, so this is a
relocation, not a colour change):

| Token | Value | Replaces |
|---|---|---|
| `--on-accent` | `#fff` | `color: '#fff'` on solid `--p`/`--ember` fills (tab-active pills, unread badge) |
| `--risk-tier-3m` / `-bg` | `#DC2626` / `#FEF2F2` | `materialAlertEngine.getExpiryBucketStyle('3_months')` |
| `--risk-tier-9m` / `-bg` | `#B45309` / `#FEF3C7` | `getExpiryBucketStyle('9_months')` |
| `--whatsapp-brand` / `-bg` / `-ink` | `#25D366` / `#E9FBF1` / `#0D7A3F` | `WhatsAppContactButton`'s inline style |

Files edited (hex → `var(--token)`, or a dead `var(--token, #hex)` fallback
stripped to `var(--token)` because the token is always defined — see
`phase-a-visual-convergence.css`'s always-on root marker and `tokens.css`'s
unconditional `:root`/`[data-theme]` blocks):

- `src/features/alerts/materialAlertEngine.ts`
- `src/shared/ui/WhatsAppContactButton.tsx`
- `src/shared/ui/PhoenixButton.tsx`
- `src/shared/ui/NotificationBell.tsx`
- `src/features/auth/ResetPasswordScreen.tsx`
- `src/features/network/NetworkManagementScreen.tsx`
- `src/features/network/DirectSupplyOperations.tsx`
- `src/features/outlet/OutletDispatchOperations.tsx`
- `src/features/reports/ReportsScreen.tsx`
- `src/features/procurement/DirectEntryPanel.tsx` (`var(--warn-bg, #fff7e6)` →
  `var(--warn2)`, unifying it with the identical warning-background pattern
  already used elsewhere, e.g. `UserManagementScreen`'s password-mode notice)
- `src/shared/lib/phoenix-nexus.css` (`.nexus-pulse__*` loader — dead
  `var(--gold, #hex)` / `var(--sec, #hex)` fallbacks stripped)

## Left as hex — documented exceptions

### 1. WebGL / 3D data-visualization scenes
Real-time Three.js material/light colours are JS values passed to a
`THREE.Color`/`<meshStandardMaterial color=…>` prop, not CSS — they cannot
read a CSS custom property at all, and the digital-twin map is explicitly the
one surface the brief allows to stay a dark, always-on data visualization.

| File | Selector/component | Reason |
|---|---|---|
| `src/shared/webgl/PhoenixScene.tsx` | `THREE.Color(...)` palette | WebGL material colours |
| `src/shared/webgl/PhoenixWelcomeScene.tsx` | `THREE.Color(...)` palette | WebGL material colours (component is currently unused by `PhoenixWelcomeExperience`, which renders a static image instead — left as-is, not deleted, since removing dead code was out of scope for this pass) |
| `src/shared/webgl/NetworkTwin3DScene.tsx` | node/route/light materials | The digital-twin map — the one surface the brief explicitly allows to stay a dark data-visualization canvas |

### 2. QR code generation and its scan-contrast container
A QR code's own modules must render pure black-on-white (or an equally
high-contrast pair) to stay reliably scannable — tying it to the app's
light/dark theme would produce a low-contrast or inverted code on a phone
camera. This is a functional constraint, not a style choice.

| File | Selector/component | Reason |
|---|---|---|
| `src/features/institutions/InstitutionScreen.tsx:1097` | `QRCode.toDataURL(... color)` | QR modules must be pure black/white to stay scannable |
| `src/features/institutions/InstitutionScreen.tsx:1242,1519` | QR thumbnail/preview container `background:'#fff'` | White quiet-zone behind the black/white QR image |
| `src/features/qr/QrScreen.tsx:166` | `QRCode.toDataURL(... color)` | Same as above |
| `src/features/movement/ui/MovementDocumentActions.tsx:39` | `QRCode.toDataURL(... color)` | Same as above |

### 3. Print / export HTML (own document, not the app's theme)
Each of these builds a **complete, standalone HTML document** (own
`<html>`/`<body>`, `@page` rules) handed to `window.print()`, a download
Blob, or a mobile print-preview `<iframe srcDoc>`. A printed page is always
white paper with black ink regardless of whether the operator's screen is in
dark mode — that is the stable, expected contract for anything with a
"print" or "export" affordance, and is unrelated to `data-theme`.

| File | Reason |
|---|---|
| `src/shared/lib/reportExport.ts` | Report print/export HTML document |
| `src/shared/lib/professional-export.ts` | Report print/export HTML document (incl. the row-accent `#DC2626`/`#D97706`/`#059669` inside the same template) |
| `src/features/movement/receipt-html.ts` | Movement receipt print HTML document |
| `src/features/status/StatusCenterScreen.tsx` | Print HTML template (legacy screen 12, retired from routing — the print function itself is unchanged either way) |
| `src/features/status/MovementReportSection.tsx` | Print HTML template |
| `src/features/reports/DecisionIntelligenceReportsScreen.tsx` | Print HTML template (screen 21's own print/export action — the *screen* is fully converged; only its print output stays print-styled) |
| `src/features/movement/ui/MovementPrintFieldSelector.tsx:163` | Print-preview scroll area `background:'#fff'` — mirrors the paper the selected fields will print onto |
| `src/shared/ui/MobilePrintFallbackModal.tsx:92` | `<iframe srcDoc>` showing the SAME print HTML document above; the white background frames that white page |

### 4. Camera/video viewfinder backdrop
A `<video>` element showing a live camera feed needs an opaque black
backdrop before the stream attaches (and behind any letterboxing) — the same
"always dark, not a themed surface" reasoning as the WebGL canvas.

| File | Selector | Reason |
|---|---|---|
| `src/shared/materials/SmartScanner.tsx:211` | `<video>` background | Camera viewfinder backdrop |

### 5. PWA manifest / meta theme-color
The installed-app chrome colour (Android/iOS "add to home screen" splash
and status-bar tint) is a static value baked into `manifest.json` and an
HTML `<meta name="theme-color">` tag at build time — neither can reference a
CSS custom property, and both are asserted by name in existing tests.

| File | Reason |
|---|---|
| PWA manifest generation + `<meta name="theme-color">` (asserted in `pwa-install-prompt.test.ts`, `phoenix-nexus-design.test.ts`) | Static manifest/meta value, not CSS |

### 6. CSS `mask-image` alpha stops
`#000`/`transparent` inside a `mask-image` gradient is a luminance/alpha
stop controlling *visibility*, not a rendered colour — nothing on screen is
ever painted black. Retokenizing these would add indirection with zero
visual effect.

| File | Selector | Reason |
|---|---|---|
| `src/shared/lib/phoenix-nexus.css` | multiple `.nexus-login__*`/`.nexus-welcome*` `mask-image` rules | Alpha-only mask stops, not a visible colour |
| `src/shared/lib/phase-a-auth.css` | `.nexus-login__art` mask-image | Same |
| `src/shared/lib/phase-a-institutions-outlets.css`, `phase-a-inventory-transfers.css` | table/list edge-fade masks | Same |

### 7. Token-definition sites
`tokens.css` and `phase-a-visual-convergence.css`'s `html[data-phoenix-ui-
phase='a'][data-phoenix-visual='daylight']` block are the two places design
tokens are *defined* (`--phoenix-gold: #C9962E;` etc.) — hex belongs there by
construction; every consumer reads the token, never the literal.

### 8. Dev-only QA harness banner (not shipped)
`src/features/qa/QaHarness.tsx`'s "QA ONLY" corner banner is gated behind
`import.meta.env.DEV && VITE_ENABLE_VISUAL_QA==='true'` and tree-shaken from
every production build (`tests/qa-harness-production-safety.test.ts`) — it is
never operational UI a real user can see, so it was left untouched.

### 9. Box-shadow/glow tinting anchored to a fixed dark colour
A handful of `box-shadow`/`mask` declarations use `color-mix(in srgb, #07111f
NN%, transparent)` (or similar) purely to tint a shadow/glow — the same
"shadows are always a dark anchor regardless of theme" convention
`tokens.css`'s own `--sh-*` tokens already use (`rgba(0,0,0,.4)` etc., never
themed). Structural depth-effect values, not a surface/text/border colour a
user reads as "the app's palette" — left as-is, same category as #6 above.
