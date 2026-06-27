# MediStock Phoenix V2 — New Design Adoption Guide

**Created:** 2026-06-27  
**Design source (sole authority):** `design-source/MediStock-Babil.dc.html`

---

## Core Principle

The design file is the ONLY approved source for all UI/UX decisions. The old project's visual design is NOT referenced. When in doubt, open the design file.

---

## Token System

All design tokens live in `src/shared/lib/tokens.css` and are verbatim from the design file.

### Color Roles

| Variable | Light | Dark | Usage |
|----------|-------|------|-------|
| `--bg` | `#F8F9FA` | `#0F1117` | Page background |
| `--s` | `#FFFFFF` | `#1A1D27` | Card / surface |
| `--s2` | `#F1F5F9` | `#252836` | Nested surface |
| `--b` | `#E2E8F0` | `#2D3148` | Border |
| `--t` | `#0F172A` | `#F1F5F9` | Primary text |
| `--t2` | `#64748B` | `#94A3B8` | Secondary text |
| `--t3` | `#94A3B8` | `#64748B` | Muted text |
| `--p` | `#0D9488` | `#0D9488` | Primary (teal) |
| `--p2` | `#CCFBF1` | `#042F2E` | Primary tint |
| `--p3` | `#0F766E` | `#14B8A6` | Primary dark |
| `--warn` | `#F59E0B` | `#F59E0B` | Warning |
| `--err` | `#EF4444` | `#EF4444` | Error |
| `--ok` | `#10B981` | `#10B981` | Success |
| `--info` | `#3B82F6` | `#3B82F6` | Info |

### Layout Variables

| Variable | Value | Usage |
|----------|-------|-------|
| `--sw` | `248px` | Sidebar width |
| `--tbh` | `58px` | Topbar height |
| `--bnh` | `68px` | Bottom nav height |

### Radius Scale

| Variable | Value |
|----------|-------|
| `--r1` | `4px` |
| `--r2` | `8px` |
| `--r3` | `12px` |
| `--r4` | `16px` |
| `--r5` | `24px` |
| `--rpill` | `999px` |

### Shadow Scale

| Variable | Usage |
|----------|-------|
| `--xs` | Subtle badge |
| `--sm` | Input focus ring |
| `--md` | Card default |
| `--lg` | Dialog / dropdown |
| `--xl` | Modal overlay |

---

## Component Library (shared/ui/)

All Phoenix UI primitives are in `src/shared/ui/`. Do not import from old project.

| Component | File | Usage |
|-----------|------|-------|
| PhoenixCard | PhoenixCard.tsx | All card containers |
| PhoenixButton | PhoenixButton.tsx | All interactive buttons |
| PhoenixStatusBadge | PhoenixStatusBadge.tsx | Status pills |
| PhoenixInput | PhoenixInput.tsx | All text inputs |
| PhoenixSelect | PhoenixSelect.tsx | All dropdowns |
| PhoenixDialog | PhoenixDialog.tsx | Modal dialogs |
| PhoenixMetricCard | PhoenixMetricCard.tsx | Dashboard KPI cards |
| PhoenixEmptyState | PhoenixEmptyState.tsx | Empty list state |
| PhoenixLoadingState | PhoenixLoadingState.tsx | Loading spinner |
| PhoenixErrorState | PhoenixErrorState.tsx | Error display |
| PhoenixSidebar | PhoenixSidebar.tsx | Desktop 248px sidebar |
| PhoenixMobileDrawer | PhoenixMobileDrawer.tsx | Mobile overlay menu |
| PhoenixTopbar | PhoenixTopbar.tsx | 58px sticky header |
| PhoenixMobileBottomNav | PhoenixMobileBottomNav.tsx | 68px fixed bottom nav |
| PhoenixAppShell | PhoenixAppShell.tsx | Orchestrates all layout |
| PhoenixToast | PhoenixToast.tsx | Notification toasts |

---

## Responsive Rules

- **Mobile-first:** 320–390px default, breakpoint at `window.innerWidth < 768`
- **No hardcoded `left`/`right`** — use `inset-inline-start/end` and `margin-inline-*`
- **Sidebar:** desktop only (`≥768px`), hidden on mobile
- **Bottom nav:** mobile only (`<768px`), hidden on desktop
- **Grid:** `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`
- **Tap targets:** `min-height: 44px` on all interactive mobile elements

---

## RTL / LTR Rules

- `<html lang dir>` attributes are synced by `AppContext`
- Arabic = `dir="rtl"`, English = `dir="ltr"`
- CSS logical properties handle direction automatically
- `PhoenixSidebar` uses `inset-inline-start: 0`
- `PhoenixMobileDrawer` uses `inset-inline-start: 0` (slides in from start)
- Icons that are directional (arrows, chevrons) must use `transform: scaleX(var(--rtl-flip, 1))` where `--rtl-flip: -1` in RTL

---

## i18n Rules

- All strings in `src/shared/i18n/strings.ts`
- Access via `t(key, lang)` — never hardcode Arabic or English in JSX
- Add new keys to BOTH `ar` and `en` sections simultaneously
- Status/condition keys in the same dict (no separate status file)
- Key naming: `snake_case`, descriptive, no abbreviations

---

## Animation Keyframes

All animations are defined in `global.css`:

| Name | Usage |
|------|-------|
| `fs` | Fade + scale in (cards, dialogs) |
| `su` | Slide up (dialogs, sheets) |
| `si` | Slide in from inline-start (mobile drawer) |
| `bp` | Badge pop (notification appearance) |
| `fl` | Float (login blobs) |
| `spin` | Rotation (loading ring) |
| `ti` | Toast in (notification) |

`prefers-reduced-motion` disables all animations.

---

## State Requirements

Every data-displaying component must handle all four states:

1. **Loading** — `PhoenixLoadingState` with descriptive label
2. **Error** — `PhoenixErrorState` with retry callback
3. **Empty** — `PhoenixEmptyState` with icon + bilingual message + optional action
4. **Data** — the actual content

No state may silently show blank content.

---

## Frozen Module Visual Pattern

The `IntakeFrozenScreen` sets the standard for frozen/blocked modules:

- Dashed border container with `--warn` color tint
- 🔒 icon + bilingual title explaining the block
- Grid of blocked workflow cards at `opacity: 0.55`
- Redirect CTA to the available alternative (EditorScreen)
- Never show interactive elements for frozen features
