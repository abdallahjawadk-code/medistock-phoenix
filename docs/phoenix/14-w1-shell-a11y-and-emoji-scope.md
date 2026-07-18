# W1 — Shell accessibility closure & emoji-removal scope of record

Status: **W1 correction landed on `feat/webgl-phoenix-experience` (PR #32).** Not merged.
No W2/W3 work, no migration, and no DB write are part of this change.

## 1. What this correction changed (shell a11y)

The interactive **shell** chrome was brought to accessibility baseline:

- **Touch targets ≥ 44×44px** (WCAG 2.5.5 / 2.5.8) for every interactive shell
  control — language toggle, theme toggle, mobile menu trigger, mobile
  drawer-close — via the single `--touch-target: 44px` token and logical
  `min-inline-size` / `min-block-size`. Bottom-nav items and the command
  trigger already met the baseline and are locked in by regression tests.
  The compact glyphs stay visually centered, so the balanced look on both
  phone and desktop is preserved.
- **Real keyboard `focus-visible`**: a two-tone ring — a 3px accent outline
  (offset, so it reads as an added *shape*, not a recolor) plus a contrasting
  halo whose tone **flips light↔dark per theme** (`--focus-ring` /
  `--focus-ring-contrast`). The indicator is legible in day and night mode and
  does **not** depend on hue alone (WCAG 1.4.1 / 1.4.11 / 2.4.7).
- **No horizontal overflow** after the enlarged targets: the shell keeps
  `overflow: clip`, and the topbar title is the flexible (`min-width:0; flex:1`)
  element while the fixed 44px controls stay `flex-shrink:0`.

Regression coverage: `src/shared/ui/__tests__/shell-touch-targets-focus-a11y.test.ts`
(touch-target sizing, focus-visible presence + light/dark contrast + non-color
cue, and no-horizontal-overflow contracts).

### Verification evidence (5 states)

Captured against the real production CSS (`tokens.css` + `global.css` +
`phoenix-nexus.css`) served by the dev server, each with a live in-page audit of
every control's measured box and the page overflow check. Reproduce with the
committed harness (loads the real CSS): run `npm run dev`, then open
`/docs/phoenix/w1-shell-a11y-preview.html?lang=ar&theme=dark` (vary `lang`
`ar`/`en` and `theme` `light`/`dark`; resize to 375px for mobile; press Tab to
reveal the focus ring):

| State | Result |
|-------|--------|
| Desktop AR (light, RTL) | menu 44×44, lang 45×44, theme 44×44 — no h-overflow |
| Desktop AR (dark, RTL) | all ≥44×44; focus ring visible on Tab |
| Mobile AR (light, RTL, 375px) | all ≥44×44; sw=375/iw=375 — no h-overflow |
| Mobile AR (dark, RTL, 375px) | all ≥44×44 — no h-overflow |
| Desktop EN (light, LTR) | all ≥44×44; focus ring visible on Tab (light contrast) |

## 2. Emoji removal — deferred to W4, per-screen (scope of record)

**The application is NOT SVG-only.** Only the **shell, auth, and the explicitly
cleaned surfaces** have been converted to the deterministic `PhoenixIcon` SVG
system and are locked emoji-free by
`src/shared/ui/__tests__/no-emoji-icons-cleaned-surfaces.test.ts`:

- `features/auth/LoginScreen.tsx`, `features/auth/ResetPasswordScreen.tsx`
- `shared/ui/PhoenixAppShell.tsx`, `PhoenixSidebar.tsx`,
  `PhoenixMobileDrawer.tsx`, `PhoenixMobileBottomNav.tsx`, `CommandPalette.tsx`,
  `PhoenixTopbar.tsx`

**Still carrying emoji: ~255 glyph occurrences across ~29 feature/content
screens** (the "~170 icon-emoji" set referenced in review, plus incidental
pictographs). Their removal is **deferred to W4 and done per-screen**, under
these rules:

- Code and tests are updated **together**, one screen at a time; each cleaned
  screen is then added to the `CLEANED_SURFACES` ratchet so it cannot regress.
- **No behavior test is deleted or weakened** to accommodate an icon swap. Icon
  presentation changes must not touch behavioral assertions (permissions, data
  flow, lifecycle, pricing/safety math).
- No blanket "convert everything" pass — the per-screen boundary keeps each
  change reviewable and keeps behavior coverage intact.

## 3. Explicit non-goals of this change

- Not merged; PR #32 is moved to *Ready* for independent review only.
- No W2 / W3 work started.
- No database migration, no DB write.
