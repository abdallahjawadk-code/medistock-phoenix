/**
 * CN-UI-S1 HC1.1 — the wiring is presentation-only, and exactly what the owner
 * froze. A static pin on every seam the runtime suites cannot see: which state
 * the two new reporters read, which pure rule they report, how they release,
 * where the screen's guard reads them, and that nothing else moved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

const STORED = 'src/features/central-needs/simple/StoredWorkbookMapping.tsx';
const REGION = 'src/features/central-needs/regions/BeneficiaryRegionLayer.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';
const SCREEN = 'src/features/central-needs/CentralNeedsScreen.tsx';
const READINESS = 'src/features/central-needs/simple/simpleReadiness.ts';

describe('HC1.1-B — StoredWorkbookMapping reports a presentation-only activity', () => {
  const src = read(STORED);

  it('the rule is explicit and field by field — never a serialized comparison of whole state', () => {
    const rule = (src.match(/export function storedWorkbookHasLocalWork[\s\S]*?\n\}\n/) as RegExpMatchArray)[0];
    const flat = squash(rule);
    // Every owner-listed input, each its own term; none dropped, none added.
    expect(flat).toContain("const roleAssigned = profile !== null && (profile.nationalCodeColumn !== null || profile.materialColumn !== null);");
    expect(flat).toContain('const draftStarted = draft.editingId !== null || draft.anchor !== null || draft.need !== null || draft.beneficiaryOrganizationId !== null;');
    expect(flat).toContain('return roleAssigned || institutions.mappings.length > 0 || draftStarted || institutions.resetPending || approval.approved || approval.stale || regionDirty;');
    expect(rule).not.toMatch(/JSON\.stringify|INITIAL_|EMPTY_INSTITUTION_DRAFT|===\s*mapping\.|selection|context|outcome/);
  });

  it('it reads the SAME memory the surface already holds, and adds exactly ONE state — the region layer\'s own report', () => {
    expect(src.match(/=\s*useState/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/const \[regionActivity, setRegionActivity\] = useState<RegionLayerActivity>\(IDLE_ACTIVITY\);/);
    const flat = squash(src);
    expect(flat).toContain('const busy = regionActivity.busy;');
    expect(flat).toContain('const dirty = storedWorkbookHasLocalWork({ sheet: mapping.sheet.state, institutions: mapping.institutions.state, approval, regionDirty: regionActivity.dirty, });');
    expect(flat).toContain('onActivityChange={setRegionActivity}');
  });

  it('it reports on change and RELEASES (all false) on unmount, through a ref — no stale callback, no leaked report', () => {
    const flat = squash(src);
    expect(flat).toContain('const activityListener = useRef(onActivityChange);');
    // LAYOUT effects: the report lands in the same commit cycle as the state it describes (a write just started is never reported late).
    expect(flat).toContain('useLayoutEffect(() => { activityListener.current = onActivityChange; });');
    expect(flat).toContain('useLayoutEffect(() => { activityListener.current?.({ busy, dirty, failed }); }, [busy, dirty, failed]);');
    expect(flat).toContain('useLayoutEffect(() => () => activityListener.current?.(IDLE_ACTIVITY), []);');
    expect(flat).toContain('const IDLE_ACTIVITY: StoredWorkbookActivity = Object.freeze({ busy: false, dirty: false, failed: false });');
  });

  it('the mapping reducers and hooks are only TYPE-imported: no second mapping reducer, no change to them', () => {
    expect(src).toMatch(/import type \{ InstitutionMappingState \} from '\.\.\/mapping\/institutionMapping';/);
    expect(src).toMatch(/import type \{ SheetMappingState \} from '\.\.\/mapping\/sheetMappingProfile';/);
    expect(src).not.toMatch(/Reducer|useReducer|dispatch\(/);
    // It still names no backend: composition and memory only.
    expect(src).not.toMatch(/supabase|\.rpc\(|fetch\(|central-needs\.service|localStorage|sessionStorage/);
  });

  it('the workspace passes the activity callback to it and holds no state of its own for it', () => {
    const ws = read(WORKSPACE);
    expect(squash(ws)).toMatch(/<StoredWorkbookMapping key=\{revision\.id\} lang=\{lang\} batches=\{batches\} careInstitutions=\{careInstitutions\} planRevisionId=\{revision\.id\} onActivityChange=\{onStoredWorkbookActivityChange\} \/>/);
    expect(ws.match(/=\s*useState/g) ?? []).toHaveLength(0);
    expect(ws).toMatch(/onStoredWorkbookActivityChange\?: \(activity: \{ busy: boolean; dirty: boolean; failed: boolean \}\) => void;/);
  });
});

describe('HC1.1-C — BeneficiaryRegionLayer reports its own existing state, and nothing else about it moved', () => {
  const src = read(REGION);

  it('the dirty rule is the owner\'s: converting, pending, or a typed reason', () => {
    const rule = (src.match(/export function regionLayerHasLocalWork[\s\S]*?\n\}\n/) as RegExpMatchArray)[0];
    expect(squash(rule)).toContain('return state.convertingCount > 0 || state.hasPending || state.reason.trim() !== \'\';');
    expect(squash(src)).toContain('const dirty = regionLayerHasLocalWork({ convertingCount: converting.size, hasPending: pending !== null, reason });');
  });

  it('busy IS the layer\'s own in-flight flag, and failed is its own error message — no second region state', () => {
    const flat = squash(src);
    expect(flat).toContain("const failed = message?.tone === 'error';");
    expect(flat).toContain('useLayoutEffect(() => { activityListener.current?.({ busy, dirty, failed }); }, [busy, dirty, failed]);');
    // The eight states the layer already had; HC1.1 adds none.
    expect(src.match(/=\s*useState/g) ?? []).toHaveLength(8);
    for (const state of ['layer', 'converting', 'pending', 'reason', 'decision', 'beneficiary', 'busy', 'message']) {
      expect(src, state).toMatch(new RegExp(`const \\[${state}, set${state[0].toUpperCase()}${state.slice(1)}\\] = useState`));
    }
  });

  it('it releases on unmount, and a typed reason goes with the pending confirmation that owns it', () => {
    const flat = squash(src);
    expect(flat).toContain('useLayoutEffect(() => () => activityListener.current?.({ busy: false, dirty: false, failed: false }), []);');
    expect(flat).toContain("useEffect(() => { if (pending === null) setReason(''); }, [pending]);");
  });

  it('persistence is untouched: ONE write call, the same fenced payload, the same stale rule, the same permission gate', () => {
    expect(src.match(/await setBeneficiaryRegions\(/g) ?? []).toHaveLength(1);
    const call = (src.match(/await setBeneficiaryRegions\(\{[\s\S]*?\}\);/) as RegExpMatchArray)[0];
    expect([...call.matchAll(/^\s{8}(\w+)[,:]/gm)].map((m) => m[1])).toEqual([
      'planRevisionId', 'importSessionId', 'sheetIndex', 'renderedParserIdentity', 'expectedSheetName', 'expectedVersionIds', 'changes', 'reason',
    ]);
    expect(src).toContain("refusal.businessCode === 'beneficiary_region_stale'");
    expect(squash(src)).toContain('const writable = canWrite && g3 && ready !== null && !busy;');
    // No new service import, no direct backend, no storage.
    expect([...src.matchAll(/^  (listBeneficiaryRegions|listScopeColumnMappings|setBeneficiaryRegions|CentralNeedsError),$/gm)].map((m) => m[1]).sort())
      .toEqual(['CentralNeedsError', 'listBeneficiaryRegions', 'listScopeColumnMappings', 'setBeneficiaryRegions']);
    expect(src).not.toMatch(/supabase|\.rpc\(|localStorage|sessionStorage/);
  });
});

describe('HC1.1 — the screen reads the new slot for the expert escape ONLY', () => {
  const screen = read(SCREEN);

  it('one more activity slot, released by its reporter, reset with the others when the revision changes', () => {
    expect(screen).toMatch(/const \[storedWorkbookActivity, setStoredWorkbookActivity\] = useState<ChildActivity>\(\{ busy: false, dirty: false, failed: false \}\);/);
    expect(screen).toMatch(/setNeedLineActivity\(\{ busy: false, dirty: false, failed: false \}\);\s*setStoredWorkbookActivity\(\{ busy: false, dirty: false, failed: false \}\);\s*setBackgroundResult\(null\);/);
    expect(screen).toMatch(/onStoredWorkbookActivityChange=\{setStoredWorkbookActivity\}/);
    // The reporters release themselves: the screen adds NO wrapper for this slot.
    expect(screen.match(/<ReleaseActivityOnUnmount /g) ?? []).toHaveLength(3);
    expect(screen).not.toMatch(/releaseStoredWorkbookActivity/);
  });

  it('busy and dirty are the owner\'s two formulas — and the slot is read by nothing else', () => {
    expect(screen).toContain('const expertSwitchBusy = busy !== null || reviewActivity.busy || needLineActivity.busy || storedWorkbookActivity.busy;');
    expect(screen).toContain('const expertSwitchDirty = reviewActivity.dirty || needLineActivity.dirty || storedWorkbookActivity.dirty;');
    expect(screen.match(/storedWorkbookActivity\./g) ?? []).toHaveLength(2); // once in each formula, nowhere else
    // The Work Session and revision guards keep reading exactly what they read before HC1.1.
    expect(screen).toContain('const sessionDraftDirty = reviewActivity.dirty || needLineActivity.dirty;');
    expect(squash(screen)).toContain('const sessionSwitchBlocked = sessionLoading || reviewActivity.busy || needLineActivity.busy;');
    expect(screen).toContain('const revisionDraftDirty = sourceDraftDirty || reviewActivity.dirty || beneficiaryActivity.dirty || needLineActivity.dirty;');
    expect(squash(screen)).toContain('const revisionContextBusy = busy !== null || reviewActivity.busy || beneficiaryActivity.busy || needLineActivity.busy;');
  });

  it('the mode still has exactly ONE way into Advanced from Simple: the escape handler, busy first, then dirty', () => {
    expect(screen.match(/setMode\('advanced'\)/g) ?? []).toHaveLength(1);
    const handler = (screen.match(/const onExpertEscape = useCallback\(([\s\S]*?)\n  \}, \[([^\]]*)\]/) as RegExpMatchArray);
    const body = squash(handler[1]);
    expect(body.indexOf('if (expertSwitchBusy)')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('if (expertSwitchBusy)')).toBeLessThan(body.indexOf('if (expertSwitchDirty'));
    expect(body.indexOf('if (expertSwitchDirty')).toBeLessThan(body.indexOf("setMode('advanced')"));
    expect(body).toContain("if (expertSwitchDirty && !window.confirm(t('cn2b_expert_switch_confirm', lang))) return;");
  });
});

describe('HC1.1 — the escape\'s reasons, copy keys and routes stay in step', () => {
  const ws = read(WORKSPACE);

  it('every reason has its own sentence, in a map the type system forces to be total', () => {
    expect(ws).toMatch(/const EXPERT_BODY_KEY: Readonly<Record<SimpleExpertReason, string>> = \{/);
    const map = (ws.match(/const EXPERT_BODY_KEY[\s\S]*?\n\};/) as RegExpMatchArray)[0];
    expect([...map.matchAll(/^\s{2}([a-z_]+): 'cn2b_simple_expert_body_[a-z_]+',$/gm)].map((m) => m[1]).sort())
      .toEqual(['numeric_override', 'open_import', 'override_head_unproven', 'source_evidence_invalid', 'unknown_blocker', 'unknown_lineage_reason']);
    const reasons = (read(READINESS).match(/export type SimpleExpertReason =[\s\S]*?;/) as RegExpMatchArray)[0];
    expect([...reasons.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort())
      .toEqual(['numeric_override', 'open_import', 'override_head_unproven', 'source_evidence_invalid', 'unknown_blocker', 'unknown_lineage_reason']);
  });

  it('the four DIAGNOSTIC escapes — and only they — carry the diagnostic title (HC1.2: invalid evidence and an unproven head join the two fail-closed ones), in a map the type system forces to be total', () => {
    expect(ws).toMatch(/const EXPERT_TITLE_KEY: Readonly<Record<SimpleExpertReason, string>> = \{/);
    const map = (ws.match(/const EXPERT_TITLE_KEY[\s\S]*?\n\};/) as RegExpMatchArray)[0];
    const rows = Object.fromEntries([...map.matchAll(/^\s{2}([a-z_]+): '(cn2b_simple_expert_title[a-z_]*)',$/gm)].map((m) => [m[1], m[2]]));
    expect(rows).toEqual({
      open_import: 'cn2b_simple_expert_title',
      numeric_override: 'cn2b_simple_expert_title',
      source_evidence_invalid: 'cn2b_simple_expert_title_unknown',
      override_head_unproven: 'cn2b_simple_expert_title_unknown',
      unknown_blocker: 'cn2b_simple_expert_title_unknown',
      unknown_lineage_reason: 'cn2b_simple_expert_title_unknown',
    });
    expect(ws).toContain('{t(EXPERT_TITLE_KEY[escape.reason], lang)}');
  });

  it('still no generic entry: the block is rendered in exactly the two places it can be needed, each behind the same gate', () => {
    expect(ws.match(/<ExpertEscapeBlock /g) ?? []).toHaveLength(2);
    expect(ws.match(/expertEscapeShown && expertEscape !== null && onExpertEscape/g) ?? []).toHaveLength(2);
    expect(ws).not.toMatch(/\bsetMode\b|<footer|Advanced options/);
  });
});

describe('HC1.1 — no new business surface', () => {
  const FILES = [STORED, REGION];

  it('no direct Supabase call, no RPC name and no SQL is named by the files that gained the new logic', () => {
    for (const file of [STORED, REGION, READINESS, WORKSPACE]) {
      expect(read(file), file).not.toMatch(/\.rpc\(|from\('supabase|createClient|supabase\./);
    }
    for (const file of FILES) expect(read(file), file).not.toMatch(/phoenix_central_needs_[a-z_]+_v\d|CREATE (OR REPLACE )?FUNCTION|GRANT |ALTER TABLE/);
  });
});
