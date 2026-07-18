# Phoenix Nexus — Source asset manifest

This manifest records every first-party visual source used by the W2/final-cinematic interface. No asset in this layer is loaded from a CDN or remote hotlink.

| Asset | Source type | Purpose | Variants / exports | Consumers | Origin / license |
|---|---|---|---|---|---|
| `public/app-icon.svg` | Editable SVG | Canonical application/PWA identity | Source for 192, 512, maskable and Apple touch exports | Manifest, install surfaces | First-party MediStock asset already tracked in the repository |
| `public/favicon.svg` | Editable SVG | Browser favicon | Light/dark-safe vector | `index.html` | First-party MediStock asset already tracked in the repository |
| `public/pwa-icon-192.png` | PNG export | PWA launcher | 192×192 | `manifest.webmanifest` | Locally generated from `app-icon.svg` |
| `public/pwa-icon-512.png` | PNG export | PWA launcher | 512×512 | `manifest.webmanifest` | Locally generated from `app-icon.svg` |
| `public/pwa-icon-maskable-512.png` | PNG export | Maskable PWA launcher | 512×512, safe-zone composition | `manifest.webmanifest` | Locally generated from `app-icon.svg` |
| `public/apple-touch-icon.png` | PNG export | iOS home-screen identity | Apple touch export | `index.html` | Locally generated from `app-icon.svg` |
| `public/phoenix-circuit-field.svg` | Editable SVG | Subtle circuit/network atmosphere, never semantic content | Responsive 1600×900 transparent field | Auth recovery, public QR, authenticated workspace | Original first-party W2 artwork; no external source |
| `src/shared/ui/PhoenixMark.tsx` | Code-native SVG | Phoenix brand mark inside the React UI | Inherits accessible title usage | Welcome, recovery, public QR, PWA prompt, loading | First-party MediStock component |
| `src/shared/ui/PhoenixIcon.tsx` | Code-native SVG set | All semantic UI iconography | `currentColor`, 24×24 viewBox, 1.75 stroke | Navigation, screen headers, metrics, notices, actions, states | Original first-party line-icon set; no external library |

## Iconography contract

- Product UI must use `PhoenixIcon` or `PhoenixMark`; emoji and Unicode glyphs are not product icons.
- Decorative icons are `aria-hidden`; icon-only controls require an accessible label; semantic brand marks receive a title when no adjacent label exists.
- All icons use `currentColor` so light/dark, forced-colors and screen accents remain consistent.
- New icons must retain the 24×24 viewBox, round caps/joins and 1.75 default stroke.
- Raster exports are derivatives only. The editable SVG/React source must remain tracked.
- Screenshots are QA evidence and are not source assets.

## Missing external references

No additional official logo, institution photography, map illustration or licensed image pack was supplied with this work. The implementation therefore preserves the repository’s canonical Phoenix identity and uses an original abstract circuit field. It does not invent or claim to reproduce unavailable brand imagery.
