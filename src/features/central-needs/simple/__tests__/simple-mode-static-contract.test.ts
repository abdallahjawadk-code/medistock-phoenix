/**
 * Annual Needs — Simple Mode static contract guards.
 *
 * These assertions do not render anything: they inspect the SOURCE of the
 * Simple Mode surface for the things this task's mission must never do,
 * mirroring `cn2b-trusted-server-and-ui.test.ts`'s own convention (comments
 * stripped first, so prose can never satisfy — or hide a violation from — a
 * check).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SIMPLE_DIR = 'src/features/central-needs/simple';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('__tests__')) out.push(rel);
  }
  return out;
}

const simpleModeFiles = walk(SIMPLE_DIR).filter((p) => !p.includes('/__tests__/'));

describe('Simple Mode — hard boundary: no automatic NeedLine mutation (owner task section 16, checklist item 19)', () => {
  it('no file under simple/ calls setNeedLine or deleteNeedLine', () => {
    for (const file of simpleModeFiles) {
      expect(code(file), file).not.toMatch(/\bsetNeedLine\s*\(/);
      expect(code(file), file).not.toMatch(/\bdeleteNeedLine\s*\(/);
    }
  });

  it('the workspace never imports setNeedLine/deleteNeedLine from the service module', () => {
    const workspace = code(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    expect(workspace).not.toMatch(/setNeedLine/);
    expect(workspace).not.toMatch(/deleteNeedLine/);
  });

  it('the "confirm quantities" action is an unconditional, literal disabled control — not a state-gated one', () => {
    const workspace = read(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    const match = workspace.match(/cn2b-simple-confirm-quantities"[\s\S]{0,400}/);
    expect(match, 'confirm-quantities control not found').not.toBeNull();
    // The button carries a bare `disabled` attribute (no `disabled={...expr}`),
    // i.e. it cannot be re-enabled by any state this build computes.
    const controlSource = workspace.slice(
      workspace.indexOf('cn2b-simple-confirm-quantities') - 200,
      workspace.indexOf('cn2b-simple-confirm-quantities') + 200,
    );
    expect(controlSource).toMatch(/\bdisabled\b(?!=)/);
  });
});

describe('Simple Mode — same persisted state, no second source of truth (checklist item 1)', () => {
  it('CentralNeedsSimpleWorkspace issues no Supabase reads or writes of its own — everything arrives as props', () => {
    const workspace = code(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    expect(workspace).not.toMatch(/from ['"]@\/shared\/supabase\/client['"]/);
    expect(workspace).not.toMatch(/\.rpc\(/);
    expect(workspace).not.toMatch(/\bsupabase\./);
  });

  it('the only service-layer writes Simple Mode performs are the two existing CN-1B/CN-2B RPCs it is scoped to', () => {
    const allowedWrites = ['setBeneficiaryColumns', 'setRecordDisposition'];
    const cardFiles = [`${SIMPLE_DIR}/SimpleInstitutionCard.tsx`, `${SIMPLE_DIR}/SimpleMaterialCard.tsx`];
    for (const file of cardFiles) {
      const src = code(file);
      // Only AWAITED calls: every service-layer RPC call in this codebase is
      // awaited, while local `useState` setters (setBusy, setError, …) never
      // are — this distinguishes a server write from local presentation state.
      const calls = [...src.matchAll(/\bawait\s+(set[A-Z]\w*|delete[A-Z]\w*|record[A-Z]\w*|submit[A-Z]\w*|approve[A-Z]\w*|reject[A-Z]\w*|open[A-Z]\w*)\s*\(/g)]
        .map((m) => m[1]);
      expect(calls.length, `${file}: expected at least one awaited write call`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(allowedWrites, `${file} calls ${call}`).toContain(call);
      }
    }
  });

  it('institution suggestions reuse the SAME exact-match function Advanced Mode uses, not a second copy', () => {
    const card = code(`${SIMPLE_DIR}/SimpleInstitutionCard.tsx`);
    expect(card).toMatch(/import\s*\{[^}]*exactMatchSuggestion[^}]*\}\s*from\s*['"]\.\.\/CentralNeedsBeneficiaryColumnPanel['"]/);
    // And it must not redeclare a fuzzy/second matcher of its own.
    expect(card).not.toMatch(/function\s+exactMatchSuggestion/);
  });

  it('readiness categorization reuses the SAME known-blocker vocabulary Advanced Mode uses, not a second copy', () => {
    const readinessSrc = code(`${SIMPLE_DIR}/simpleReadiness.ts`);
    expect(readinessSrc).toMatch(/import\s*\{[^}]*BLOCKERS_BY_STAGE[^}]*KNOWN_BLOCKERS|import\s*\{[^}]*KNOWN_BLOCKERS[^}]*BLOCKERS_BY_STAGE/);
    expect(readinessSrc).toMatch(/from\s*['"]\.\.\/CentralNeedsWorkspaceState['"]/);
  });
});

describe('Simple Mode — source unit is never invented or silently substituted (checklist items 9-11)', () => {
  it('the material card never assigns central_items.unit (the canonical unit) into sourceUnitText or an approved-unit field', () => {
    const src = code(`${SIMPLE_DIR}/SimpleMaterialCard.tsx`);
    // The canonical unit is only ever read for DISPLAY next to a suggestion —
    // never written into a record's source-unit representation.
    expect(src).not.toMatch(/sourceUnitText\s*[:=]\s*(suggestion|item|candidate)\.unit/);
  });

  it('a source unit is shown only when a field header is an exact unit-word match — never derived from the material description', () => {
    const src = code(`${SIMPLE_DIR}/SimpleMaterialCard.tsx`);
    expect(src).toMatch(/UNIT_HEADER_RE/);
    // The function reads f.fieldName (the header), never scanning sourceValues
    // of a non-unit-headed field for a unit-looking substring.
    expect(src).toMatch(/UNIT_HEADER_RE\.test\(f\.fieldName/);
  });

  it('setRecordDisposition is never called with a unit-conversion or source-unit parameter — Simple Mode never runs a conversion engine', () => {
    const src = code(`${SIMPLE_DIR}/SimpleMaterialCard.tsx`);
    const call = src.match(/setRecordDisposition\(\{[\s\S]*?\}\)/g) ?? [];
    for (const c of call) {
      expect(c).not.toMatch(/unitConversion/i);
      expect(c).not.toMatch(/sourceUnit/i);
    }
  });
});

describe('Simple Mode — permissions are read the same way Advanced Mode reads them (checklist item 13)', () => {
  it('CentralNeedsScreen passes the SAME myPermissions-derived booleans into Simple Mode, not a role-name check', () => {
    const screen = code('src/features/central-needs/CentralNeedsScreen.tsx');
    expect(screen).toMatch(/canImport=\{canImport\}/);
    expect(screen).toMatch(/canEdit=\{canEdit\}/);
    expect(screen).not.toMatch(/profile\.role\s*===/);
  });

  it('Simple Mode never reads profile.role or myPermissions itself — it only reads the booleans passed as props', () => {
    for (const file of simpleModeFiles) {
      const src = code(file);
      expect(src, file).not.toMatch(/myPermissions/);
      expect(src, file).not.toMatch(/profile\.role/);
    }
  });

  it('CN-UI-S1 — opening an annual draft or a correction is gated on canEdit (the server\'s edit guard); only the upload is gated on canImport', () => {
    const src = code(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    const start = src.slice(src.indexOf('{!revision ? ('), src.indexOf('data-testid="cn2b-simple-start"'));
    expect(start).toMatch(/\{canEdit \? \(/);
    expect(start).not.toMatch(/canImport/);
    const closed = src.slice(src.indexOf("step === 'pending' && revisionClosed"), src.indexOf('data-testid="cn2b-simple-create-correction"'));
    expect(closed).toMatch(/\{canEdit \? \(/);
    expect(closed).not.toMatch(/canImport/);
    expect(src).toMatch(/\{canImport && isDraft \? \(\s*<>\s*<SimpleUploadZone/);
  });
});

/**
 * Director finding 2 was precisely that `canEdit` could be DECLARED in Props
 * and passed by the screen while the component never destructured or used it.
 * A prop's existence therefore proves nothing; these guards check it is
 * actually consumed, actually forwarded, and actually gates both write paths.
 */
describe('Simple Mode — permission parity is CONSUMED, not merely declared (Director finding 2)', () => {
  const workspacePath = `${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`;

  it('every prop the workspace declares is also destructured — no prop may be declared and ignored', () => {
    const src = code(workspacePath);
    const propsBlock = src.match(/interface Props \{([\s\S]*?)\n\}/);
    expect(propsBlock, 'Props interface not found').not.toBeNull();
    const declared = [...(propsBlock as RegExpMatchArray)[1].matchAll(/^\s*([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(5);

    const destructureBlock = src.match(/export function CentralNeedsSimpleWorkspace\(\{([\s\S]*?)\}: Props\)/);
    expect(destructureBlock, 'destructuring block not found').not.toBeNull();
    const consumed = new Set(
      [...(destructureBlock as RegExpMatchArray)[1].matchAll(/([A-Za-z_]\w*)/g)].map((m) => m[1]),
    );
    const ignored = declared.filter((name) => !consumed.has(name));
    expect(ignored, `declared but never destructured: ${ignored.join(', ')}`).toEqual([]);
  });

  it('the workspace gates writes on canEdit AND isDraft, the same pair Advanced Mode uses', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/canEdit\s*&&\s*isDraft/);
  });

  it('the workspace forwards that gate to BOTH review cards — neither renders ungated', () => {
    const src = code(workspacePath);
    const institution = src.match(/<SimpleInstitutionCard[\s\S]*?\/>/);
    const material = src.match(/<SimpleMaterialCard[\s\S]*?\/>/);
    expect(institution, 'SimpleInstitutionCard usage not found').not.toBeNull();
    expect(material, 'SimpleMaterialCard usage not found').not.toBeNull();
    expect((institution as RegExpMatchArray)[0]).toMatch(/editable=\{/);
    expect((material as RegExpMatchArray)[0]).toMatch(/editable=\{/);
  });

  it('each card requires `editable` (not optional) and refuses its write path without it', () => {
    for (const file of [`${SIMPLE_DIR}/SimpleInstitutionCard.tsx`, `${SIMPLE_DIR}/SimpleMaterialCard.tsx`]) {
      const src = code(file);
      // Required, not `editable?:` — a caller cannot silently omit the gate.
      expect(src, file).toMatch(/\n\s*editable:\s*boolean;/);
      expect(src, file).not.toMatch(/editable\?:/);
      expect(src, file).toMatch(/editable/);
      // Every awaited canonical write sits behind an explicit early return.
      expect(src, file).toMatch(/if\s*\(!editable\)\s*return;/);
    }
  });

  it('no mutation control in either card renders outside an `editable` guard', () => {
    for (const file of [`${SIMPLE_DIR}/SimpleInstitutionCard.tsx`, `${SIMPLE_DIR}/SimpleMaterialCard.tsx`]) {
      const src = code(file);
      // Each JSX block that contains an onClick handler must be introduced by
      // a condition that includes `editable` (the read-only branch has none).
      const guardedBlocks = [...src.matchAll(/\{editable && [^\n]*\(/g)].length;
      expect(guardedBlocks, `${file}: expected editable-guarded JSX blocks`).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * Director finding 3: `listSourceRecords`/`listDispositions` are keyed by
 * import session, so their counts are not annual-need totals and must never be
 * displayed as if they were. CN-UI-S1 removed the summary card those labels
 * lived on (superseded); the compact session context that replaced it keeps
 * each figure's own scope label, and the M213-only quantity figure is gone.
 */
describe('Simple Mode — context scope is stated, never implied (Director finding 3)', () => {
  it('the compact context labels each figure with its own scope, and shows no quantity figure', () => {
    const src = code(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    expect(src).toMatch(/cn2b_simple_scope_this_session/);
    expect(src).toMatch(/cn2b_simple_scope_whole_revision/);
    expect(src).not.toMatch(/cn2b_simple_quantities|quantityCandidateCount|cn2b-simple-count-quantities/);
    expect(src).not.toMatch(/cn2b_simple_scope_session_title|cn2b_simple_scope_session_note/);
  });

  it('the two scope labels make different claims, in both languages', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const session = strings.match(/cn2b_simple_scope_this_session:\s*\{[^}]*\}/);
    const revision = strings.match(/cn2b_simple_scope_whole_revision:\s*\{[^}]*\}/);
    expect(session?.[0]).toMatch(/this file only/);
    expect(session?.[0]).toMatch(/في هذا الملف فقط/);
    expect(revision?.[0]).toMatch(/across the whole annual need/);
    expect(revision?.[0]).toMatch(/في كامل الاحتياج السنوي/);
  });

  it('Simple Mode still adds no revision-wide read of its own — no new RPC was invented for this', () => {
    for (const file of simpleModeFiles) {
      const src = code(file);
      expect(src, file).not.toMatch(/listSourceRecords\s*\(/);
      expect(src, file).not.toMatch(/listDispositions\s*\(/);
      expect(src, file).not.toMatch(/listBeneficiaryColumns\s*\(/);
    }
  });
});

/**
 * CN-UI-S1 supersedes Director defect 4 / finding 5 (the summary gate and its
 * dataset-keyed acknowledgement): the owner removed the summary step. What
 * those guards protected still holds, and more strictly — the step is derived
 * from current props ALONE, so there is no navigation state left to go stale.
 */
describe('Simple Mode — the step is derived from props alone; no summary gate, no navigation state (CN-UI-S1)', () => {
  const workspacePath = `${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`;
  const derivedBody = () => {
    const derived = code(workspacePath).match(/const derivedStep[\s\S]*?\n\s*\}, \[/);
    expect(derived, 'derivedStep not found').not.toBeNull();
    return (derived as RegExpMatchArray)[0];
  };

  it('derivedStep never returns a summary, and its outcomes follow the workflow order', () => {
    const body = derivedBody();
    expect(body).not.toMatch(/'summary'|summaryAck/);
    const returns = [...body.matchAll(/return '([a-z-]+)'/g)].map((m) => m[1]);
    expect(returns).toEqual([
      'upload', 'pending', 'analyzing', 'analyzing', 'upload', 'analyzing',
      'review-institution', 'review-material', 'pending', 'need-lines',
    ]);
  });

  it('the guard order: closed outranks everything, unready or stale-session data outranks every card, the server verdict alone reaches the outcome', () => {
    const body = derivedBody();
    const at = (s: string) => {
      const i = body.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at("if (!revision) return 'upload'")).toBeLessThan(at("if (revisionClosed) return 'pending'"));
    expect(at("if (revisionClosed) return 'pending'")).toBeLessThan(at("preview.phase === 'parsing' || (busy && !LIFECYCLE_ACTIVITIES.has(activity))"));
    expect(at('if (!revisionDataReady)')).toBeLessThan(at("if (activeSessionId === null) return 'upload'"));
    expect(at("if (activeSessionId === null) return 'upload'")).toBeLessThan(at("if (sessionLoading) return 'analyzing'"));
    expect(at("if (sessionLoading) return 'analyzing'")).toBeLessThan(at("return 'review-institution'"));
    expect(at("return 'review-material'")).toBeLessThan(at("if (readinessSummary?.ready === true) return 'pending'"));
    expect(at("if (readinessSummary?.ready === true) return 'pending'")).toBeLessThan(at("return 'need-lines'"));
  });

  it('a lifecycle action never sends the page to "analyzing" (that would unmount the need-line workspace mid-click)', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/LIFECYCLE_ACTIVITIES[^=]*= new Set<SimpleActivity>\(\['submitting', 'approving', 'rejecting'\]\)/);
  });

  it('the workspace holds NO component state at all — no acknowledgement, no step override', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/const step = derivedStep;/);
    // (Matches declarations only — not an import of the hook.)
    expect(src.match(/=\s*useState/g) ?? []).toHaveLength(0);
    expect(src).not.toMatch(/manualStep|summaryAckKey|datasetKey|goToSummary|goToReview/);
    expect(src).not.toMatch(/cn2b-simple-summary|cn2b-simple-review-start|cn2b_simple_back_to_summary/);
  });

  it('the workspace persists nothing and reaches no server', () => {
    const src = code(workspacePath);
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/sessionStorage/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bsupabase\./);
  });
});

/**
 * Owner decision ("Simple UX Visual Activation & Convergence"): Simple Mode is
 * the DEFAULT product experience; the Advanced six-stage workspace survives
 * intact as the secondary, expert entry. The earlier "defaults to advanced"
 * assertion is obsolete by that decision and is replaced, not deleted.
 */
describe('Simple Mode is the default; Advanced Mode survives as the secondary entry', () => {
  const screenPath = 'src/features/central-needs/CentralNeedsScreen.tsx';

  it('CentralNeedsScreen seeds its mode from initialMode, whose default is simple — never advanced', () => {
    const screenSrc = code(screenPath);
    expect(screenSrc).toMatch(/useState<'simple' \| 'advanced'>\(initialMode\)/);
    expect(screenSrc).toMatch(/initialMode = 'simple'/);
    expect(screenSrc).not.toMatch(/useState<'simple' \| 'advanced'>\('advanced'\)/);
  });

  it('the six-stage Advanced workspace is still rendered by the screen, inside the advanced branch only', () => {
    const screenSrc = code(screenPath);
    expect(screenSrc).toMatch(/<CentralNeedsWorkflowNav/);
    expect(screenSrc).toMatch(/CENTRAL_NEEDS_STAGES\.map/);
    // The Simple branch renders ONLY the Simple workspace; the Advanced command
    // header, rail and stage sections are all on the other side of the ternary.
    const simpleBranch = screenSrc.slice(screenSrc.indexOf("mode === 'simple' ? ("), screenSrc.indexOf(') : (', screenSrc.indexOf("mode === 'simple' ? (")));
    expect(simpleBranch).toMatch(/<CentralNeedsSimpleWorkspace/);
    expect(simpleBranch).not.toMatch(/cn2b-header|CentralNeedsWorkflowNav|cn2b-stage|cn2b-guidance/);
  });

  it('switching mode is presentation only — the screen never reloads or resets state on a mode change', () => {
    const screenSrc = code(screenPath);
    // CN-UI-S1 (supersedes the Simple → Advanced switch site): Simple is the
    // complete workflow, so there is no generic switch TO Advanced…
    expect(screenSrc).not.toMatch(/onSwitchToAdvanced/);
    // …CN-UI-S1 HC1: exactly TWO switch sites remain, each setting a literal
    // and nothing else — Advanced's way back, and the ONE contextual expert
    // escape, whose handler is the only place 'advanced' is ever set.
    expect(screenSrc.match(/setMode\(/g) ?? []).toHaveLength(2);
    expect(screenSrc).toMatch(/onClick=\{\(\) => setMode\('simple'\)\}/);
    expect(screenSrc.match(/setMode\('advanced'\)/g) ?? []).toHaveLength(1);
    const handler = screenSrc.match(/const onExpertEscape = useCallback\(([\s\S]*?)\n  \}, \[/);
    expect(handler, 'onExpertEscape handler').not.toBeNull();
    expect((handler as RegExpMatchArray)[1]).toContain("setMode('advanced')");
    // No effect keyed on `mode` exists, so a mode change can trigger no read.
    expect(screenSrc).not.toMatch(/\[[^\]]*\bmode\b[^\]]*\]\s*\)/);
  });

  it('the Simple workspace receives human-readable error and notice text, never a raw code or dictionary key', () => {
    const screenSrc = code(screenPath);
    expect(screenSrc).toMatch(/error=\{error \? centralNeedsErrorText\(error, lang\) : null\}/);
    expect(screenSrc).toMatch(/notice=\{notice \? t\(notice, lang\) : null\}/);
  });
});

describe('Simple Mode shell — six steps, one task, Advanced demoted (visual convergence)', () => {
  const workspacePath = `${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`;

  it('the workspace owns the page heading and renders the six-step progress indicator on every step', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/<h1 className="cn2b-simple-title">/);
    expect(src).toMatch(/<SimpleStepper lang=\{lang\} step=\{step\} \/>/);
    const stepper = code(`${SIMPLE_DIR}/SimpleStepper.tsx`);
    // CN-UI-S1: the summary step is gone; the need lines are a step of their own.
    const ids = [...stepper.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(['upload', 'analyzing', 'review-institution', 'review-material', 'need-lines', 'pending']);
    // The indicator is informative only: no click handler can jump steps.
    expect(stepper).not.toMatch(/onClick/);
  });

  it('Simple offers NO generic way into Advanced — no footer link, no handoff, no "Advanced options" copy (CN-UI-S1, supersedes the quiet footer entry)', () => {
    const src = code(workspacePath);
    expect(src).not.toMatch(/<footer/);
    expect(src).not.toMatch(/onSwitchToAdvanced|cn2b-simple-advanced-link|cn2b-simple-continue-advanced|cn2b-simple-handoff/);
    expect(src).not.toMatch(/cn2b_simple_advanced_options|cn2b_simple_advanced_hint|cn2b_simple_final_handoff|cn2b_simple_final_continue_advanced|cn2b_simple_switch_to_advanced/);
    // …and no Simple sentence the routine flow can show points there either.
    const strings = read('src/shared/i18n/strings.ts');
    for (const key of ['cn2b_simple_final_server_ready', 'cn2b_simple_blocker_unknown', 'cn2b_simple_blocker_lineage_reason_unrecognized']) {
      const entry = strings.match(new RegExp(`${key}:\\s*\\{[^}]*\\}`));
      expect(entry, key).not.toBeNull();
      expect((entry as RegExpMatchArray)[0], key).not.toMatch(/advanced|المتقدمة|متقدمة/i);
    }
  });

  it('the analyzing step shows only phases the props justify and never a fabricated percentage', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/preview\.phase === 'parsing'[\s\S]*?phases: \['active', 'waiting', 'waiting'\]/);
    expect(src).toMatch(/activity === 'verifying'[\s\S]*?phases: \['done', 'active', 'waiting'\]/);
    expect(src).not.toMatch(/%/);
    expect(src).not.toMatch(/aria-valuenow/);
  });

  it('steps 5–6 never claim completion: readiness text is the server verdict, and submit is the screen\'s own gated block', () => {
    const src = code(workspacePath);
    const start = src.indexOf("(step === 'need-lines' || step === 'pending') && !revisionClosed");
    const end = src.indexOf("step === 'pending' && revisionClosed");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const outcome = src.slice(start, end);
    expect(outcome).toMatch(/readinessSummary\.ready\s*\?\s*t\('cn2b_simple_final_server_ready'/);
    expect(outcome).toMatch(/cn2b_simple_readiness_unknown/);
    expect(outcome).not.toMatch(/ready:\s*true/);
    // Submit appears only on the outcome step, only for an editor of the draft,
    // and only as the screen's lifecycle element — no handler of Simple's own.
    expect(outcome).toMatch(/step === 'pending' && \(canWrite \? \(\s*<div className="cn2b-simple-lifecycle" data-testid="cn2b-simple-submit">\{lifecycleActions\}<\/div>/);
    expect(src).not.toMatch(/onSubmit|onApprove|onReject|submitRevision|approveRevision|rejectRevision/);
    const strings = read('src/shared/i18n/strings.ts');
    expect(strings).not.toMatch(/cn2b_simple_[a-z_]+:\s*\{[^}]*كل شيء جاهز/);
  });

  it('the upload surface reuses the same accept list and the same onPickFile handler as Advanced Mode', () => {
    const zone = code(`${SIMPLE_DIR}/SimpleUploadZone.tsx`);
    expect(zone).toContain("'.xlsx,.xls,.csv,.zip'");
    expect(zone).toMatch(/onPickFile\(e\.target\.files\?\.\[0\] \?\? null\)/);
    expect(zone).not.toMatch(/requestUploadTicket|uploadToStaging|finalizeImport|\.rpc\(/);
  });
});

/**
 * CN-UI-S1 HC1 — the contextual expert escape and the material dirty contract,
 * pinned in source: what each is allowed to read, hold and call.
 */
describe('Simple Mode — HC1: the contextual expert escape is presentation-only and the material card reports the frozen contract', () => {
  const workspacePath = `${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`;
  const readinessPath = `${SIMPLE_DIR}/simpleReadiness.ts`;
  const cardPath = `${SIMPLE_DIR}/SimpleMaterialCard.tsx`;

  it('the escape is derived from the ONE readiness prop, through the shared vocabulary — no second authority, no second read', () => {
    const workspace = code(workspacePath);
    // The memo's only input is the readiness the screen owns, and only while it belongs to the selected revision.
    // HC1.2: plus the override chain the screen already holds (read-only), nothing else.
    expect(workspace).toMatch(/deriveSimpleExpertEscapes\(readiness, overrideContext\)/);
    expect(workspace).toMatch(/readiness\.planRevisionId === revision\.id/);
    expect(workspace.match(/deriveSimpleExpertEscapes?\(/g) ?? []).toHaveLength(1);

    const derive = code(readinessPath).match(/export function deriveSimpleExpertEscapes\([\s\S]*?\n\}/);
    expect(derive, 'deriveSimpleExpertEscapes').not.toBeNull();
    const body = (derive as RegExpMatchArray)[0];
    // Same vocabulary and reason parser the summary uses…
    expect(body).toContain('KNOWN_BLOCKERS.has(');
    expect(body).toContain('reasonOf(');
    // …`ready` is the server's, verbatim, and a closed revision never escapes.
    expect(body).toContain('readiness.ready');
    expect(body).toMatch(/readiness\.status !== 'draft'/);
    // It reads the readiness and nothing else: no filename, header, entity, material or UI input.
    expect(body).not.toMatch(/records|dispositions|beneficiaryColumns|fieldName|targetEntity|filename|window|document|fetch|supabase|\.rpc\(/i);
    expect(body).not.toMatch(/ready:\s*(true|false)/);
  });

  it('the escapes route to exactly the stages named by ONE table: open import → source, numeric → review, every diagnostic (invalid evidence, unproven head, unknown blocker, unknown reason) → readiness (HC1 + HC1.1 + HC1.2)', () => {
    const src = code(readinessPath);
    const body = (src.match(/export function deriveSimpleExpertEscapes\([\s\S]*?\n\}/) as RegExpMatchArray)[0];
    // ONE place says which stage a reason opens; the derivation only reads it.
    const table = (src.match(/const ESCAPE_STAGE[\s\S]*?\n\};/) as RegExpMatchArray)[0];
    expect(Object.fromEntries([...table.matchAll(/^\s{2}([a-z_]+): '([a-z]+)',$/gm)].map((m) => [m[1], m[2]]))).toEqual({
      open_import: 'source',
      numeric_override: 'review',
      source_evidence_invalid: 'readiness',
      override_head_unproven: 'readiness',
      unknown_blocker: 'readiness',
      unknown_lineage_reason: 'readiness',
    });
    // …and returns them in Advanced workflow order: never a review escape before a source one, nor a readiness one before either.
    const order = [...(src.match(/const ESCAPE_ORDER[\s\S]*?\];/) as RegExpMatchArray)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(order).toEqual(['open_import', 'numeric_override', 'source_evidence_invalid', 'override_head_unproven', 'unknown_blocker', 'unknown_lineage_reason']);
    expect(body).toContain('ESCAPE_ORDER.filter((reason) => found.has(reason)).map((reason) => ({ stage: ESCAPE_STAGE[reason], reason }))');
    expect(body).not.toContain("stage: '");
    // The one-form is exactly the head of that list — never a second derivation.
    expect(src).toMatch(/export function deriveSimpleExpertEscape\(readiness: ReviewReadiness \| null, context\?: SimpleOverrideContext\): SimpleExpertEscape \| null \{\s*return deriveSimpleExpertEscapes\(readiness, context\)\[0\] \?\? null;\s*\}/);
    // The two literal tokens are the server's own.
    expect(src).toContain("'import_session_still_open'");
    expect(src).toContain("'source_quantity_requires_explicit_numeric_override'");
    // HC1.2 / HC1.4: the cell's head is judged with the canonical helpers (`numericOverrideLexeme`: can it really be PINNED) — never a second head rule, never a re-sort, never a new read.
    expect(src).toContain("import { numericOverrideLexeme, overrideHeads } from '../central-needs.lineage';");
    expect(src).toContain('overrideHeads(context.overrides).get(record)');
    expect(src).not.toMatch(/\.sort\(|\.toSorted\(|\.reverse\(|createdAt/);
  });

  it('the workspace holds no state and no browser dialog for it: the screen owns the busy/dirty guards and the mode', () => {
    const workspace = code(workspacePath);
    expect(workspace.match(/=\s*useState/g) ?? []).toHaveLength(0);
    expect(workspace).not.toMatch(/\bwindow\b|\bdocument\b|\bconfirm\(|\balert\(/);
    expect(workspace).not.toMatch(/\bsetMode\b|setMode\('advanced'\)/);
    // The block is a real button that only ever reports the stage it names…
    const block = workspace.match(/function ExpertEscapeBlock[\s\S]*?\n\}\n/);
    expect(block, 'ExpertEscapeBlock').not.toBeNull();
    expect((block as RegExpMatchArray)[0]).toMatch(/<PhoenixButton[\s\S]*?type="button"[\s\S]*?onClick=\{\(\) => onOpen\(escape\.stage\)\}/);
    expect((block as RegExpMatchArray)[0]).not.toMatch(/<div[^>]*onClick|role="button"/);
    // …and is rendered in exactly the two places it can be needed, each behind the same gate.
    expect(workspace.match(/<ExpertEscapeBlock /g) ?? []).toHaveLength(2);
    expect(workspace.match(/expertEscapeShown && expertEscape !== null && onExpertEscape/g) ?? []).toHaveLength(2);
  });

  it('the permission each escape needs is the one its Advanced stage\'s controls use: source → import, review → edit, readiness → none', () => {
    const workspace = code(workspacePath);
    expect(workspace).toMatch(/stage === 'source' \? canImport && isDraft\s*:\s*stage === 'review' \? canWrite\s*:\s*true/);
    // The first escape the person can ACT on is the one offered; only when none is, the first, with who to ask.
    expect(workspace).toMatch(/expertEscapes\.find\(\(escape\) => expertStageAllowed\(escape\.stage\)\) \?\? expertEscapes\[0\] \?\? null/);
  });

  it('the screen\'s handler is the only mode switch to Advanced and is wired to Simple as a plain callback', () => {
    const screen = code('src/features/central-needs/CentralNeedsScreen.tsx');
    expect(screen).toMatch(/onExpertEscape=\{onExpertEscape\}/);
    const handler = (screen.match(/const onExpertEscape = useCallback\(([\s\S]*?)\n  \}, \[([^\]]*)\]/) as RegExpMatchArray);
    expect(handler, 'onExpertEscape').not.toBeNull();
    // BUSY first, then DIRTY, then ONE batched stage+mode update — and no read, reset, id change or RPC.
    const calls = [...handler[1].matchAll(/\b(window\.alert|window\.confirm|onStageChange|setBackgroundResult|setMode)\(/g)].map((m) => m[1]);
    expect(calls).toEqual(['window.alert', 'window.confirm', 'onStageChange', 'setBackgroundResult', 'setMode']);
    // Every statement, normalized — a stray reset (setPendingFile, setError, setNeedLines…) cannot slip in unseen.
    const statements = handler[1].replace(/\s+/g, ' ').trim();
    expect(statements).toContain("onStageChange(stage); setBackgroundResult(null); setMode('advanced'); const focusStage = () => document.getElementById(stageDomId(stage))?.focus?.({ preventScroll: true }); if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusStage); else queueMicrotask(focusStage);");
    expect([...handler[1].matchAll(/\bset[A-Z]\w*\(/g)].map((m) => m[0])).toEqual(['setBackgroundResult(', 'setMode(']);
    expect(handler[1]).not.toMatch(/reloadRevision|refreshRevision|set(?:Revision|ActiveSession|DataRevision|Readiness|Revisions)\w*\(|resetRevisionScopedState|\.rpc\(/);
    expect(handler[2].split(',').map((s) => s.trim()).sort()).toEqual(['expertSwitchBusy', 'expertSwitchDirty', 'lang', 'onStageChange']);
    // The Advanced panels that report into the SAME activity slots release them when they leave the tree.
    expect(screen).toMatch(/<ReleaseActivityOnUnmount onRelease=\{releaseReviewActivity\}>\s*<CentralNeedsDispositionTable/);
    expect(screen).toMatch(/<ReleaseActivityOnUnmount onRelease=\{releaseBeneficiaryActivity\}>\s*<CentralNeedsBeneficiaryColumnPanel/);
    expect(screen).toMatch(/<ReleaseActivityOnUnmount onRelease=\{releaseNeedLineActivity\}>\s*<CentralNeedsNeedLinePanel/);
    // The two guards read the screen's own activity state, nothing synthesized.
    // HC1.1 adds the stored-workbook slot to the ESCAPE's guards ONLY; the Work Session switch's own guard is unchanged.
    expect(screen).toMatch(/const expertSwitchBusy = busy !== null \|\| reviewActivity\.busy \|\| needLineActivity\.busy \|\| storedWorkbookActivity\.busy;/);
    expect(screen).toMatch(/const expertSwitchDirty = reviewActivity\.dirty \|\| needLineActivity\.dirty \|\| storedWorkbookActivity\.dirty;/);
    expect(screen).toMatch(/const sessionDraftDirty = reviewActivity\.dirty \|\| needLineActivity\.dirty;/);
    expect(screen).toMatch(/const sessionSwitchBlocked = sessionLoading\s*\|\| reviewActivity\.busy\s*\|\| needLineActivity\.busy;/);
  });

  it('the material card reports the pinned rule: its dirty value IS materialCardHasLocalWork over its own four states', () => {
    const card = code(cardPath);
    expect(card).toMatch(/const dirty = materialCardHasLocalWork\(\{ picking, query, showNotApplicable, notApplicableReason \}\);/);
    expect(card).toMatch(/onActivityChange\?\.\(\{ busy, dirty, failed: error !== null \}\)/);
    const rule = card.match(/export function materialCardHasLocalWork[\s\S]*?\n\}\n/);
    expect(rule, 'materialCardHasLocalWork').not.toBeNull();
    // Every term, as the owner froze it — none dropped, none added, no persisted write involved.
    expect((rule as RegExpMatchArray)[0].replace(/\s+/g, ' ')).toContain(
      "return state.picking || state.query.trim() !== '' || state.showNotApplicable || state.notApplicableReason.trim() !== '';",
    );
    // Cancelling a picker resets its query, so a closed picker never strands invisible "work".
    expect(card).toMatch(/onClick=\{\(\) => \{ setPicking\(false\); setQuery\(''\); \}\}/);
    // And it still reaches the same single write, once per decision.
    expect(card.match(/await setRecordDisposition\(/g) ?? []).toHaveLength(2);
  });

  it('the escape block is really styled: a flex block, logical properties only, and a button that can WRAP (PhoenixButton writes nowrap inline, so only !important wins)', () => {
    const css = read('src/shared/lib/central-needs.css');
    expect(css.match(/\.cn2b-simple-expert \{[^}]*\}/)?.[0]).toMatch(/display:\s*flex/);
    const button = css.match(/\.cn2b-simple-expert \.phoenix-button \{[^}]*\}/)?.[0] ?? '';
    expect(button).toMatch(/white-space:\s*normal\s*!important/);
    expect(button).toMatch(/min-block-size:\s*var\(--touch-target, 44px\)/);
    // The inline style that makes !important necessary — if PhoenixButton stops writing it, this note can go.
    expect(read('src/shared/ui/PhoenixButton.tsx')).toMatch(/whiteSpace:\s*'nowrap'/);
    for (const rule of css.match(/\.cn2b-simple-expert[^{]*\{[^}]*\}/g) ?? []) {
      expect(rule).not.toMatch(/(^|[\s;{])(margin-left|margin-right|padding-left|padding-right|left|right)\s*:/m);
      expect(rule).not.toMatch(/text-align:\s*(left|right)/);
    }
    // And on a phone the button fills the block.
    expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.cn2b-simple-expert \.phoenix-button \{ inline-size: 100%; \}/);
  });

  it('no part of HC1 adds a service call, a permission key or a second blocker taxonomy', () => {
    for (const file of [workspacePath, readinessPath, cardPath]) {
      const src = code(file);
      expect(src, file).not.toMatch(/\.rpc\(|from ['"]@\/shared\/supabase\/client['"]|\bsupabase\./);
      expect(src, file).not.toMatch(/central_needs\.(view|import|edit|approve)/);
    }
    // One vocabulary: the escape does not re-declare the blocker catalogue.
    expect(code(readinessPath)).not.toMatch(/new Set\(\[\s*'no_finalized_import'/);
  });
});
