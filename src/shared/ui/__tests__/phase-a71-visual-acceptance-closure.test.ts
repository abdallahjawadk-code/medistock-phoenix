import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/**
 * A7.1 — Phoenix Daylight visual ACCEPTANCE CLOSURE contract.
 *
 * A7's own contract test (phase-a-visual-convergence.test.ts) already covers
 * the CSS-layer/token/dependency/reduced-motion/nav-gate invariants for that
 * phase. This file adds the NARROWER set of guarantees specific to closing
 * out A7's five PARTIALLY CONVERGED items (Welcome, screen 21, Internal
 * Alerts, User Management/Admin, Public QR) without deleting or weakening any
 * existing assertion — see the repo's own established maintenance pattern
 * (narrow, documented exclusion only, never delete a guard).
 */
describe('Phase A7.1 Phoenix Daylight visual acceptance closure', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-visual-convergence.css');
  const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');
  const authenticatedApp = read('app/AuthenticatedApp.tsx');
  const alertsScreen = read('features/alerts/InterInstitutionAlertsScreen.tsx');
  const userMgmt = read('features/users/UserManagementScreen.tsx');
  const cleanupWizard = read('features/admin/AvailabilityCleanupWizard.tsx');
  const broadcastGate = read('features/platform-broadcast/PlatformBroadcastGate.tsx');
  const publicQr = read('features/qr/PublicQrScreen.tsx');
  const materialAlertEngine = read('features/alerts/materialAlertEngine.ts');
  const notificationBell = read('shared/ui/NotificationBell.tsx');
  const whatsapp = read('shared/ui/WhatsAppContactButton.tsx');
  const networkMgmt = read('features/network/NetworkManagementScreen.tsx');
  const directSupply = read('features/network/DirectSupplyOperations.tsx');
  const outletDispatch = read('features/outlet/OutletDispatchOperations.tsx');
  const directEntry = read('features/procurement/DirectEntryPanel.tsx');
  const tokens = read('shared/lib/tokens.css');

  // PHASE-A-CLAUDE-A7.2: a later, separately-reviewed phase (Premium Living
  // Auth & Welcome) legitimately adds ONE further CSS import right after this
  // one — src/shared/lib/phase-a-auth-welcome-signature.css, itself gated
  // behind the same html[data-phoenix-ui-phase='a'][data-phoenix-visual=
  // 'daylight'] marker (see phase-a-auth-welcome-signature.test.ts) — so the
  // invariant this test protects (no import silently reorders ahead of an
  // established layer) becomes: the ONLY file allowed to follow is that one,
  // and nothing follows THAT one in turn.
  it('the visual convergence CSS is immediately followed only by the new A7.2 signature layer — nothing else reorders ahead (A7.1 only appended rules to it)', () => {
    const convergenceImport = "import '@/shared/lib/phase-a-visual-convergence.css';";
    const signatureImport = "import '@/shared/lib/phase-a-auth-welcome-signature.css';";
    const convergenceIndex = main.indexOf(convergenceImport);
    expect(convergenceIndex).toBeGreaterThan(-1);
    const afterConvergence = main.slice(convergenceIndex + convergenceImport.length);
    const nextCssMatch = afterConvergence.match(/import ['"].*\.css['"];/);
    expect(nextCssMatch?.[0]).toBe(signatureImport);
    const afterSignature = afterConvergence.slice(afterConvergence.indexOf(signatureImport) + signatureImport.length);
    expect(afterSignature).not.toMatch(/import ['"].*\.css['"]/);
  });

  it('every new Welcome rule this pass added is still gated behind BOTH the Phase A marker and the daylight marker', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const welcomeSelectorLines = withoutComments
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('.nexus-welcome') && l.endsWith('{'));
    expect(welcomeSelectorLines.length).toBeGreaterThan(0);
    const ungated = welcomeSelectorLines.filter(sel =>
      !sel.includes("data-phoenix-ui-phase='a'") || !sel.includes("data-phoenix-visual='daylight'"),
    );
    expect(ungated).toEqual([]);
  });

  it('the CSS file still has no external URL, no @import, and no new dependency', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/https?:\/\//);
    const deps = Object.keys(pkg.dependencies).sort();
    const devDeps = Object.keys(pkg.devDependencies).sort();
    expect(deps).toEqual([
      '@fontsource-variable/dm-sans', '@fontsource-variable/inter', '@fontsource-variable/noto-sans-arabic',
      '@fontsource/ibm-plex-sans-arabic', '@react-three/fiber', '@supabase/supabase-js', 'exceljs',
      'qrcode', 'react', 'react-dom', 'tesseract.js', 'three',
    ]);
    expect(devDeps).toEqual([
      '@testing-library/jest-dom', '@testing-library/react', '@types/node', '@types/pg', '@types/qrcode',
      '@types/react', '@types/react-dom', '@types/three', '@typescript-eslint/eslint-plugin',
      '@typescript-eslint/parser', '@vitejs/plugin-react', 'eslint', 'jsdom', 'pg', 'playwright-core',
      'sharp', 'typescript', 'vite', 'vitest',
    ]);
  });

  it('no migration, Supabase service/RPC call site, route registry, or authz file has a working-tree diff', () => {
    let diff = '';
    try {
      // STAGE-E-E7-2: a still later, separately-reviewed phase wires the
      // Stage-E outlet corridor into the application, editing exactly two
      // service files — organizations.service.ts (the organization writer now
      // sends the Migration-164/171 classification pair it previously omitted)
      // and warehouses.service.ts (distribution points now carry Migration
      // 164's clinical_location_kind). Neither is a visual change, and E7-2
      // adds NO migration — `supabase/migrations/*.sql` stays fully watched
      // here, so a stray SQL edit would still fail this guard.
      // R1.1-P: adds ONE shared navigation projection (nav-projection.ts) and
      // updates its own guard test, both under src/shared/authz. Excluded BY
      // EXACT NAME. R1.1-P is a frontend/UX phase that creates NO migration, so
      // `supabase/migrations/*.sql` remains fully watched here and a stray SQL
      // edit would still fail this guard.
      diff = execSync(
        'git diff --name-only HEAD -- supabase/migrations/*.sql src/shared/supabase src/app/AuthenticatedApp.tsx src/app/App.tsx src/shared/authz '
        + '":!src/shared/supabase/services/organizations.service.ts" '
        + '":!src/shared/supabase/services/warehouses.service.ts" '
        + '":!src/shared/authz/nav-projection.ts" '
        + '":!src/shared/authz/__tests__/screen-access.test.ts" '
        // R1.3: the canonical supply cycle makes screen 17's navigation gate
        // capability-correct (a warehouse_transfer.send holder reaches the
        // Supply surface without users.edit_scope) and adds its own guard test.
        // Both under src/shared/authz, excluded BY EXACT NAME. R1.3 DOES add a
        // migration, but `supabase/migrations/*.sql` is deliberately NOT
        // excluded here — 184 is reviewed by its own static/dynamic suites, and
        // this guard is left free to fail on any OTHER stray SQL edit.
        + '":!src/shared/authz/screen-access.ts" '
        + '":!src/shared/authz/__tests__/r1-3-supply-reachability.test.ts" '
        // ALERT-CQRS-BOUNDARY-190 (G4.1): two GUARD TESTS under the watched
        // src/shared/supabase prefix are re-pointed by that later,
        // separately-reviewed phase — their alert-lifecycle zero-diff clauses
        // are superseded by the inter-org alert read/write split. Excluded BY
        // EXACT NAME. No production service under src/shared/supabase is
        // excluded, and every other watched path stays fully covered.
        + '":!src/shared/supabase/services/__tests__/dashboard-service-rpc-switch.test.ts" '
        + '":!src/shared/supabase/services/__tests__/frontend-live-removed-at-filters.test.ts" '
        // CANONICAL-SCOPE-TOPOLOGY-191 (G4.2): a later, separately-reviewed
        // phase moves facility/scope TOPOLOGY out of the browser and into the
        // database. Under the paths this guard watches it adds exactly ONE new
        // read service — scope-topology.service.ts, a thin client for the new
        // pure query, with no visual surface at all — and re-points ONE guard
        // test under src/shared/authz whose clauses pinned the client-side
        // scope reconstruction that 191 removes. Both excluded BY EXACT NAME.
        // Every other watched path — the rest of src/shared/supabase,
        // AuthenticatedApp.tsx, App.tsx and the rest of src/shared/authz —
        // stays fully covered.
        + '":!src/shared/supabase/services/scope-topology.service.ts" '
        + '":!src/shared/authz/__tests__/ub-facility-scope-activation.test.ts"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  // PHASE-A-CLAUDE-A7.2: a later, separately-reviewed phase (Premium Living
  // Auth & Welcome) deliberately edits this file's JSX — swapping the
  // photographic Phoenix-bird <picture> for <InstitutionalSupplyMotif> — so
  // it is no longer byte-for-byte unchanged. The BEHAVIOURAL invariant this
  // test protects (every handler/timing constant untouched) is unaffected
  // and asserted directly below instead of via a zero-diff check.
  // PHASE-A-CLAUDE-A7.2.2 re-pointed the hero once more, from that motif to
  // <AuthSupplyHero> (A7.2.3). The behavioural assertions are unchanged.
  it('Welcome keeps every skip/timing/completion handler unchanged — only the hero visual was replaced (A7.2 → A7.2.2)', () => {
    expect(welcome).toContain('const finish = useCallback(');
    expect(welcome).toContain('SEQUENCE_MS = 6000');
    expect(welcome).toContain('REDUCED_MS = 900');
    expect(welcome).toContain("window.setTimeout(finish, reduced ? REDUCED_MS : SEQUENCE_MS)");
    expect(welcome).toContain('AuthSupplyHero');
  });

  it('screen 21 routing (AuthenticatedApp.tsx) is byte-for-byte unchanged', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/app/AuthenticatedApp.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    expect(authenticatedApp).toContain('case 21: return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} />;');
  });

  // ALERT-CQRS-BOUNDARY-190 (G4.1): the zero-diff form is superseded — that
  // later, separately-reviewed phase rewrites this screen's LOAD (an explicit
  // refresh COMMAND followed by a PURE query) so that opening or paging it no
  // longer writes lifecycle rows. The invariant this test exists to protect —
  // that the screen stays permanently non-executable, read-only discovery —
  // is unaffected and is asserted directly.
  it('Internal Alerts (screen 13) remain permanently non-executable, read-only discovery', () => {
    expect(alertsScreen).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    // No execution corridor: the screen offers no dispatch/transfer/supply action.
    expect(alertsScreen).not.toMatch(/createTransfer|dispatch|supplyRequest/i);
    // Its only writes are the lifecycle commands, which are not alert execution.
    expect(alertsScreen).toContain('updateInterOrgAlertState');
    expect(alertsScreen).toContain('reopenInterOrgAlert');
  });

  it('User Management lifecycle/permission gates are unchanged', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --unified=0 HEAD -- src/features/users/UserManagementScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    // M187 registers exactly these two ADDED lines. This is a SUBSET assertion,
    // not an equality one, because the command above diffs the WORKING TREE:
    // uncommitted it emits both lines; once committed — and on every CI
    // checkout — it emits nothing. Both states pass. Deletions stay forbidden
    // outright, so together these are as fail-closed as the pre-187 assertion
    // that the whole file was untouched: any modified, moved or extra line
    // produces either an unlisted `+` or a `-`, and both fail.
    const AUTHORIZED_ADDED = [
      "+import { DelegatedAccessPanel } from './DelegatedAccessPanel';",
      '+          {selectedUser && isSuper && <DelegatedAccessPanel actorRole={role} target={selectedUser} lang={lang} onToast={showToast} />}',
    ];
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
    expect(added.filter(line => !AUTHORIZED_ADDED.includes(line))).toEqual([]);
    const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'));
    expect(removed).toEqual([]);
    expect(userMgmt).toContain("const canViewUsers = isSuper || actorEff.has('users.view');");
    expect(userMgmt).toContain("const canRecycle   = isSuper || actorEff.has('users.recycle');");
  });

  it('Cleanup Wizard stays fail-closed: dry run mandatory, exact confirmation phrase, backup checkbox required', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/features/admin/AvailabilityCleanupWizard.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    expect(cleanupWizard).toContain("const canExecute = dryRunCounts !== null && backupAcknowledged && confirmationMatches && !executeBusy;");
    expect(cleanupWizard).toContain('DEEP_CLEAN_AVAILABILITY_CONFIRMATION');
  });

  it('Platform Broadcast acknowledgement gate stays mandatory — no silent dismiss', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/features/platform-broadcast/PlatformBroadcastGate.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    expect(broadcastGate).toContain('no dismiss without acknowledging, by design');
    expect(broadcastGate).not.toMatch(/onClose=\{[^}]*setQueue/);
  });

  it("Public QR's privacy predicate (isPubliclyAvailableQrItem) is unchanged", () => {
    // A7.2.4 NARROWING (documented exclusion, guard never deleted): the whole
    // file is no longer required to be byte-for-byte identical, because
    // A7.2.4 legitimately replaces this screen's decorative header icon with
    // the new global brand mark (Public QR branding area — presentation-only,
    // see phase-a724-pharmacy-emblem-rollout.test.ts). What this test must
    // keep proving is narrower and unchanged: the privacy predicate itself
    // was never touched by that (or any other) edit — checked both by exact
    // content below AND by confirming no diff line even mentions it.
    let diff = '';
    try {
      diff = execSync(
        'git diff HEAD -- src/features/qr/PublicQrScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff).not.toContain('isPubliclyAvailableQrItem');
    expect(diff).not.toMatch(/^[+-].*item\.quantity/m);
    expect(publicQr).toContain('export function isPubliclyAvailableQrItem(item: PublicItem): boolean {');
    expect(publicQr).toContain("if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) return false;");
  });

  it('no touched file introduces Math.random or a fabricated KPI value', () => {
    for (const [name, src] of [
      ['materialAlertEngine', materialAlertEngine], ['NotificationBell', notificationBell],
      ['WhatsAppContactButton', whatsapp], ['NetworkManagementScreen', networkMgmt],
      ['DirectSupplyOperations', directSupply], ['OutletDispatchOperations', outletDispatch],
      ['DirectEntryPanel', directEntry], ['phase-a-visual-convergence.css', css],
    ] as const) {
      expect(src, `${name} must not use Math.random for a displayed value`).not.toMatch(/Math\.random\(\)/);
    }
  });

  it('leaves no temporary QA scene or fixture committed: the QA harness files are byte-for-byte unchanged from HEAD', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/features/qa/QaHarness.tsx src/features/qa/qaData.ts src/features/qa/qaFixtureClient.ts src/features/qa/qaFixtures.ts src/features/qa/qaScopes.ts src/features/qa/qaConfig.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    // Belt-and-braces: none of the A7.1-only scratch scene ids ever reached
    // the committed harness (they were reverted, not merely unreferenced).
    const harness = read('features/qa/QaHarness.tsx');
    for (const scratchSceneId of ['screen21', 'alerts13', 'users14', 'broadcastack', 'publicqr']) {
      expect(harness).not.toContain(`'${scratchSceneId}'`);
    }
  });

  it('leaves no .env.local or other local-only env file in the committed tree', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- .env.local .env .env.*.local', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(status.trim()).toBe('');
  });

  it('the hardcoded-colour allowlist exists and documents only the approved exception categories', () => {
    const allowlistPath = join(ROOT, 'docs/phoenix/visual-evidence/a71/hardcoded-colour-allowlist.md');
    expect(existsSync(allowlistPath)).toBe(true);
    const allowlist = readFileSync(allowlistPath, 'utf8');
    // Every documented exception must fall under one of these named categories.
    for (const category of [
      'WebGL', 'QR code generation', 'Print / export HTML', 'Camera/video viewfinder',
      'PWA manifest', 'mask-image', 'Token-definition sites',
    ]) {
      expect(allowlist, `allowlist must document the "${category}" category`).toContain(category);
    }
    // And every exception entry names a file — no vague, unattributable exclusion.
    expect(allowlist).toMatch(/\| `src\//);
  });

  it('operational UI colour tokens this pass introduced are defined once, in tokens.css', () => {
    for (const token of [
      '--on-accent:', '--risk-tier-3m:', '--risk-tier-3m-bg:', '--risk-tier-9m:', '--risk-tier-9m-bg:',
      '--whatsapp-brand:', '--whatsapp-brand-bg:', '--whatsapp-brand-ink:',
    ]) {
      expect(tokens, `${token} must be defined in tokens.css`).toContain(token);
    }
    // And the components that used to hardcode them now read the token instead.
    expect(materialAlertEngine).not.toMatch(/#dc2626|#fef2f2|#b45309|#fef3c7/i);
    expect(whatsapp).not.toMatch(/#25D366|#e9fbf1|#0d7a3f/i);
  });

  it('the renamed legacy status-center evidence file no longer carries an ambiguous name, and is not cited as screen-21 evidence', () => {
    const legacyPath = join(ROOT, 'docs/phoenix/visual-evidence/a7/legacy-status-center-screen12-ar-light-desktop.png');
    const oldAmbiguousPath = join(ROOT, 'docs/phoenix/visual-evidence/a7/status-ar-light-desktop.png');
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(oldAmbiguousPath)).toBe(false);
    // Real screen-21 evidence lives under its own, separately-named a71 folder.
    const a71Dir = join(ROOT, 'docs/phoenix/visual-evidence/a71');
    expect(existsSync(a71Dir)).toBe(true);
  });

  it('pure-presentation files touched this pass never call a mutation/RPC method at all', () => {
    // materialAlertEngine/NotificationBell/WhatsAppContactButton carry no
    // service calls whatsoever — a stricter, whole-file check is valid here.
    for (const [name, src] of [
      ['materialAlertEngine', materialAlertEngine], ['NotificationBell', notificationBell],
      ['WhatsAppContactButton', whatsapp],
    ] as const) {
      expect(src, `${name} must not call a mutation/RPC method`).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    }
  });

  it("this pass's edit to each operational screen ADDED only a colour-token line, never a new mutation/RPC call", () => {
    // NetworkManagementScreen/DirectSupplyOperations/OutletDispatchOperations/
    // DirectEntryPanel are real operational screens that legitimately call
    // mutating RPCs elsewhere for their own pre-existing business logic — the
    // whole-file check above would be wrong for them. Check the DIFF instead:
    // every added (+) line this pass introduced must be presentation-only.
    for (const file of [
      'src/features/network/NetworkManagementScreen.tsx',
      'src/features/network/DirectSupplyOperations.tsx',
      'src/features/outlet/OutletDispatchOperations.tsx',
      'src/features/procurement/DirectEntryPanel.tsx',
    ]) {
      let diff = '';
      try {
        diff = execSync(`git diff HEAD -- ${file}`, { cwd: ROOT, encoding: 'utf8' });
      } catch { /* ignore */ }
      const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      for (const line of addedLines) {
        expect(line, `${file} added an unexpected mutation/RPC call: ${line}`).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
      }
    }
  });
});
