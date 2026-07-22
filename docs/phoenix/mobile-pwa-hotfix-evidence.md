# MOBILE-PWA-PRESENTATION-HOTFIX — measured evidence

Branch `hotfix/phoenix-mobile-pwa-presentation` from master `1c7dc739`.
All measurements below were taken live in a Chromium pane against the running
app (QA harness, fixture personas — zero database writes), via
`getBoundingClientRect`/`scrollHeight` instrumentation. They back the
source-contract assertions in `src/shared/ui/__tests__/mobile-pwa-hotfix.test.ts`.

## Defect 1 — mobile scroll / covered content

Reproduction @360×800 (before, master 1c7dc739), Outlet Operations scene:

| metric | value |
|---|---|
| document scrollable | **true** (document owned the scroll) |
| `.premium-main` scrollable | false (`scrollHeight == clientHeight`) |
| last element bottom after full scroll | **730px** |
| bottom-nav top | 728px → **content 2px under the nav; grows with content length** |
| pinned seal band | y 674–722 overlapping content; FAB at y 670 |

After fix (same scene/viewport):

| metric | value |
|---|---|
| document scrollable | **false** |
| `.premium-main` owns scroll | **true** (`scrollHeight 798 > clientHeight 735`, overflow-y auto) |
| last element bottom after full scroll | **680px** |
| clear of seal (top 687) | **true** |
| clear of bottom nav (top 728) | **true** |
| main bottom padding | 136px = `--bnh` + `--nx-seal-clearance` + 18px + safe-area |

Mechanism: shell `height:100vh/100dvh` + `overflow:clip`; `.nexus-app-column`
`min-height:0`; `<main>` `minHeight:0; overflow-y:auto` = the single scroll
owner. Seal `pointer-events:none`, scaled .78, safe-area aware; the floating
search retreats while `html[data-keyboard="open"]` (visualViewport marker).

## Defect 2 — Welcome Phoenix amputation

@360×800 (before): `object-fit: cover` on the 1672×941 clean plate —
**visible fraction of master width = 0.25** (75% of the bird, both wings and
tail, cropped away).

After fix: `@media (max-aspect-ratio: 5/4)` switches the plate to
`object-fit: contain`: **visible fraction = 1.00 (width and height)**; bird
band y 272–479, masthead ends y 110, credits begin y 505 — text fully clear of
the face, medical chest and principal wing details. Desktop/landscape keeps
`cover` with the approved `center 44%` focal point. Reduced-motion is honored
by the existing `.nexus-shell`/welcome `prefers-reduced-motion` blocks.

## Defect 3 — inert/duplicated search

Live behavior after fix:

- Institutions scene (has a local `input[type="search"]`): tapping the
  floating magnifier **focused the local field** (`document.activeElement`
  check) and did **not** open the palette.
- Inventory scene (no local field): the same control opened the palette; the
  decorated Arabic query **`مُشتريات`** (with ḍamma) matched
  **«المشتريات المحلية»**, highlighted `مشتريات` via `<mark>`, and reported
  **«1 نتيجة»** with a working clear (✕) button.
- Institution records search runs over the RLS-scoped `getOrganizations()`
  rows only (lazily fetched on palette open), matching AR/EN name, code and
  city under normalization (hamza seats, ة/ه, ى/ي, harakat/tatweel stripped,
  case-folded).

## Defect 4 — old app icons

- Every runtime icon is regenerated from
  `design/phoenix-source/phoenix-app-icon-master.png` (2048² photorealistic 3D
  Phoenix, teal medical chest, obsidian field) by
  `scripts/phoenix-app-icons.mjs` — pure crop/resize/re-encode.
- Versioned references: `phoenix-favicon-v2.{svg,ico}`,
  `phoenix-favicon-v2-{16,32,48,64,128}.png`, `apple-touch-icon-v2.png`,
  `pwa-icon-v2-{192,512}.png`, `pwa-icon-maskable-v2-{192,512}.png` (feathered
  safe-zone composite). `index.html` + `manifest.webmanifest` reference only
  the v2 names; the retired filenames remain on disk **overwritten with the
  new identity** so stale caches can never resurface the old emblem.
- Manifest `start_url`/`scope` unchanged, no `id` added — same installed app.
- `sw.js` `CACHE_VERSION` bumped `medistock-shell-v1 → v2`; activation deletes
  only non-current app-shell caches (Supabase/API traffic is never cached).
- Contract test: `auth-brand-icon-mobile-logout-passkey.test.ts` fails if any
  runtime favicon/manifest/app-icon reference targets a retired asset.
- No Electron/Tauri wrapper exists in this repository — no desktop installer
  resources to regenerate.

## Cache refresh instructions (operators)

Browser tab icon: hard refresh (Ctrl+F5). Installed PWA icon on Android:
Chrome → Settings → Site settings → medistock-qr-network.vercel.app → clear,
or uninstall/reinstall the shortcut — Android refreshes manifest icons on its
own schedule (up to ~24h) once the updated manifest is fetched. The service
worker updates itself on next load (skipWaiting + clients.claim) and discards
the v1 shell cache.
