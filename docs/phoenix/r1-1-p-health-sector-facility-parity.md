# R1.1-P — Health-Sector Cross-Surface Facility Parity

**Stage kind:** frontend / UX / parity / tests / documentation.
**Database impact:** none.

> **R1.1-P changes no database corridor and creates no migration.**
> No migration 184 exists. Migrations 001–183 are untouched. No RPC was added,
> renamed, or wrapped. No permission key was granted. No RLS policy was altered.
> Every rule below is already enforced server-side by migrations 164, 165, 168,
> 180, 181, 182 and 183; this stage makes the interface stop contradicting them.

---

## 1. Facility-safe screens

`health_center_manager` is a **facility-scoped** role: its authority is a set of
health centres, not an organization. It may occupy exactly four screens.

| Screen | Surface | Why it is facility-safe |
|---|---|---|
| **3** | Inventory Center | Scopes through `useInventoryScopes`, whose warehouse set is facility-derived and excludes the sector main. |
| **6** | QR | `qr_targets` / `qr_tokens` are narrowed to assigned resources (Migration 182 §9c-2). |
| **15** | My Account | The caller's own profile row only. |
| **18** | Outlet Operations | The role landing. Every read resolves through `phoenix_profile_has_point_assignment`. |

This is an **allow-list**, not a deny-list (`FACILITY_SAFE_SCREENS` in
`src/shared/authz/screen-access.ts`). A screen added later is refused to this
role until someone proves it facility-safe and names it there. A deny-list would
silently admit every future organization-level surface.

### What R1.1-P fixed

`isScreenAuthorized` was already canonical, and the route guard
(`AuthenticatedApp.tsx`) and the restore path (`screen-continuity.ts`) already
used it. The four **visible navigation surfaces** did not — each carried its own
historical gates and offered Reports (21), Inter-Institution Alerts (13) and
Local Procurement (19) to a facility-scoped manager, whose every click was then
bounced back to the landing screen.

All four now intersect their candidate list with the one decision, through
`projectNavigation` (`src/shared/authz/nav-projection.ts`):

- `PhoenixSidebar.tsx`
- `PhoenixMobileDrawer.tsx`
- `PhoenixMobileBottomNav.tsx`
- `CommandPalette.tsx`

The users.view / users.edit_scope / institutions predicates those components
used to hand-copy are **reproduced exactly** inside `isScreenAuthorized`, so no
historical role's menu moved. The bottom bar **removes** unauthorized slots
rather than re-pointing them at a safe destination — a shortcut must not lie
about where it goes — and hides itself entirely when nothing survives.

The command palette additionally **does not perform its `getOrganizations()`
read at all** for a caller who cannot reach screen 11. RLS scoping was the wrong
boundary there: a facility-scoped manager belongs to a health *sector*
organization and can read that row, so the palette used to list it as a
navigable institution hit into a screen the guard refuses.

> **Recorded side effect, beyond the facility-scoped case.** That gate is
> `isScreenAuthorized(11, …)`, which is also false for
> `central_warehouse_manager`, `warehouse_officer` and `outlet_officer`. Those
> three roles previously saw institution-record hits (name / code / city) in the
> palette and no longer do. **No action is lost** — every such hit called
> `choose(11)`, and `AuthenticatedApp.tsx` coerces an unauthorized screen to
> `roleLandingScreen(...)` *before* the router's switch, so these roles were
> silently redirected to their landing screen instead of reaching the
> institutions page. (They never saw the `case 11` Forbidden screen: that branch
> is unreachable for any role the guard already refuses.) So the destination was
> always a redirect, and only the *lookup* is gone. Named here rather than left
> to be rediscovered, since P1-B is otherwise framed as a facility-scope change.

---

## 2. Facility-derived resources

A health-centre manager holds **no** warehouse or outlet scope rows. It holds
facilities, and its resources are derived from them (`useInventoryScopes`,
mirroring Migration 182):

```
warehouse → manageable when facility_id IS NOT NULL AND that facility is assigned
outlet    → manageable when its OWNING warehouse is
```

- A manager assigned Facility **A** sees A's depot and A's outlets.
- A manager assigned **A + B** sees both, as two facilities — never widened into
  organization scope.
- A manager assigned **A** never sees **B**.
- No direct warehouse or outlet scope is invented anywhere.

---

## 3. Sector Main structural exclusion

The sector main is the health sector's **only** active warehouse with
`facility_id IS NULL` (Migration 181). That single fact is the exclusion
mechanism, reused everywhere rather than restated:

| Where | Effect |
|---|---|
| `useInventoryScopes` | `facilityId !== null` is required, so the sector main can never be facility-derived. |
| `outlet-affordances.ts` | `isSelectableOutletWarehouse` refuses a facility-less warehouse inside a health sector — **the sector main offers no Add Outlet affordance**. |
| `health-sector-grouping.ts` | The sector-main group carries `allowsOutlets: false`. |
| Migration 181 / 183 | Refuse the outlet server-side regardless of the UI. |

**Sector Main must never become reachable through Facility Scope**, and it never
appears as an assigned centre.

---

## 4. Health-sector presentation hierarchy

`InstitutionScreen`'s `PortSection` rendered one flat `points.map(...)`. For a
health sector it now renders the canonical topology
(`src/shared/lib/health-sector-grouping.ts`):

```
Health Sector (organization)
  ├─ Sector Main            — the supply root. Its depot. NO outlets.
  ├─ Health Centre A        — its depot, its pharmacy, its crash cabinets
  └─ Health Centre B        — likewise, strictly separate from A
```

Hospitals and specialized centres **keep their existing flat view** — the helper
returns `null` for them, which is the caller's signal not to group.

Two properties make this trustworthy rather than merely tidy:

1. **Grouped by identity, never by name.** Membership comes only from
   `warehouses.facility_id` and `distribution_points.warehouse_id`. Two centres
   sharing a display name stay separate; renaming a facility moves nothing.
2. **No row is moved or hidden to make the picture clean.** An outlet illegally
   attached to the sector main is shown **under the sector main**, where it
   actually is, and the group is marked *legacy non-conforming*. An outlet with
   a NULL owning warehouse (Migration 181 round 2) gets an explicit
   *unassigned* section. Repair is a server-side operation with an audit trail,
   never a rendering decision.

Create and edit continue to use the **same** R1.2C shared affordances
(`selectableOutletWarehouses`, `selectableOutletPointTypes`,
`legalClinicalContexts`, `normalizeClinicalContext`, `isOutletShapeSubmittable`,
`isStoredOutletShapeLegal`). No second outlet matrix was created.

---

## 5. Direct Supply — Branch A vs Branch B

Migration 165 widened `phoenix_assert_direct_supply_endpoints` to **two** legal
branches — deliberately not a generic "institution → institution if the
organization matches" rule. Both commit through the **same existing RPC**,
`phoenix_create_direct_warehouse_transfer_request`, via
`createDirectTransferRequest`. The frontend only ever constructed Branch A.

R1.1-P exposes both as named corridors
(`src/shared/lib/direct-supply-corridors.ts`):

| | **Branch A** — Central → Institution | **Branch B** — Sector Main → Health Centre |
|---|---|---|
| Source | Active **central** warehouse | The sector main: active institution warehouse, `facility_id IS NULL`, in a `health_sector` organization |
| Destination | Hospital / specialized-centre / **health-sector main** warehouse (`facility_id IS NULL`) | Active facility-bound centre depot in the **same** organization |
| Not offered | central → health-centre depot | sector → itself; sector → a foreign sector's centre; a centre depot as source |

Branch B fails **closed**: with no source chosen, or while the source sector's
active health-centre facilities are unresolved, it offers no destinations at all
rather than falling back to every facility-bound warehouse.

### B1 — `OWNER_ACCEPTED_INTENTIONAL_BEHAVIOR_CHANGE`

> **Status: accepted by the owner on 2026-08-15.** Raised as a BLOCKER by the
> first adversarial review round, escalated, and resolved by owner decision —
> not by reversal, and not by an implementer's judgement call.

**What changed.** Migration 165 **Branch A accepts any active institution
warehouse** as a central destination — **including a facility-bound
health-centre depot** (its destination test is `warehouse_kind = 'institution'
AND status = 'active'`, with no `facility_id` condition; migrations 166, 171,
181 and 183 do not redefine it). Before R1.1-P the frontend offered exactly that
list, so `super_admin` and `central_warehouse_manager` could compose
`central → health-centre depot` and the server accepted it. **That affordance is
removed from the UI.**

**Why the owner accepted it.** The canonical product topology is:

```
Branch A   central → hospital
                   → specialized centre
                   → health-sector MAIN

Branch B   health-sector MAIN → same-sector health-centre depot
```

The removed pairing is a **legacy affordance that conflicts with that
architecture**: a centre supplied both by its sector main and directly by
central has two contradictory supply stories, which breaks the single corridor
its receipts, returns (R1.3 provenance) and stock lineage depend on. This is
therefore an intentional **product-workflow narrowing**.

**Four things this explicitly does NOT claim:**

1. **Migration 165 still permits `central → health-centre depot` server-side.**
   Nothing in R1.1-P changes that. A caller reaching the RPC by any other means
   is still accepted by the database.
2. **R1.1-P does NOT claim this UI restriction is a security boundary.** It is a
   workflow decision. UI is never a boundary in this product, and this narrowing
   is no exception.
3. **The canonical server-side prohibition is deferred to R1.3**, where the
   corridor rules and the return/provenance semantics are settled together.
4. **No Migration 184 is authorized in R1.1-P**, and none exists.

Branch B fails closed independently of all of the above; see the table's
"Not offered" row.

Returns keep their existing provenance-authorized behaviour. R1.3 return
semantics are **not** redesigned here.

---

## 6. Initial provisioning — the paired-warehouse rule

`InitialProvisioningLauncher` loaded every active institution warehouse in the
organization and offered them as a free choice of source. Inside a health sector
that list contains the sector main and every other centre's depot.

An outlet has exactly **one** owning warehouse
(`distribution_points.warehouse_id`). Initial provisioning dispatches from that
one:

- health-centre crash cabinet → **that centre's depot**; never the sector main,
  never a sibling centre;
- hospital emergency outlet → its actual paired warehouse.

The pairing is resolved once by `useInventoryScopes` and carried down
`OutletOperationsScreen → EmergencyReplenishmentTab → InitialProvisioningLauncher`.
The launcher shows it **read-only** — there is exactly one correct answer, so it
is not a question put to the operator — and offers nothing when the pairing is
unresolvable or its depot is not an active institution warehouse. Pairing is
never inferred from names.

Migrations 180 and 183 remain the final authority.

Routine emergency replenishment (Migrations 168/169) was **not** rewritten. Its
route list is already server-visible and narrowed by endpoint, and
`EmergencyReplenishmentTab` already filters to routes whose source is the
selected pharmacy. Health-centre topology remains: **centre pharmacy → same-centre
crash cabinet, and no rescue cart in a health centre.**

---

## 7. Surfaces deliberately unavailable to a health-centre manager

| Screen | Surface | Why it stays unavailable |
|---|---|---|
| 5 | Mesh | Organization-level; no facility-safe contract proven. |
| 10 | Mobile Command | Same. |
| 11 | Institution directory | `institutionsScreenAccess` refuses every non-admin role. |
| 13 | Inter-Institution Alerts | Cross-organization discovery surface. |
| 14 | User Management | Organization-wide. Refused by the allow-list — see below. |
| 17 | Network Management | Organization-wide. Refused by the allow-list — see below. |
| 19 | Local Procurement | **`health_center_manager` holds no `local_procurement.*` permission in Migration 182.** Not granted; not exposed merely because `useInventoryScopes` can derive the depot. Health-sector procurement/exchange semantics belong to **R1.3**. |
| 21 | Unified Reports | Eight tabs whose only boundary is `authenticated_rls`, which is organization-wide on several read models behind them. **`reports.view` is NOT granted.** |

**The mechanism matters, and it is stronger than the table's shorthand.** For a
facility-scoped role the refusal is the `FACILITY_SAFE_SCREENS` allow-list, not
the per-screen permission gate. Screens 14 and 17 stay refused **even if the
role somehow holds `users.view` or `users.edit_scope`** — `isScreenAuthorized`
returns the allow-list answer before those keys are ever consulted. The same is
true of 19 and 21: granting the key would not open the page. That property is
asserted directly (`r1-1-p-nav-projection.test.ts`, "holding extra keys still
cannot widen the set").

No permission was widened to make any page visible. Every action button remains
controlled by **effective permission + valid scope**, never by a role name.

---

## 8. Files changed by R1.1-P

**New (pure, no database access):**

- `src/shared/authz/nav-projection.ts` — the one navigation projection.
- `src/shared/lib/health-sector-grouping.ts` — presentation hierarchy.
- `src/shared/lib/direct-supply-corridors.ts` — Branch A / Branch B endpoints.

**Modified:**

- `src/shared/ui/PhoenixSidebar.tsx`, `PhoenixMobileDrawer.tsx`,
  `PhoenixMobileBottomNav.tsx`, `CommandPalette.tsx` — projection + palette read gate.
- `src/features/institutions/InstitutionScreen.tsx` — grouped health-sector view.
- `src/features/network/DirectSupplyOperations.tsx` — corridor selection.
- `src/features/outlet/OutletOperationsScreen.tsx`,
  `EmergencyReplenishmentTab.tsx`, `InitialProvisioningLauncher.tsx` — paired warehouse.
- `src/shared/i18n/strings.ts` — grouping and corridor labels.

**Guard tests updated, never weakened.** Where an existing guard asserted the
literal hand-copied predicates, it now asserts the shared decision plus the
absence of any local copy — a strictly stronger anti-drift claim. Where a
DB-only phase's isolation guard watched a path R1.1-P legitimately touches, the
file is excluded **by exact name** with a recorded reason; every other watched
path, and every `supabase/migrations/*.sql` check, remains covered.
