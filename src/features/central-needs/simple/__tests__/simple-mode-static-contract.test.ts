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
 * displayed as if they were.
 */
describe('Simple Mode — summary scope is stated, never implied (Director finding 3)', () => {
  it('the summary labels session scope and carries the explicit not-a-total note', () => {
    const src = code(`${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`);
    expect(src).toMatch(/cn2b_simple_scope_session_title/);
    expect(src).toMatch(/cn2b_simple_scope_session_note/);
    expect(src).toMatch(/cn2b_simple_scope_this_session/);
    expect(src).toMatch(/cn2b_simple_scope_whole_revision/);
  });

  it('the session-scope copy itself says these are not whole-annual-need totals, in both languages', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const note = strings.match(/cn2b_simple_scope_session_note:\s*\{[\s\S]*?\},/);
    expect(note, 'scope note string not found').not.toBeNull();
    expect((note as RegExpMatchArray)[0]).toMatch(/ليست مجموع الاحتياج السنوي بالكامل/);
    expect((note as RegExpMatchArray)[0]).toMatch(/not whole-annual-need totals/);
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
 * Director defect 4: `derivedStep` never returned 'summary', so the approved
 * flow skipped the analysis summary and dropped the user straight into
 * item-by-item review. The gate that fixes it must stay navigation-only.
 */
describe('Simple Mode — the summary is ordered before review, and is navigation only (Director defect 4)', () => {
  const workspacePath = `${SIMPLE_DIR}/CentralNeedsSimpleWorkspace.tsx`;

  it('derivedStep returns summary BEFORE either review step', () => {
    const src = code(workspacePath);
    const derived = src.match(/const derivedStep[\s\S]*?\n\s*\}, \[/);
    expect(derived, 'derivedStep not found').not.toBeNull();
    const body = (derived as RegExpMatchArray)[0];
    const summaryAt = body.indexOf("return 'summary'");
    const institutionAt = body.indexOf("return 'review-institution'");
    const materialAt = body.indexOf("return 'review-material'");
    expect(summaryAt, "derivedStep must be able to return 'summary'").toBeGreaterThan(-1);
    expect(institutionAt).toBeGreaterThan(-1);
    expect(materialAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(institutionAt);
    expect(summaryAt).toBeLessThan(materialAt);
  });

  it('the acknowledgement is keyed by revision AND import session, not a bare boolean', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/datasetKey/);
    expect(src).toMatch(/revision\.id/);
    expect(src).toMatch(/activeSessionId/);
    expect(src).toMatch(/summaryAckKey === datasetKey/);
    // A plain `useState(false)` flag would survive a dataset change.
    expect(src).not.toMatch(/useState<boolean>\(false\)/);
  });

  it('the summary gate persists nothing and reaches no server', () => {
    const src = code(workspacePath);
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/sessionStorage/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bsupabase\./);
  });

  it('the dataset-keyed acknowledgement is the ONLY navigation state — no free step override (finding 5)', () => {
    const src = code(workspacePath);
    // `manualStep` was an unkeyed override that could outlive its dataset.
    expect(src).not.toMatch(/manualStep/);
    expect(src).toMatch(/const step = derivedStep;/);
    // Exactly one piece of component state remains, and it is the keyed one.
    // (Matches declarations only — the `react` import also names useState.)
    expect(src.match(/=\s*useState/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/const \[summaryAckKey, setSummaryAckKey\] = useState/);
    // Returning to the summary withdraws the acknowledgement rather than
    // pinning a step that current props could no longer justify.
    expect(src).toMatch(/function goToSummary\(\) \{ setSummaryAckKey\(null\); \}/);
  });

  it('the guard order keeps a closed or unready revision ahead of the summary', () => {
    const src = code(workspacePath);
    const derived = src.match(/const derivedStep[\s\S]*?\n\s*\}, \[/);
    expect(derived, 'derivedStep not found').not.toBeNull();
    const body = (derived as RegExpMatchArray)[0];
    const summaryAt = body.indexOf("return 'summary'");
    expect(body.indexOf("if (!revision) return 'upload'")).toBeLessThan(summaryAt);
    expect(body.indexOf("if (revisionClosed) return 'upload'")).toBeLessThan(summaryAt);
    expect(body.indexOf("preview.phase === 'parsing' || busy")).toBeLessThan(summaryAt);
    expect(body.indexOf('if (!revisionDataReady)')).toBeLessThan(summaryAt);
  });

  it('the summary still cannot be a dead end — one always-rendered control leaves it', () => {
    const src = code(workspacePath);
    const summaryBlock = src.match(/step === 'summary'[\s\S]*?step === 'review-institution'/);
    expect(summaryBlock, 'summary block not found').not.toBeNull();
    expect((summaryBlock as RegExpMatchArray)[0]).toMatch(/cn2b-simple-review-start/);
    // Not wrapped in a count condition that could hide it.
    expect((summaryBlock as RegExpMatchArray)[0]).not.toMatch(/reviewItemCount > 0 && \(\s*<PhoenixButton/);
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
    // The two switch sites call setMode with a literal and nothing else.
    expect(screenSrc).toMatch(/onSwitchToAdvanced=\{\(\) => setMode\('advanced'\)\}/);
    expect(screenSrc).toMatch(/onClick=\{\(\) => setMode\('simple'\)\}/);
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
    for (const id of ['upload', 'analyzing', 'summary', 'review-institution', 'review-material', 'pending']) {
      expect(stepper, id).toContain(`id: '${id}'`);
    }
    // The indicator is informative only: no click handler can jump steps.
    expect(stepper).not.toMatch(/onClick/);
  });

  it('the Advanced entry is a single quiet footer control, not a toggle at the top of the page', () => {
    const src = code(workspacePath);
    const footerAt = src.indexOf('<footer className="cn2b-simple-footer">');
    const heroAt = src.indexOf('<header className="cn2b-simple-hero">');
    expect(footerAt).toBeGreaterThan(heroAt);
    const hero = src.slice(heroAt, src.indexOf('</header>', heroAt));
    expect(hero).not.toMatch(/onSwitchToAdvanced/);
    expect(src.slice(footerAt)).toMatch(/data-testid="cn2b-simple-advanced-link"/);
  });

  it('the analyzing step shows only phases the props justify and never a fabricated percentage', () => {
    const src = code(workspacePath);
    expect(src).toMatch(/preview\.phase === 'parsing'[\s\S]*?phases: \['active', 'waiting', 'waiting'\]/);
    expect(src).toMatch(/activity === 'verifying'[\s\S]*?phases: \['done', 'active', 'waiting'\]/);
    expect(src).not.toMatch(/%/);
    expect(src).not.toMatch(/aria-valuenow/);
  });

  it('step 6 never claims completion: readiness text is the server verdict and the handoff goes to Advanced', () => {
    const src = code(workspacePath);
    const pending = src.slice(src.indexOf("step === 'pending'"), src.indexOf('<footer className="cn2b-simple-footer">'));
    expect(pending).toMatch(/readinessSummary\.ready\s*\?\s*t\('cn2b_simple_final_server_ready'/);
    expect(pending).toMatch(/cn2b_simple_readiness_unknown/);
    expect(pending).toMatch(/cn2b-simple-continue-advanced/);
    expect(pending).not.toMatch(/ready:\s*true/);
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
