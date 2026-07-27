/**
 * INVENTORY-INTELLIGENCE-FRONTEND-A
 * Run: npm test -- --run inventory-intelligence-frontend
 *
 * Frontend wiring of migration 072's inventory-intelligence layer. Static
 * source-code assertions (the established convention in this repo — there is no
 * React test renderer wired up; see alert-cards-expiry-risk-badges-ui-a.test.ts).
 *
 * These tests lock the SECURITY-CRITICAL invariants of this phase:
 *   • acceptance is NEVER exposed (no accept RPC, no Accept button, no
 *     auto-execution, no stock movement) — 072 is recommendation-only;
 *   • every write is permission-gated on the right inventory.* key, and RLS +
 *     the SECURITY DEFINER RPCs remain the real boundary;
 *   • reads are org/scope isolated (RLS tables, narrowed to the active org);
 *   • loading / empty / error / denied / stale states all exist;
 *   • no migration file is touched by this frontend PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findUnexpectedMigrationGitStatusEntries } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migration-git-status';
import { T } from '@/shared/i18n/strings';

const FEAT = join(__dirname, '..');
const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(FEAT, rel), 'utf8');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const service = read('inventory-intelligence.service.ts');
const hooks = read('useInventoryIntelligence.ts');
const display = read('inventory-display.ts');
const panel = read('InventoryIntelligencePanel.tsx');
const summary = read('InventoryIntelligenceSummary.tsx');
const thresholdModal = read('InventoryThresholdModal.tsx');
const scopesHook = read('useInventoryScopes.ts');
const reasonDialog = read('InventoryReasonDialog.tsx');
const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');

/** Every source file in the feature (for cross-cutting "no accept" sweeps). */
function allFeatureSources(): string[] {
  return readdirSync(FEAT)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))
    .map(f => readFileSync(join(FEAT, f), 'utf8'));
}

// ── ACCEPTANCE IS DISABLED (the headline invariant) ──────────────────────────
describe('recommendation-only: acceptance is never exposed', () => {
  it('no source in the feature references the accept RPC or an accept wrapper', () => {
    for (const src of allFeatureSources()) {
      expect(src).not.toMatch(/phoenix_accept_inventory_transfer_suggestion/);
      expect(src).not.toMatch(/\bacceptInventory\w*/);
    }
  });

  it('the service defines reject but NO accept mutation, and documents why', () => {
    expect(service).toMatch(/export function rejectInventoryTransferSuggestion/);
    expect(service).not.toMatch(/export function accept/i);
    expect(service).toMatch(/acceptance is disabled/i);
  });

  it('no writer assigns status=accepted or sets accepted_at/accepted_by', () => {
    for (const src of allFeatureSources()) {
      // no assignment of the accepted status (a bare type-union mention is fine)
      expect(src).not.toMatch(/status\s*[:=]\s*['"]accepted['"]/i);
      // no assignment to the reserved accept fields (a doc mention with "/" is fine)
      expect(src).not.toMatch(/accepted_at\s*[:=]/);
      expect(src).not.toMatch(/accepted_by\s*[:=]/);
    }
  });

  it('the panel renders a reject control but no Accept control', () => {
    expect(panel).toMatch(/inv_action_reject/);
    expect(panel).not.toMatch(/inv_action_accept/);
    // guard against a stray "Accept" button label sneaking in
    expect(panel).not.toMatch(/>\s*Accept\s*</);
  });

  it('the panel states the recommendation-only / no-stock-movement contract to the user', () => {
    expect(panel).toMatch(/inv_recommendation_note/);
    expect(T.inv_recommendation_note.ar).toMatch(/توصية فقط/);
    expect(T.inv_recommendation_note.en).toMatch(/Recommendation only/i);
    expect(T.inv_recommendation_note.en).toMatch(/no stock movement/i);
  });
});

// ── PERMISSION GATING ────────────────────────────────────────────────────────
describe('permission gating uses the correct inventory.* keys', () => {
  it('hooks catalog declares exactly the seven migration-072 keys', () => {
    for (const key of [
      'inventory.view_signals', 'inventory.recompute', 'inventory.manage_alerts',
      'inventory.manage_thresholds', 'inventory.suggest_transfers',
      'inventory.act_on_suggestions', 'inventory.purge',
    ]) {
      expect(hooks).toContain(`'${key}'`);
    }
  });

  it('the panel gates view / manage_alerts / recompute / manage_thresholds / suggest / act_on', () => {
    expect(panel).toMatch(/myPermissions\.has\(PK\.viewSignals\)/);
    expect(panel).toMatch(/myPermissions\.has\(PK\.manageAlerts\)/);
    expect(panel).toMatch(/myPermissions\.has\(PK\.recompute\)/);
    expect(panel).toMatch(/myPermissions\.has\(PK\.manageThresholds\)/);
    expect(panel).toMatch(/myPermissions\.has\(PK\.suggestTransfers\)/);
    expect(panel).toMatch(/myPermissions\.has\(PK\.actOnSuggestions\)/);
  });

  it('reject is shown only behind act_on_suggestions (canAct)', () => {
    // the reject control block is guarded by canAct. Window widened (400->700,
    // migration 147) to span the sibling "create draft" button now rendered
    // in the same canAct-gated block — both remain narrow, per-suggestion,
    // never a generic/bulk action.
    expect(panel).toMatch(/canAct &&[\s\S]{0,700}inv_action_reject/);
  });

  it('threshold editing is shown only behind manage_thresholds (canThresholds)', () => {
    expect(panel).toMatch(/canThresholds &&[\s\S]{0,200}inv_threshold_add/);
  });

  it('the summary hides entirely when the caller lacks inventory.view_signals', () => {
    expect(summary).toMatch(/if \(!canView\) return null;/);
    expect(summary).toMatch(/myPermissions\.has\(PK\.viewSignals\)/);
  });
});

// ── ORG / SCOPE ISOLATION ────────────────────────────────────────────────────
describe('reads are org/scope isolated (RLS tables, narrowed to active org)', () => {
  it('reads go through the three RLS-protected tables, not writable endpoints', () => {
    expect(service).toMatch(/from\('inventory_alerts'\)/);
    expect(service).toMatch(/from\('inventory_signal_thresholds'\)/);
    expect(service).toMatch(/from\('inventory_transfer_suggestions'\)/);
  });

  it('alerts/thresholds narrow to the active organization_id', () => {
    expect(service).toMatch(/\.eq\('organization_id', orgId\)/);
  });

  it('suggestions narrow to either endpoint org (source OR target), never a third org', () => {
    expect(service).toMatch(/source_organization_id\.eq\.\$\{orgId\}.*target_organization_id\.eq\.\$\{orgId\}/);
  });

  it('hooks re-key their loaders on activeOrgId so the org switcher reloads', () => {
    expect(hooks).toMatch(/const \{ activeOrgId \} = useApp\(\)/);
    expect(hooks).toMatch(/\[activeOrgId/);
  });

  it('the service relies on RLS for authorization (RLS-protected table SELECTs)', () => {
    expect(service).toMatch(/RLS-protected table SELECTs/);
  });
});

// ── WRITES GO THROUGH THE RIGHT RPCs ─────────────────────────────────────────
describe('mutations call the exact migration-072 RPCs', () => {
  const expected = [
    'phoenix_recompute_inventory_alerts',
    'phoenix_acknowledge_inventory_alert',
    'phoenix_resolve_inventory_alert',
    'phoenix_dismiss_inventory_alert',
    'phoenix_upsert_inventory_threshold',
    'phoenix_suggest_inventory_transfers',
    'phoenix_reject_inventory_transfer_suggestion',
  ];
  it('every write RPC name is present and called via supabase.rpc', () => {
    expect(service).toMatch(/supabase\.rpc\(fn, args\)/);
    for (const fn of expected) expect(service).toContain(`'${fn}'`);
  });
  it('resolve/dismiss/reject require a non-empty reason before confirming', () => {
    expect(reasonDialog).toMatch(/trimmed === '' \|\| busy/);
    expect(reasonDialog).toMatch(/inv_reason_required/);
  });
});

// ── STATE COVERAGE: loading / empty / error / denied / stale ────────────────
describe('all required UI states are present', () => {
  it('panel renders loading, error, empty and denied states', () => {
    expect(panel).toMatch(/PhoenixLoadingState/);
    expect(panel).toMatch(/PhoenixErrorState/);
    expect(panel).toMatch(/inv_empty_alerts/);
    expect(panel).toMatch(/inv_denied/);
  });
  it('panel surfaces stale recommendations via isSuggestionStale + a stale note', () => {
    // 147: maxAgeMs now comes from the org's real inventory_suggestion_policy
    // (getInventorySuggestionPolicy), never a client-only literal — see
    // useInventoryIntelligence.ts's isSuggestionStale doc comment.
    expect(panel).toMatch(/isSuggestionStale\(s, stalenessMaxAgeMs\)/);
    expect(panel).toMatch(/inv_stale_note/);
    expect(hooks).toMatch(/export function isSuggestionStale/);
  });
  it('summary renders dismissible + acknowledgeable high-severity pop-ups', () => {
    expect(summary).toMatch(/setDismissed/);
    expect(summary).toMatch(/inv_action_acknowledge/);
    expect(summary).toMatch(/a\.severity === 'high'/);
  });
});

// ── i18n: AR + EN both present for every new key ─────────────────────────────
describe('bilingual strings (AR + EN) exist for the feature', () => {
  const keys = Object.keys(T).filter(k => k.startsWith('inv_'));
  it('has a meaningful set of inv_* keys', () => {
    expect(keys.length).toBeGreaterThan(30);
  });
  it('every inv_* key has non-empty ar and en', () => {
    for (const k of keys) {
      expect(T[k].ar.trim(), `${k}.ar`).not.toBe('');
      expect(T[k].en.trim(), `${k}.en`).not.toBe('');
    }
  });
});

// ── RTL/LTR + display helpers ────────────────────────────────────────────────
describe('display + directionality', () => {
  it('display helper maps cover every signal type, severity and scope kind', () => {
    for (const s of ['missing', 'low_stock', 'surplus', 'near_expiry', 'expired']) {
      expect(display).toContain(`${s}:`);
    }
    for (const sev of ['high', 'medium', 'low']) expect(display).toContain(`${sev}:`);
    expect(display).toMatch(/warehouse:/);
    expect(display).toMatch(/outlet:/);
  });
  it('material names use dir="auto" and date/code columns pin dir="ltr"', () => {
    expect(panel).toMatch(/dir="auto"/);
    expect(panel).toMatch(/dir="ltr"/);
  });
});

// ── EMBEDDING ────────────────────────────────────────────────────────────────
describe('embedded into Dashboard and Status Center', () => {
  it('Dashboard renders the summary', () => {
    expect(dashboard).toMatch(/InventoryIntelligenceSummary/);
  });
  it('Status Center renders the full panel', () => {
    expect(statusCenter).toMatch(/InventoryIntelligencePanel/);
  });
});

// ── SCOPE GUARD: no migration touched, no 073, threshold modal is org-default ─
describe('phase scope guards', () => {
  it('this frontend PR touches no migration file', () => {
    const status = execSync('git status --porcelain -- supabase/migrations', {
      cwd: join(__dirname, '../../../../'), encoding: 'utf8',
    });
    expect(findUnexpectedMigrationGitStatusEntries(status)).toEqual([]);
  });
  it('no migration 073 was created by this phase', () => {
    const status = execSync('git status --porcelain', {
      cwd: join(__dirname, '../../../../'), encoding: 'utf8',
    });
    expect(status).not.toMatch(/073[_\w-]*\.sql/);
  });
});

// ── ROUND 2: threshold scope selector + fixed near-expiry policy ─────────────
describe('round 2: near_expiry_days is a fixed 270-day policy, never editable', () => {
  it('the modal has NO near_expiry_days input and no setter', () => {
    expect(thresholdModal).not.toMatch(/setNearExpiryDays/);
    expect(thresholdModal).not.toMatch(/nearExpiryDays,\s*setNearExpiryDays/);
    // the old editable field label must no longer drive an <input>
    expect(thresholdModal).not.toMatch(/value=\{nearExpiryDays\}/);
  });
  it('it always sends the fixed 270-day window (never NULL, never user value)', () => {
    expect(thresholdModal).toMatch(/FIXED_NEAR_EXPIRY_DAYS = 270/);
    expect(thresholdModal).toMatch(/nearExpiryDays: FIXED_NEAR_EXPIRY_DAYS/);
  });
  it('it shows the fixed tier policy as read-only text (expired/critical/warning/watch)', () => {
    for (const k of ['inv_near_policy_window', 'inv_near_policy_expired', 'inv_near_policy_critical', 'inv_near_policy_warning', 'inv_near_policy_watch']) {
      expect(thresholdModal).toContain(k);
    }
  });
});

describe('round 2: real scope selector (not always org-default)', () => {
  it('save sends the real scope_id — null ONLY on the explicit org-default path', () => {
    expect(thresholdModal).toMatch(/scopeId:\s*editing \? editing\.scopeId : effectiveApplyTo === 'org_default' \? null : selectedScope!\.id/);
    // the always-null form is gone
    expect(thresholdModal).not.toMatch(/scopeId:\s*null,/);
  });
  it('scope options come from the RLS-filtered catalog, not free-text/UUID entry', () => {
    expect(scopesHook).toMatch(/getWarehouses/);
    expect(scopesHook).toMatch(/getPointsByOrg/);
    expect(thresholdModal).toMatch(/useInventoryScopes\(organizationId, canOrgDefault\)/);
    // scope is chosen from a <select> over the fetched options (label = name, value = id)
    expect(thresholdModal).toMatch(/options\.map\(o => \(\{ value: o\.id, label:/);
  });
  it('the named picker shows names (ar/en), never a raw UUID column', () => {
    expect(thresholdModal).toMatch(/o\.nameAr \|\| o\.name/);
    expect(thresholdModal).not.toMatch(/label:\s*o\.id/);
  });
  it('org-default is offered ONLY behind an exact server-side organization decision', () => {
    expect(thresholdModal).toMatch(/useExactThresholdPermission\(organizationId, null, null, open\)/);
    expect(thresholdModal).toMatch(/const canOrgDefault = orgPermission\.data === true/);
    expect(scopesHook).toMatch(/supabaseRbacTransport\.hasScopedPermission/);
    expect(scopesHook).toMatch(/permissionKey: 'inventory\.manage_thresholds'/);
    // apply-to collapses to scope-only when org-default is not allowed
    expect(thresholdModal).toMatch(/canOrgDefault \? applyTo : 'scope'/);
  });
  it('save is blocked until a valid scope is chosen (or an allowed org-default)', () => {
    expect(thresholdModal).toMatch(/const scopeChosen =/);
    expect(thresholdModal).toMatch(/canSave = nameOk && bandOk && scopeChosen/);
  });
  it('scope loading/empty/error states exist in the picker', () => {
    expect(thresholdModal).toMatch(/scopes\.loading/);
    expect(thresholdModal).toMatch(/scopes\.error/);
    expect(thresholdModal).toMatch(/inv_th_no_scopes/);
  });
});

// ── ROUND 3: stale-scope safety + manageable catalog + true editing ─────────
describe('round 3: exact manageable scopes and stale-id safety', () => {
  it('filters the readable catalog through active scope assignments with explicit broad-grant bypasses', () => {
    expect(scopesHook).toMatch(/useCurrentScopes\(authz\)/);
    expect(scopesHook).toMatch(/profile\?\.role === 'super_admin'/);
    expect(scopesHook).toMatch(/assignedWarehouses\.has\(w\.id\)/);
    expect(scopesHook).toMatch(/assignedPoints\.has\(o\.id\)/);
    expect(scopesHook).toMatch(/manageableWarehouses/);
    expect(scopesHook).toMatch(/manageableOutlets/);
  });

  it('lets an exact organization-level grant cover every scope without requiring assignment rows', () => {
    expect(scopesHook).toMatch(/canManageOrganization = false/);
    expect(scopesHook).toMatch(/const managesWholeOrganization = superAdmin \|\| canManageOrganization/);
    expect(scopesHook).toMatch(/const manageableWarehouses = managesWholeOrganization/);
    expect(scopesHook).toMatch(/const manageableOutlets = managesWholeOrganization/);
    expect(thresholdModal).toMatch(/useInventoryScopes\(organizationId, canOrgDefault\)/);
    expect(panel).toMatch(/useInventoryScopes\(activeOrgId, canManageOrgDefault\)/);
  });

  it('uses only manageable options in the write modal, while preserving readable name resolution', () => {
    expect(thresholdModal).toMatch(/scopes\.data\?\.manageableWarehouses/);
    expect(thresholdModal).toMatch(/scopes\.data\?\.manageableOutlets/);
    expect(scopesHook).toMatch(/resolve:/);
    expect(scopesHook).toMatch(/canManage:/);
  });

  it('requires membership in the current option set — non-empty UUID is insufficient', () => {
    expect(thresholdModal).toMatch(/const selectedScope = options\.find\(o => o\.id === scopeId\) \?\? null/);
    expect(thresholdModal).toMatch(/scopeChosen = effectiveApplyTo === 'org_default' \? canOrgDefault : selectedScope !== null/);
    expect(thresholdModal).not.toMatch(/scopeChosen = effectiveApplyTo === 'org_default' \? canOrgDefault : scopeId !== ''/);
  });

  it('preflights the selected exact scope against migration 062 before enabling save', () => {
    expect(thresholdModal).toMatch(/useExactThresholdPermission\(/);
    expect(thresholdModal).toMatch(/selectedPermission\.data === true/);
    expect(thresholdModal).toMatch(/scopeAuthorized/);
    expect(scopesHook).toMatch(/warehouseId: kind === 'warehouse' \? scopeId : null/);
    expect(scopesHook).toMatch(/distributionPointId: kind === 'outlet' \? scopeId : null/);
  });

  it('resets all identity state on open/new organization and never displays raw organization UUID', () => {
    expect(thresholdModal).toMatch(/useEffect\(\(\) => \{/);
    expect(thresholdModal).toMatch(/\[open, organizationId, editing\]/);
    expect(thresholdModal).toMatch(/setScopeId\(''\)/);
    expect(thresholdModal).toMatch(/organizationLabel \|\| t\('inv_org_loading', lang\)/);
    expect(thresholdModal).not.toMatch(/organizationLabel \|\| organizationId/);
  });

  it('rejects a retained catalog from the previous organization before rendering or saving', () => {
    expect(scopesHook).toMatch(/organizationId: orgId, warehouses:/);
    expect(scopesHook).toMatch(/visible\.data\.organizationId !== orgId/);
    expect(scopesHook).toMatch(/Boolean\(orgId\) && data === null/);
  });
});

describe('round 3: real threshold edit mode', () => {
  it('opens an existing row from the panel and passes it into the modal', () => {
    expect(panel).toMatch(/editingThreshold/);
    expect(panel).toMatch(/setEditingThreshold\(th\)/);
    expect(panel).toMatch(/editing=\{editingThreshold\}/);
    expect(panel).toMatch(/inv_action_edit/);
  });

  it('prefills existing values and locks the identity tuple', () => {
    expect(thresholdModal).toMatch(/editing\?\.scopeKind/);
    expect(thresholdModal).toMatch(/setScientificName\(editing\.scientificName\)/);
    expect(thresholdModal).toMatch(/const identityLocked = editing !== null/);
    expect(thresholdModal).toMatch(/disabled=\{identityLocked\}/);
    expect(thresholdModal).toMatch(/inv_th_identity_locked/);
  });

  it('saves the immutable existing identity but updates values with fixed 270 days', () => {
    expect(thresholdModal).toMatch(/scopeKind: editing\?\.scopeKind \?\? scopeKind/);
    expect(thresholdModal).toMatch(/scopeId: editing \? editing\.scopeId/);
    expect(thresholdModal).toMatch(/scientificName: editing\?\.scientificName/);
    expect(thresholdModal).toMatch(/nearExpiryDays: FIXED_NEAR_EXPIRY_DAYS/);
  });

  it('shows edit only for an org-default grant or an exactly manageable scope', () => {
    expect(panel).toMatch(/th\.scopeId === null\s*\? canManageOrgDefault\s*:\s*scopes\.data\?\.canManage/);
    expect(panel).toMatch(/orgThresholdPermission\.data === true/);
  });
});

describe('final review: audit reason isolation', () => {
  it('clears the previous reason whenever a new lifecycle action opens', () => {
    expect(reasonDialog).toMatch(/useEffect\(\(\) => \{/);
    expect(reasonDialog).toMatch(/if \(open\) setReason\(''\)/);
    expect(reasonDialog).toMatch(/\[open, title\]/);
  });
});

describe('round 2: threshold band rules + availability semantics', () => {
  it('enforces 0 <= reorder_point < target_max (blocks reorder >= target)', () => {
    expect(thresholdModal).toMatch(/reorderNum >= 0 && reorderNum < targetNum/);
    expect(thresholdModal).toMatch(/inv_th_band_invalid/);
  });
  it('explains available = on-hand - reserved and the missing/low/surplus rules', () => {
    expect(thresholdModal).toMatch(/inv_available_explain/);
    expect(thresholdModal).toMatch(/inv_signal_rules_missing/);
    expect(T.inv_available_explain.en).toMatch(/on-hand/i);
    expect(T.inv_available_explain.en).toMatch(/reserved/i);
    expect(T.inv_available_explain.ar).toMatch(/المحجوز/);
  });
  it('shows organization name first, then scope name, and labels scope-specific vs org-default', () => {
    expect(panel).toMatch(/orgLabel \? `\$\{orgLabel\}/);
    expect(panel).toMatch(/scopes\.data\?\.resolve\(th\.scopeKind, th\.scopeId\)/);
    expect(panel).toMatch(/inv_th_scope_specific/);
    expect(panel).toMatch(/inv_th_org_default/);
  });
});
