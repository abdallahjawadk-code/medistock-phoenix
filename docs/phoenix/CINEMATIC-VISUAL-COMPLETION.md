# Phoenix Cinematic Visual Completion — evidence matrix

Final visual pass over every reachable screen, under a strict FUNCTIONAL FREEZE:
no migration, RPC, RLS/RBAC, permission, routing-contract, screen-number,
business-logic, stock, OCR, QR, or lifecycle change; migrations 085/086/087 stay
unapplied; nothing merged or deployed. Live files are authoritative — no old
design branch was cherry-picked wholesale.

## What changed this pass

- **Login family** — the light-mode rights-block contrast defect is corrected
  (the 62%-transparent `--t3` plus Phoenix gold failed on the light glass card;
  light theme now uses deep slate + bronze at ≥4.5:1). The stale pre-redesign
  login CSS (full-bleed composite, orbit/node/beam mock, welcome orbit/progress
  era) was deleted after proving no component references it; the one live bug it
  masked — a `≤940px` block losing to the later base template and leaving a
  phantom art column that squeezed the tablet form to one side — is fixed by
  consolidating the responsive rules after the base with an explicit single
  `form` grid area in both directions. Form stays physically LEFT, the approved
  photoreal Phoenix (fiery wing / gold-pearl wing / teal medical chest) fills
  the RIGHT on desktop/tablet; mobile is form-first with the brand mark.
- **Welcome** — unchanged art direction (full-screen approved clean-plate
  Phoenix, live React credits verbatim: `دائرة صحة بابل - قسم الصيدلة`,
  `تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم`,
  `بإشراف الصيدلاني باسم كاظم رمح`); reverified intact after the CSS cleanup.
- **Brand** — the browser-tab favicon is now the approved Phoenix mark (was a
  hand-drawn generic SVG bird), consistent with the sidebar / mobile-drawer /
  loader / PWA identity already carried by `PhoenixMark`.
- **Navigation** — Screen 19 (Local Procurement) added to the mobile drawer so
  it is reachable there as on the desktop sidebar and command palette; the
  realistic Phoenix mark shows in both nav surfaces.
- **Icon unification** — the last two RAW rendered emoji glyphs became
  deterministic `PhoenixIcon` SVGs (OCR Beta banner warning; print-field-selector
  lock). Remaining `PhoenixEmptyState icon="<emoji>"` props already resolve to
  SVG through the empty-state icon map — not raw emoji.
- **QA harness** — Screen 19 wired in as a new `procurement` scene with DEV-only
  fixtures spanning every lifecycle status, one receipt with lines, a
  provenance-pinned return and the order trail, so the workspace is captured
  against real controls. Nothing writes: every mutation resolves to the fixture
  client's read-only error, and the whole harness tree-shakes out of production
  (`tests/qa-harness-production-safety.test.ts`).

## Evidence captured (headless Chrome, reduced-motion, compositing frozen)

| Family | Cells | Notes |
| --- | --- | --- |
| Login | 12 | AR/EN × dark/light × desktop/tablet/mobile |
| Welcome | 12 | approved artwork + live credits + seal |
| Shell | 16 | sidebar/topbar/bottom-nav + mobile drawer, realistic mark, Screen 19 nav |
| Dashboard | 12 | hero stock-health ring + KPI tiles |
| Inventory Center | 4 | unified shell, tabs, ledger-derived banner |
| Local Procurement (19) | 62 | 5 tabs × AR/EN × dark/light × desktop/tablet/mobile, an order detail showing the official receipt (Print · Excel · QR) + Return, and an honest no-warehouse-scope denied state |

Loading / empty / error states are exercised by the harness `states` scene and
appear inside the shell captures; the procurement no-scope shot is a genuine
062-scope denial (an outlet_officer persona with no institution-warehouse
assignment), not a staged blank.

## Quality bars held

AR/EN and RTL/LTR; dark/light; desktop/tablet/mobile; ≥44px touch targets and
visible focus (shell a11y tests); reduced-motion honoured; WebGL stays
lazy-loaded with a 2D fallback and is never used for critical text/forms/tables.
Typecheck, production build, and lint (established `--max-warnings 4` baseline,
0 new warnings) all pass; the full test suite passes apart from the two
documented working-tree guards that the CI workflow provisions in its
"Prepare CI-only local guard fixtures" step (`premium-preview.html`, the
SECURITY.md stash) — green on CI.
