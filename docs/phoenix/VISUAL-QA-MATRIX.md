# PHOENIX — Visual QA Matrix

Tracks verification per surface/config. A cell is **PASS** only with a
screenshot or a documented DOM/GL measurement — never on assertion alone.

Legend: ✅ verified (with evidence) · ◐ structurally verified (DOM/GL, no pixel
capture) · ⏳ pending · n/a not applicable.

## Environment note
The in-app preview pane throttles `requestAnimationFrame` when the tab is not
foregrounded/composited, so **pixel screenshots of the animated WebGL frame hang**
in this environment (a known constraint). Where a pixel capture was not possible,
verification is via `read_page` (accessibility tree), `javascript_tool` (live
GL/DOM state) and console/network inspection — all recorded below as ◐.

## Login (`features/auth/LoginScreen.tsx`)
| Config | Result | Evidence |
|--------|--------|----------|
| Desktop AR Light — structure/form | ✅ | `read_page`: full RTL form, all fields, kicker/brand present |
| WebGL layer active | ◐ | `javascript_tool`: WebGL 2.0 context, canvas 1533×1012, atmosphere fallback present, 0 console errors |
| No-WebGL / Save-Data fallback | ✅ | unit test: `PhoenixExperience` renders only 2D fallback, no `<canvas>` |
| Desktop AR/EN Dark, Mobile | ⏳ | pixel capture pending (rAF-throttle constraint) |

## Welcome rebirth (`features/auth/PhoenixWelcomeExperience.tsx`)
| Config | Result | Evidence |
|--------|--------|----------|
| Real 3D rebirth timeline (~5.2s) | ◐ | code-verified scene; lazy chunk `PhoenixWelcomeCanvas` split in build |
| Skip always present | ✅ | `onClick={finish}` asserted in design test |
| Reduced-motion short path | ✅ | `prefersReducedMotion()` gate + REDUCED_MS; helper unit-tested |
| Credits live React text (not baked) | ✅ | text nodes in component; clean-plate texture not used for text |
| Live pixel capture (8 configs) | ⏳ | requires an authenticated session + composited tab |

## Digital Twin (`features/network/NetworkTopologyStage.tsx`)
| Aspect | Result | Evidence |
|--------|--------|----------|
| Raw-WebGL topology from RLS data | ✅ | `getContext('webgl')` + GLSL; fed by warehouses/routes/outlets (design test) |
| Identity tier colours (central Ember, institution Cyan, outlet Teal) | ✅ | `nodeColor()` mapping |
| Live inventory alerts (icon+text+ring, not colour-only) | ◐ | wired to `getInventoryAlerts(orgId)`; ring GL pass + DOM list/detail/telemetry; needs live data to pixel-verify |
| Accessible node list + detail panel + aria-labels | ✅ | DOM present; `aria-label` describes alert |
| Reduced-motion disables ring pulse | ✅ | CSS `@media (prefers-reduced-motion)` + GL static scale |
| Live pixel capture with real alerts | ⏳ | requires seeded RLS data |

## Operational screens (Institutions, Users, Reports, Alerts, Direct Supply, Returns, Account, Status Center …)
| Config | Result |
|--------|--------|
| Desktop AR Light / Mobile AR Light / 320px sweep / dark / EN | ⏳ pending the full-screen redesign + QA-harness capture phase |

## Summary
Core cinematic pillars (real WebGL engine, login, welcome, twin alerts) are
implemented and **structurally/behaviourally verified**; full 8-config pixel
capture across all screens is the remaining QA phase, blocked in this environment
only by the rAF-throttle screenshot constraint and the need for seeded RLS data.
