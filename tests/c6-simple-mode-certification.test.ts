/**
 * C6 — REAL-CORPUS END-TO-END CERTIFICATION, layer D: Simple Mode (static).
 *
 * This layer reads SOURCE only — no database, no corpus, no rendering — and
 * runs under plain `npm test`. It certifies how Simple Mode, the default
 * Annual Needs experience, stands next to the canonical Stage 2 path that
 * tests/c6-real-corpus-lifecycle.dynamic.test.ts drives over the certified
 * corpus. Nothing here needs the corpus, so the corpus helper is not imported.
 *
 * TWO KNOWN, ACCEPTED FINDINGS are certified AS THEY ARE and are NOT fixed:
 *   F1  Simple's material and quantity figures are ACTIVE-SESSION scoped: the
 *       screen loads source records and dispositions per import session
 *       (`listSourceRecords(activeSessionId)` / `listDispositions(activeSessionId)`
 *       in CentralNeedsScreen.tsx), and one archive finalizes into many sessions.
 *   F2  Simple's bulk "confirm quantities" action stays intentionally disabled.
 *
 * WHAT IS CERTIFIED INSTEAD
 *   D0  THE SURFACE. simple/ plus every central-needs directory it reaches by
 *       import (excel-first/, import/, mapping/, regions/). Every Simple claim
 *       below is checked over that whole surface, not over simple/ alone.
 *   D1  SCOPE HONESTY (F1 stated, never hidden). The summary card carries the
 *       session-scope title and note; each metric's <dt> labels its OWN scope
 *       beside its own count — institutions "across the whole annual need",
 *       materials and quantities "this file only" — and each label is true of
 *       the data it sits on. The four scope strings exist in Arabic AND English
 *       and say what they say. F1's reach BEYOND the summary is stated rather
 *       than certified away: the final step is entered once the ACTIVE
 *       session's material queue is empty, and its heading
 *       ("Institutions and materials reviewed") carries no scope qualifier —
 *       reported as a C6 observation; in the same card every readiness outcome
 *       renders the server's own revision-wide verdict (D2).
 *   D2  READINESS STAYS REVISION-WIDE AND SERVER-COMPUTED. The readiness RPC
 *       takes the plan revision id and nothing else (service and every
 *       migration); the screen reads it only under a revision id, never a
 *       session id, and hands Simple that one state; Simple never reads
 *       readiness itself, projects the server's `ready`/`status` verbatim and
 *       renders the server's own blockers. The DATABASE-level proof over the
 *       real corpus — completing the active session alone leaves the revision
 *       blocked by every other session — is L4 of the dynamic suite and is
 *       deliberately not duplicated here.
 *   D3  ADVANCED MODE IS THE CANONICAL NEEDLINE PATH. `setNeedLine` /
 *       `deleteNeedLine` each call exactly one canonical RPC; their only caller
 *       — indeed the only file that references them at all, even as a value —
 *       in src/ is the Advanced need-line panel, mounted only in the Advanced
 *       stage sections; no file of the Simple surface imports, names or calls
 *       them; Simple's whole prop surface is pinned, its callbacks being the
 *       canonical handlers and read-only re-reads; Simple's final step hands
 *       need-line work to Advanced.
 *   D4  F2 IS A BARE DISABLED ATTRIBUTE. The one confirm-quantities control is
 *       `disabled` with no initializer (no state can re-enable it), carries no
 *       handler, ref or spread, and PhoenixButton forwards that `disabled` to
 *       the native button after its prop spread.
 *   D5  ONE PERSISTED BUSINESS STATE. The service WRITES the Simple surface
 *       reaches are exactly setBeneficiaryColumns, setRecordDisposition and
 *       setBeneficiaryRegions — classified FAIL-CLOSED from what each service
 *       function finally calls, not from its name — and each maps to exactly
 *       one canonical RPC that no other service function calls. The first two
 *       are also invoked by Advanced panels; the regions the third writes are
 *       read revision-wide by the screen and handed to BOTH modes. Simple issues
 *       no data call of its own, its import and revision-opening writes run
 *       through the screen's own handlers that Advanced's controls also use,
 *       and what it borrows from outside its surface reaches no write.
 *
 * NOT CERTIFIED HERE
 *   * An Advanced Mode WRITE surface for beneficiary regions: setBeneficiaryRegions
 *     is reached only through regions/BeneficiaryRegionLayer.tsx, which only
 *     Simple's stored-workbook view mounts. Advanced reads the same persisted
 *     regions (D5) but offers no region write. Reported as a C6 finding.
 *   * What the screen re-reads after a Simple decision at runtime — the defect
 *     C6 confirmed, fixed by C6-B1 (5d4e3f0e) and certified by that commit's own
 *     runtime regression test (simple/__tests__/c6-b1-simple-material-refresh);
 *     this layer pins only that the new callback is a read-only re-read (D3).
 *
 * METHOD. Textual checks run on comment-stripped source (the stripper of
 * simple/__tests__/simple-mode-static-contract.test.ts), so prose can neither
 * satisfy nor hide a check. Structural checks parse the source with the
 * TypeScript compiler API already shipped as a dev dependency, so they follow
 * import bindings, call sites and JSX attributes rather than formatting. The
 * literals below are i18n keys, test ids, RPC names and short fragments of the
 * product's own UI copy (src/shared/i18n/strings.ts) — never corpus content.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { T } from '../src/shared/i18n/strings';
import { summarizeSimpleReadiness } from '../src/features/central-needs/simple/simpleReadiness';
import { computeSimpleCounts } from '../src/features/central-needs/simple/simpleCounts';
import type {
  BeneficiaryColumnSummary,
  RecordDisposition,
  ReviewBlocker,
  SourceRecord,
} from '../src/features/central-needs/central-needs.service';

// ---------------------------------------------------------------------------
// Source access
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..');
const CN = 'src/features/central-needs';
const SERVICE = `${CN}/central-needs.service.ts`;
const SCREEN = `${CN}/CentralNeedsScreen.tsx`;
const WORKSPACE = `${CN}/simple/CentralNeedsSimpleWorkspace.tsx`;
const READINESS = `${CN}/simple/simpleReadiness.ts`;
const NEED_LINE_PANEL = `${CN}/CentralNeedsNeedLinePanel.tsx`;
const COLUMN_PANEL = `${CN}/CentralNeedsBeneficiaryColumnPanel.tsx`;
const DISPOSITION_TABLE = `${CN}/CentralNeedsDispositionTable.tsx`;
const PHOENIX_BUTTON = 'src/shared/ui/PhoenixButton.tsx';
const MIGRATIONS = 'supabase/migrations';

const ARABIC = /[؀-ۿ]/;

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
/** The repository's comment stripper: prose can neither satisfy nor hide a textual check. */
const code = (p: string): string =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Non-test .ts/.tsx sources under a repo-relative directory, recursively. */
function sourcesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourcesIn(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// TypeScript AST helpers (parse only — no type checker, no program)
// ---------------------------------------------------------------------------

type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function descendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => { out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
}

const parsed = new Map<string, { sf: ts.SourceFile; all: ts.Node[] }>();
function ast(p: string): { sf: ts.SourceFile; all: ts.Node[] } {
  let hit = parsed.get(p);
  if (!hit) {
    const sf = ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true, p.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    hit = { sf, all: descendants(sf) };
    parsed.set(p, hit);
  }
  return hit;
}

const within = (n: ts.Node, container: ts.Node): boolean => n.pos >= container.pos && n.end <= container.end;

/** Calls in `root` whose callee is the bare identifier `name`. */
const callsOf = (root: ts.Node, name: string): ts.CallExpression[] =>
  descendants(root).filter((n): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);

const isRpcCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'rpc';

const literalArg = (call: ts.CallExpression, i = 0): string => {
  const arg = call.arguments[i];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : '<dynamic>';
};

/** The nearest enclosing `const name = …` (binding patterns are skipped). */
function enclosingDeclaration(n: ts.Node): string | null {
  for (let c = n.parent; c; c = c.parent) {
    if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name)) return c.name.text;
  }
  return null;
}

/** Top-level functions, classes and variables of a module, by name. */
function topLevel(p: string): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of ast(p).sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.set(d.name.text, d);
    }
  }
  return out;
}

/** Every top-level declaration of `p` that `name` reaches through identifier references, itself included. */
function reach(p: string, name: string): ts.Node[] {
  const top = topLevel(p);
  const seen = new Set<string>();
  const out: ts.Node[] = [];
  const visit = (n: string) => {
    if (seen.has(n) || !top.has(n)) return;
    seen.add(n);
    const decl = top.get(n) as ts.Node;
    out.push(decl);
    for (const id of descendants(decl)) if (ts.isIdentifier(id)) visit(id.text);
  };
  visit(name);
  return out;
}

const jsxOpenings = (root: ts.Node): JsxOpening[] =>
  descendants(root).filter((n): n is JsxOpening => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
const tagOf = (o: JsxOpening): string => o.tagName.getText();
const openingOf = (el: JsxNode): JsxOpening => (ts.isJsxElement(el) ? el.openingElement : el);
const elementOf = (o: JsxOpening): JsxNode => (ts.isJsxOpeningElement(o) ? o.parent : o);
const attribute = (o: JsxOpening, name: string): ts.JsxAttribute | undefined =>
  o.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
/** The attribute's initializer as written, e.g. `{readiness}` — undefined for a missing or bare attribute. */
const attrValue = (o: JsxOpening, name: string): string | undefined => attribute(o, name)?.initializer?.getText();
const testIdOf = (o: JsxOpening): string | undefined => {
  const init = attribute(o, 'data-testid')?.initializer;
  return init && ts.isStringLiteral(init) ? init.text : undefined;
};

/** The ONE element of `file` carrying `data-testid="id"`. */
function byTestId(file: string, id: string): JsxNode {
  const hits = jsxOpenings(ast(file).sf).filter((o) => testIdOf(o) === id);
  expect(hits.map((o) => testIdOf(o)), `${file}: data-testid="${id}"`).toEqual([id]);
  return elementOf(hits[0]);
}

/** i18n keys rendered through `t('key', …)` inside `root`, in document order. */
const tKeys = (root: ts.Node): string[] =>
  callsOf(root, 't').filter((c) => ts.isStringLiteralLike(c.arguments[0])).map((c) => literalArg(c));

// ---------------------------------------------------------------------------
// Imports and the Simple surface (D0)
// ---------------------------------------------------------------------------

interface ImportedBinding { local: string; imported: string; typeOnly: boolean }
interface ImportRecord { spec: string; target: string; bindings: ImportedBinding[]; namespace: boolean }

/** A module specifier resolved to a repo-relative file (relative and `@/` specifiers only). */
function resolveModule(from: string, spec: string): string {
  let base: string;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else return spec;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(ROOT, candidate))) return candidate;
  }
  return base;
}

function importsOf(p: string): ImportRecord[] {
  return ast(p).sf.statements.filter(ts.isImportDeclaration).map((d) => {
    const spec = (d.moduleSpecifier as ts.StringLiteral).text;
    const clause = d.importClause;
    const clauseTypeOnly = clause?.isTypeOnly ?? false;
    const bindings: ImportedBinding[] = [];
    if (clause?.name) bindings.push({ local: clause.name.text, imported: 'default', typeOnly: clauseTypeOnly });
    const named = clause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        bindings.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, typeOnly: clauseTypeOnly || el.isTypeOnly });
      }
    }
    return { spec, target: resolveModule(p, spec), bindings, namespace: Boolean(named && ts.isNamespaceImport(named)) };
  });
}

/** Value bindings `p` imports from `target` that it actually references: local name → exported name. */
function referencedImports(p: string, target: string): Map<string, string> {
  const locals = new Map<string, string>();
  for (const rec of importsOf(p)) {
    if (rec.target === target) for (const b of rec.bindings) if (!b.typeOnly) locals.set(b.local, b.imported);
  }
  const used = new Map<string, string>();
  for (const n of ast(p).all) {
    if (!ts.isIdentifier(n) || !locals.has(n.text)) continue;
    const parent = n.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) continue;
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) && parent.name === n) continue;
    used.set(n.text, locals.get(n.text) as string);
  }
  return used;
}

const DIR_OF = new RegExp(`^${CN}/([^/]+)/`);
const PARENT_MODULE = new RegExp(`^${CN}/[^/]+\\.tsx?$`);

/** simple/ plus every central-needs directory reached from it by import, transitively. */
function surfaceDirs(): string[] {
  const dirs = new Set(['simple']);
  const queue = ['simple'];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    for (const file of sourcesIn(`${CN}/${dir}`)) {
      for (const { target } of importsOf(file)) {
        const reached = DIR_OF.exec(target)?.[1];
        if (reached && !dirs.has(reached)) { dirs.add(reached); queue.push(reached); }
      }
    }
  }
  return [...dirs].sort();
}

const SURFACE_DIRS = surfaceDirs();
const SURFACE = SURFACE_DIRS.flatMap((d) => sourcesIn(`${CN}/${d}`));
const ALL_SRC = sourcesIn('src');

/** Files (other than the service) that import `exported` from the service as a value and call it. */
function callersOf(exported: string, files: readonly string[] = ALL_SRC): string[] {
  return files.filter((f) => f !== SERVICE && read(f).includes(exported)).filter((f) => {
    const locals = importsOf(f).filter((i) => i.target === SERVICE).flatMap((i) => i.bindings)
      .filter((b) => !b.typeOnly && b.imported === exported).map((b) => b.local);
    return locals.some((local) => callsOf(ast(f).sf, local).length > 0);
  });
}

// ---------------------------------------------------------------------------
// Service sinks (D5) — what a service function finally does, followed through
// the module's own helpers. FAIL-CLOSED: any RPC not named below, any trusted
// endpoint other than the read-only download, any storage/table mutator is a
// WRITE, whatever the function is called.
// ---------------------------------------------------------------------------

/** RPCs that return rows without commanding state — by EXACT name, never by prefix. */
const READ_ONLY_RPCS = new Set([
  'phoenix_central_needs_list_need_lines', //          listNeedLineLineage: SECURITY INVOKER read
  'phoenix_central_needs_revision_lifecycle', //       fetchRevisionLifecycle: the lifecycle read model
  'phoenix_central_needs_list_beneficiary_columns', // listBeneficiaryColumns: SECURITY INVOKER read
  'phoenix_central_needs_review_readiness', //         fetchReviewReadiness: blockers only (FOR KEY SHARE lock, M214)
]);
/** source-download reads one batch row under RLS and mints a signed GET URL; it persists nothing. */
const READ_ONLY_ENDPOINTS = new Set(['/api/central-needs/source-download']);
/** PostgREST and Storage mutators. A namesake on another object is a false positive that fails closed. */
const MUTATORS = new Set(['insert', 'update', 'upsert', 'delete', 'remove', 'upload', 'uploadToSignedUrl', 'move', 'copy']);

interface Sinks { rpcs: string[]; endpoints: string[]; mutators: string[] }

function sinks(fn: string): Sinks {
  const rpcs = new Set<string>();
  const endpoints = new Set<string>();
  const mutators = new Set<string>();
  for (const decl of reach(SERVICE, fn)) {
    for (const n of descendants(decl)) {
      if (!ts.isCallExpression(n)) continue;
      if (ts.isPropertyAccessExpression(n.expression)) {
        if (n.expression.name.text === 'rpc') rpcs.add(literalArg(n));
        if (MUTATORS.has(n.expression.name.text)) mutators.add(n.expression.name.text);
      } else if (ts.isIdentifier(n.expression) && n.expression.text === 'authorizedFetch') {
        endpoints.add(literalArg(n));
      }
    }
  }
  return { rpcs: [...rpcs].sort(), endpoints: [...endpoints].sort(), mutators: [...mutators].sort() };
}

const isWrite = (s: Sinks): boolean =>
  s.rpcs.some((r) => !READ_ONLY_RPCS.has(r)) || s.endpoints.some((e) => !READ_ONLY_ENDPOINTS.has(e)) || s.mutators.length > 0;

const isServiceFunction = (name: string): boolean => {
  const decl = topLevel(SERVICE).get(name);
  if (!decl) return false;
  if (ts.isFunctionDeclaration(decl)) return true;
  return ts.isVariableDeclaration(decl) && decl.initializer !== undefined
    && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
};

/** RPC names a service function calls in its OWN body (not through helpers). */
const directRpcs = (fn: string): string[] =>
  descendants(topLevel(SERVICE).get(fn) as ts.Node).filter(isRpcCall).map((c) => literalArg(c));

/** Every service export the Simple surface references as a value: exported name → files. */
function serviceUseBySurface(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of SURFACE) {
    for (const exported of referencedImports(f, SERVICE).values()) out.set(exported, [...(out.get(exported) ?? []), f]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The screen: which branch is Simple, which is Advanced
// ---------------------------------------------------------------------------

function modeSwitch(): ts.ConditionalExpression {
  const hits = ast(SCREEN).all.filter((n): n is ts.ConditionalExpression =>
    ts.isConditionalExpression(n) && n.condition.getText() === "mode === 'simple'");
  expect(hits, "the screen's mode === 'simple' switch").toHaveLength(1);
  return hits[0];
}

/** The screen's single <CentralNeedsSimpleWorkspace …/> element, inside the Simple branch. */
function simpleElement(): JsxOpening {
  const all = jsxOpenings(ast(SCREEN).sf).filter((o) => tagOf(o) === 'CentralNeedsSimpleWorkspace');
  expect(all, 'CentralNeedsSimpleWorkspace mounts').toHaveLength(1);
  expect(within(all[0], modeSwitch().whenTrue)).toBe(true);
  return all[0];
}

/** One entry of the screen's `stageBody` record — the Advanced six-stage sections. */
function stageEntry(key: string): ts.Expression {
  const decl = ast(SCREEN).all.filter((n): n is ts.VariableDeclaration =>
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'stageBody');
  expect(decl, 'stageBody').toHaveLength(1);
  const record = decl[0].initializer;
  expect(record && ts.isObjectLiteralExpression(record)).toBe(true);
  const prop = (record as ts.ObjectLiteralExpression).properties.find((p): p is ts.PropertyAssignment =>
    ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key);
  expect(prop, `stageBody['${key}']`).toBeDefined();
  return (prop as ts.PropertyAssignment).initializer;
}

/** Asserts `component` is mounted by the screen ONLY inside stageBody[stageKey], which only Advanced renders. */
function expectAdvancedOnlyMount(component: string, stageKey: string): void {
  const mounts = jsxOpenings(ast(SCREEN).sf).filter((o) => tagOf(o) === component);
  expect(mounts.length, `${component} mounts`).toBeGreaterThan(0);
  const entry = stageEntry(stageKey);
  for (const m of mounts) expect(within(m, entry), `${component} outside stageBody['${stageKey}']`).toBe(true);
  const { whenTrue, whenFalse } = modeSwitch();
  const renders = ast(SCREEN).all.filter((n) => ts.isIdentifier(n) && n.text === 'stageBody' && !ts.isVariableDeclaration(n.parent));
  expect(renders.length, 'stageBody is rendered').toBeGreaterThan(0);
  for (const r of renders) {
    expect(within(r, whenFalse), 'stageBody rendered outside the Advanced branch').toBe(true);
    expect(within(r, whenTrue)).toBe(false);
  }
}

/** A `const name = useCallback(…)` of the screen, and its callback. */
function screenCallback(name: string): ts.ArrowFunction {
  const decl = ast(SCREEN).all.find((n): n is ts.VariableDeclaration =>
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name);
  expect(decl, name).toBeDefined();
  const init = (decl as ts.VariableDeclaration).initializer;
  expect(init && ts.isCallExpression(init) && init.expression.getText() === 'useCallback', `${name} = useCallback(…)`).toBe(true);
  const fn = (init as ts.CallExpression).arguments[0];
  expect(ts.isArrowFunction(fn), `${name}'s callback`).toBe(true);
  return fn as ts.ArrowFunction;
}

/** Shorthand for a T entry both of whose languages must be present and distinct. */
function bilingual(key: string): { ar: string; en: string } {
  const entry = T[key];
  expect(entry, `strings.ts has ${key}`).toBeDefined();
  expect(entry.ar.trim(), `${key}.ar`).not.toBe('');
  expect(entry.en.trim(), `${key}.en`).not.toBe('');
  expect(entry.ar, `${key}.ar is Arabic`).toMatch(ARABIC);
  expect(entry.ar, `${key}: ar and en differ`).not.toBe(entry.en);
  return entry;
}

// ===========================================================================

describe('C6-D0 — the Simple Mode surface under certification', () => {
  it('is simple/ plus every central-needs directory it reaches by import (excel-first/, import/, mapping/, regions/)', () => {
    expect(SURFACE_DIRS).toEqual(['excel-first', 'import', 'mapping', 'regions', 'simple']);
    // The directories Simple RENDERS components from are reached directly from simple/.
    const direct = new Set(sourcesIn(`${CN}/simple`).flatMap((f) => importsOf(f).map((i) => DIR_OF.exec(i.target)?.[1])));
    for (const d of ['excel-first', 'mapping', 'regions']) expect(direct.has(d), `simple/ imports ${d}/`).toBe(true);
    for (const d of SURFACE_DIRS) expect(SURFACE.some((f) => f.startsWith(`${CN}/${d}/`)), `${d}/ has sources`).toBe(true);
  });
});

describe('C6-D1 — scope honesty: each Simple summary metric states its own scope (accepted finding F1)', () => {
  it('the four scope strings exist in Arabic and English and say what they say', () => {
    const title = bilingual('cn2b_simple_scope_session_title');
    const thisSession = bilingual('cn2b_simple_scope_this_session');
    const wholeRevision = bilingual('cn2b_simple_scope_whole_revision');
    const note = bilingual('cn2b_simple_scope_session_note');

    expect(title.en).toMatch(/current work session/);
    expect(title.en).toMatch(/\bthis file\b/);
    expect(thisSession.en).toMatch(/\bthis file only\b/);
    expect(thisSession.ar).toContain('فقط');
    expect(wholeRevision.en).toMatch(/\bwhole annual need\b/);
    expect(wholeRevision.ar).toContain('كامل');
    expect(note.en).toMatch(/material and quantity figures/);
    expect(note.en).toMatch(/current import session only/);
    expect(note.en).toMatch(/not whole-annual-need totals/);
    expect(note.en).toMatch(/many sessions/);
    expect(note.ar).toContain('فقط');
    expect(note.ar).toContain('ليست');
    // The two metric scopes are different claims in both languages.
    expect(thisSession.en).not.toBe(wholeRevision.en);
    expect(thisSession.ar).not.toBe(wholeRevision.ar);
  });

  it('the summary card carries the session-scope title and note, and each <dt> labels its own scope beside its own count', () => {
    const summary = byTestId(WORKSPACE, 'cn2b-simple-summary');
    const title = byTestId(WORKSPACE, 'cn2b-simple-summary-scope-title');
    const note = byTestId(WORKSPACE, 'cn2b-simple-summary-scope-note');
    expect(within(title, summary) && within(note, summary)).toBe(true);
    expect(tKeys(title)).toEqual(['cn2b_simple_scope_session_title']);
    expect(tKeys(note)).toEqual(['cn2b_simple_scope_session_note']);

    const METRICS = [
      { id: 'institutions', label: 'cn2b_simple_institutions', scope: 'cn2b_simple_scope_whole_revision', value: 'counts.institutionsConfirmed' },
      { id: 'materials', label: 'cn2b_simple_materials', scope: 'cn2b_simple_scope_this_session', value: 'counts.materialsMapped' },
      { id: 'quantities', label: 'cn2b_simple_quantities', scope: 'cn2b_simple_scope_this_session', value: 'counts.quantityCandidateCount' },
    ];
    for (const m of METRICS) {
      const span = byTestId(WORKSPACE, `cn2b-simple-scope-${m.id}`);
      expect(tagOf(openingOf(span)), m.id).toBe('span');
      expect(tKeys(span), m.id).toEqual([m.scope]);
      expect(within(span, summary), m.id).toBe(true);

      const dt = span.parent;
      expect(ts.isJsxElement(dt) && tagOf(dt.openingElement) === 'dt', `${m.id}: the scope span sits in the metric's <dt>`).toBe(true);
      expect(tKeys(dt), `${m.id}: label, then its own scope`).toEqual([m.label, m.scope]);

      const stat = (dt as ts.JsxElement).parent;
      const dd = byTestId(WORKSPACE, `cn2b-simple-count-${m.id}`);
      expect(tagOf(openingOf(dd)), m.id).toBe('dd');
      expect(within(dd, stat), `${m.id}: the count sits beside its label`).toBe(true);
      expect(descendants(dd).filter(ts.isJsxExpression).map((e) => e.expression?.getText()), m.id).toEqual([m.value]);
    }
  });

  it('each label is true of its data: institutions come from the revision-wide column list, materials and quantities only from the active session', () => {
    // Screen: the session-keyed reads that make "this file only" true (F1)…
    for (const name of ['listSourceRecords', 'listDispositions']) {
      const calls = callsOf(ast(SCREEN).sf, name);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const c of calls) expect(c.arguments.map((a) => a.getText()), name).toEqual(['activeSessionId']);
    }
    // …and the revision-keyed read that makes "across the whole annual need" true.
    const columnsRead = callsOf(ast(SCREEN).sf, 'listBeneficiaryColumns');
    expect(columnsRead.map((c) => c.arguments.map((a) => a.getText()))).toEqual([['id']]);
    expect(within(columnsRead[0], screenCallback('reloadRevision'))).toBe(true);

    const simple = simpleElement();
    expect(attrValue(simple, 'beneficiaryColumns')).toBe('{beneficiaryColumns}');
    expect(attrValue(simple, 'records')).toBe('{records}');
    expect(attrValue(simple, 'dispositions')).toBe('{dispositions}');
    expect(attrValue(simple, 'activeSessionId')).toBe('{activeSessionId}');

    const counts = ast(WORKSPACE).all.find((n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'counts');
    const compute = callsOf(counts as ts.Node, 'computeSimpleCounts');
    expect(compute.map((c) => c.arguments.map((a) => a.getText()))).toEqual([['beneficiaryColumns', 'records', 'dispositions']]);

    // The figures follow exactly those inputs: two sessions' confirmed columns
    // count as institutions whether or not any session's rows are loaded, while
    // materials and quantities exist only for the loaded session's rows.
    const column = (importSessionId: string, org: string): BeneficiaryColumnSummary => ({
      importSessionId, originalFilename: null, archiveEntryPath: null, sheetIndex: 0, sheetName: null, columnIndex: 1,
      sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1, mappingId: `m-${importSessionId}`,
      decision: 'beneficiary', beneficiaryOrganizationId: org, mappingReason: null, mappedAt: null,
      mappedRowNumericCount: 1, reviewRequired: false,
    });
    const record: SourceRecord = {
      id: 'r-1', importSessionId: 'session-1', recordOrdinal: 0, targetEntity: 'row-1', fieldName: 'f',
      sourceValues: {}, sourceProvenance: { sheetIndex: 0, coordinate: { row: 1, col: 1 } },
    };
    const disposition: RecordDisposition = {
      id: 'd-1', importSessionId: 'session-1', targetEntity: 'row-1', decision: 'mapped', centralItemId: 'item-1',
      decisionReason: null, decidedAt: '2026-01-01T00:00:00Z',
    };
    const columns = [column('session-1', 'org-a'), column('session-2', 'org-b')];
    const loaded = computeSimpleCounts(columns, [record], [disposition]);
    const none = computeSimpleCounts(columns, [], []);
    expect([loaded.institutionsConfirmed, none.institutionsConfirmed]).toEqual([2, 2]);
    expect([loaded.materialsMapped, loaded.quantityCandidateCount]).toEqual([1, 1]);
    expect([none.materialsMapped, none.quantityCandidateCount]).toEqual([0, 0]);
  });

  it("F1's reach beyond the summary, STATED not hidden: the final step is entered on the active session's rows alone, and its unqualified heading always sits beside the server's revision-wide verdict", () => {
    // The step order: 'pending' follows once the (revision-wide) column queue AND the (session-scoped) material queue are empty.
    const decl = (name: string) => ast(WORKSPACE).all.find((n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) as ts.VariableDeclaration;
    const derived = decl('derivedStep');
    const returns = descendants(derived).filter(ts.isReturnStatement).map((r) => r.expression?.getText());
    expect(returns.slice(-3)).toEqual(["'review-institution'", "'review-material'", "'pending'"]);
    const guards = descendants(derived).filter(ts.isIfStatement).map((s) => s.expression.getText());
    expect(guards.slice(-2)).toEqual(['unresolvedColumns.length > 0', 'undispositionedEntities.length > 0']);
    // The material queue is built from the ACTIVE session's records and dispositions only (F1).
    const queue = decl('undispositionedEntities');
    const deps = (queue.initializer as ts.CallExpression).arguments[1].getText();
    expect(deps).toBe('[records, dispositionedEntities]');
    expect(((decl('dispositionedEntities').initializer as ts.CallExpression).arguments[1]).getText()).toBe('[dispositions]');

    // The final card's heading carries no scope qualifier (reported as an F1 observation, not fixed here)…
    const pending = byTestId(WORKSPACE, 'cn2b-simple-pending');
    expect(tKeys(byTestId(WORKSPACE, 'cn2b-simple-pending-title'))).toEqual(['cn2b_simple_reviewed_all']);
    // …and in the SAME card every readiness outcome renders the server's own, revision-wide verdict (D2).
    for (const id of ['cn2b-simple-readiness-unknown', 'cn2b-simple-readiness-messages', 'cn2b-simple-readiness-clear']) {
      expect(within(byTestId(WORKSPACE, id), pending), id).toBe(true);
    }
    expect(bilingual('cn2b_simple_final_server_pending').en).toMatch(/According to the server/);
  });
});

describe('C6-D2 — readiness stays revision-wide and server-computed (DB proof over the real corpus: dynamic suite L4)', () => {
  it('the readiness RPC takes the plan revision id and nothing else — in the service and in every migration', () => {
    const fn = topLevel(SERVICE).get('fetchReviewReadiness');
    expect(fn && ts.isFunctionDeclaration(fn)).toBe(true);
    expect((fn as ts.FunctionDeclaration).parameters.map((p) => p.getText())).toEqual(['planRevisionId: string']);
    const rpcs = descendants(fn as ts.Node).filter(isRpcCall);
    expect(rpcs.map((c) => literalArg(c))).toEqual(['phoenix_central_needs_review_readiness']);
    const args = rpcs[0].arguments[1];
    expect(args && ts.isObjectLiteralExpression(args)).toBe(true);
    expect((args as ts.ObjectLiteralExpression).properties.map((p) => p.getText())).toEqual(['p_plan_revision_id: planRevisionId']);

    const sql = readdirSync(join(ROOT, MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => read(`${MIGRATIONS}/${f}`).replace(/--[^\n]*/g, ' ')).join('\n');
    const creates = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.phoenix_central_needs_review_readiness\s*\(([^)]*)\)/gi)]
      .map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c).toBe('p_plan_revision_id uuid');
    const signatures = new Set([...sql.matchAll(/phoenix_central_needs_review_readiness\s*\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()));
    expect([...signatures].sort()).toEqual(['p_plan_revision_id uuid', 'uuid']);
  });

  it('the screen reads readiness only under a revision id — every readiness read and revision re-read is keyed by the revision, never by a session', () => {
    expect(callersOf('fetchReviewReadiness')).toEqual([SCREEN]);

    // The screen's revision-id carriers: callbacks whose `id` parameter is a plan revision id.
    const CARRIERS = ['reloadRevision', 'refreshRevision', 'rereadAfterSuccess', 'runLifecycleAction'];
    for (const name of CARRIERS) {
      const first = screenCallback(name).parameters[0];
      expect(`${first.name.getText()}: ${first.type?.getText()}`, name).toBe('id: string');
    }
    const REVISION_ARGS = new Set(['revisionId', 'revisionId as string', 'revision.id']);
    for (const name of ['fetchReviewReadiness', ...CARRIERS]) {
      const calls = callsOf(ast(SCREEN).sf, name);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const c of calls) {
        const arg = c.arguments[0].getText();
        const carrier = enclosingDeclaration(c);
        const keyedByRevision = REVISION_ARGS.has(arg) || (arg === 'id' && carrier !== null && CARRIERS.includes(carrier));
        expect(keyedByRevision, `${name}(${arg}) inside ${carrier}`).toBe(true);
        expect(arg, name).not.toMatch(/session/i);
      }
    }

    // The revision reload binds its readiness to the readiness read of THAT revision.
    const reload = screenCallback('reloadRevision');
    const binding = descendants(reload).find((n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.name.getText().includes('nextReadiness'));
    expect(binding, 'the reload destructures nextReadiness').toBeDefined();
    const names = ((binding as ts.VariableDeclaration).name as ts.ArrayBindingPattern).elements.map((e) => e.getText());
    const all = descendants((binding as ts.VariableDeclaration).initializer as ts.Node)
      .find((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === 'Promise.all');
    const reads = ((all as ts.CallExpression).arguments[0] as ts.ArrayLiteralExpression).elements.map((e) => e.getText());
    expect(reads[names.indexOf('nextReadiness')]).toBe('fetchReviewReadiness(id)');
  });

  it("Simple receives the screen's one readiness state, set only from revision readiness reads, and never reads readiness itself", () => {
    const setters = callsOf(ast(SCREEN).sf, 'setReadiness').map((c) => c.arguments.map((a) => a.getText()).join(', '));
    expect(setters.length).toBeGreaterThan(0);
    for (const s of setters) expect(['null', 'nextReadiness', 'await fetchReviewReadiness(revisionId)'], s).toContain(s);
    expect(attrValue(simpleElement(), 'readiness')).toBe('{readiness}');

    for (const f of SURFACE) {
      expect(code(f), f).not.toMatch(/\bfetchReviewReadiness\b/);
      expect(code(f), f).not.toMatch(/phoenix_central_needs_review_readiness/);
    }
  });

  it("summarizeSimpleReadiness projects the server's ready/status verbatim and reads only the server's blockers — nothing is synthesized", () => {
    const fn = topLevel(READINESS).get('summarizeSimpleReadiness');
    expect(fn && ts.isFunctionDeclaration(fn)).toBe(true);
    const body = (fn as ts.FunctionDeclaration).body as ts.Block;
    expect(body.statements[0].getText()).toBe('if (!readiness) return null;');
    const loops = descendants(body).filter(ts.isForOfStatement).map((l) => l.expression.getText());
    expect(loops).toEqual(['readiness.blockers']);
    const ready = descendants(body).filter((n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText() === 'ready');
    const status = descendants(body).filter((n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText() === 'status');
    expect(ready.map((p) => p.initializer.getText())).toEqual(['readiness.ready']);
    expect(status.map((p) => p.initializer.getText())).toEqual(['readiness.status']);

    // Nowhere in the Simple surface is `ready` ever a literal.
    const literalReady = SURFACE.flatMap((f) => ast(f).all
      .filter((n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText() === 'ready'
        && (n.initializer.kind === ts.SyntaxKind.TrueKeyword || n.initializer.kind === ts.SyntaxKind.FalseKeyword))
      .map((n) => `${f}: ${n.getText()}`));
    expect(literalReady).toEqual([]);

    // Behaviour: whatever the blockers, the verdict is the server's.
    expect(summarizeSimpleReadiness(null)).toBeNull();
    const BLOCKER_SETS: ReviewBlocker[][] = [
      [],
      [{ blocker: 'target_entity_without_disposition', detail: null }],
      [{ blocker: 'c6_blocker_code_this_build_does_not_know', detail: null }],
    ];
    for (const ready of [true, false]) {
      for (const blockers of BLOCKER_SETS) {
        const s = summarizeSimpleReadiness({ planRevisionId: 'rev-c6', status: 'draft', ready, blockers });
        expect(s?.ready, `ready=${ready} blockers=${blockers.length}`).toBe(ready);
        expect(s?.status).toBe('draft');
        expect(s?.messageKeys.length === 0, 'messages exist exactly when the server listed blockers').toBe(blockers.length === 0);
      }
    }
  });

  it("the final step renders the server's blocker messages and the server's verdict, never its own", () => {
    const decl = ast(WORKSPACE).all.find((n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'readinessSummary');
    expect(decl?.initializer?.getText()).toBe('useMemo(() => summarizeSimpleReadiness(readiness), [readiness])');
    const component = topLevel(WORKSPACE).get('CentralNeedsSimpleWorkspace') as ts.FunctionDeclaration;
    const props = component.parameters[0].name;
    expect(ts.isObjectBindingPattern(props) && props.elements.some((e) => e.name.getText() === 'readiness'), 'readiness is a prop').toBe(true);

    const pending = byTestId(WORKSPACE, 'cn2b-simple-pending');
    const messages = byTestId(WORKSPACE, 'cn2b-simple-readiness-messages');
    expect(within(messages, pending)).toBe(true);
    const mapped = descendants(messages).filter((n): n is ts.CallExpression => ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'map'
      && n.expression.expression.getText() === 'readinessSummary.messageKeys');
    expect(mapped, 'the list maps the server-derived message keys').toHaveLength(1);
    expect(callsOf(mapped[0], 't').map((c) => c.arguments[0].getText())).toEqual(['key']);

    const verdict = byTestId(WORKSPACE, 'cn2b-simple-readiness-clear');
    expect(within(verdict, pending)).toBe(true);
    const choice = descendants(verdict).filter(ts.isConditionalExpression);
    expect(choice.map((c) => c.condition.getText())).toEqual(['readinessSummary.ready']);
    expect(tKeys(verdict)).toEqual(['cn2b_simple_final_server_ready', 'cn2b_simple_readiness_clear']);
    expect(tKeys(byTestId(WORKSPACE, 'cn2b-simple-readiness-unknown'))).toEqual(['cn2b_simple_readiness_unknown']);
  });
});

describe('C6-D3 — Advanced Mode is the canonical NeedLine path; Simple never writes a need line', () => {
  it('setNeedLine and deleteNeedLine each call exactly one canonical RPC', () => {
    expect(sinks('setNeedLine')).toEqual({ rpcs: ['phoenix_central_needs_set_need_line'], endpoints: [], mutators: [] });
    expect(sinks('deleteNeedLine')).toEqual({ rpcs: ['phoenix_central_needs_delete_need_line'], endpoints: [], mutators: [] });
  });

  it('the Advanced need-line panel is their only caller in src/, and the screen mounts it only in the Advanced need-lines stage', () => {
    expect(callersOf('setNeedLine')).toEqual([NEED_LINE_PANEL]);
    expect(callersOf('deleteNeedLine')).toEqual([NEED_LINE_PANEL]);
    expectAdvancedOnlyMount('CentralNeedsNeedLinePanel', 'need-lines');
  });

  it('no file of the Simple surface imports, names or calls setNeedLine / deleteNeedLine (comments stripped; AST)', () => {
    const violations: string[] = [];
    for (const f of SURFACE) {
      const text = code(f);
      for (const re of [/\bsetNeedLine\b/, /\bdeleteNeedLine\b/, /\bCentralNeedsNeedLinePanel\b/, /phoenix_central_needs_(set|delete)_need_line/]) {
        if (re.test(text)) violations.push(`${f}: ${re}`);
      }
      for (const rec of importsOf(f)) {
        if (rec.target === NEED_LINE_PANEL) violations.push(`${f}: imports the need-line panel`);
        for (const b of rec.bindings) if (/^(setNeedLine|deleteNeedLine)$/.test(b.imported)) violations.push(`${f}: imports ${b.imported}`);
      }
      for (const n of ast(f).all) {
        if (!ts.isCallExpression(n)) continue;
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText();
        if (/^(setNeedLine|deleteNeedLine)$/.test(callee)) violations.push(`${f}: calls ${callee}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no file but the Advanced panel even REFERENCES setNeedLine / deleteNeedLine — not as a value, a prop or a callback handed down', () => {
    for (const fn of ['setNeedLine', 'deleteNeedLine']) {
      // A file that never spells the name cannot import it; only the rest are parsed.
      const refs = ALL_SRC.filter((f) => f !== SERVICE && read(f).includes(fn))
        .filter((f) => [...referencedImports(f, SERVICE).values()].includes(fn));
      expect(refs, fn).toEqual([NEED_LINE_PANEL]);
    }
  }, 60_000);

  it("Simple's whole prop surface is pinned: its only callbacks are the canonical handlers and read-only re-reads — no write can be passed in", () => {
    const simple = simpleElement();
    const names = simple.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? p.name.getText() : `{...${p.getText()}}`));
    expect(names.slice().sort()).toEqual([
      'activeSessionId', 'activity', 'batches', 'beneficiaryColumns', 'beneficiaryRegions', 'busy', 'canEdit', 'canImport',
      'careInstitutions', 'dispositions', 'error', 'isDraft', 'lang', 'newerRevisionNumber', 'notice', 'onChanged',
      'onMaterialResolved', 'onOpenRevision', 'onPickFile', 'onPlanYearChange', 'onRefused', 'onSwitchToAdvanced', 'onVerify',
      'pendingFile', 'planYear', 'preview', 'readiness', 'records', 'revision', 'revisionDataReady', 'revisionsLoading', 'sessions',
    ]);
    expect(attrValue(simple, 'onChanged')).toBe('{() => refreshRevision(revisionId as string)}');
    // C6-B1 (5d4e3f0e, in the certified base): a confirmed material decision re-reads
    // through read-only authorities only — the active session's dispositions and the
    // revision's readiness (the Advanced disposition table's path), then the revision.
    expect(attrValue(simple, 'onMaterialResolved')).toBe('{onSimpleMaterialResolved}');
    const calleesOf = (fn: ts.ArrowFunction): string[] =>
      [...new Set(descendants(fn.body).filter(ts.isCallExpression).map((c) => c.expression.getText()))].sort();
    expect(calleesOf(screenCallback('onSimpleMaterialResolved')))
      .toEqual(['onDispositionsChanged', 'onDispositionsChanged().catch', 'refreshRevision', 'setError']);
    expect(calleesOf(screenCallback('onDispositionsChanged')))
      .toEqual(['fetchReviewReadiness', 'listDispositions', 'setDispositions', 'setReadiness', 'setReadinessRefreshing']);
    for (const reader of ['listDispositions', 'fetchReviewReadiness']) expect(isWrite(sinks(reader)), reader).toBe(false);
    expect(attrValue(simple, 'onRefused')).toBe('{(refusal) => void rereadAfterRefusal(refusal)}');
    expect(attrValue(simple, 'onPlanYearChange')).toBe('{setPlanYear}');
  });

  it("Simple's final step hands need-line work to Advanced Mode", () => {
    const pending = byTestId(WORKSPACE, 'cn2b-simple-pending');
    const handoff = byTestId(WORKSPACE, 'cn2b-simple-handoff');
    expect(within(handoff, pending)).toBe(true);
    expect(tKeys(handoff)).toEqual(['cn2b_simple_final_handoff', 'cn2b_simple_final_continue_advanced']);
    const go = openingOf(byTestId(WORKSPACE, 'cn2b-simple-continue-advanced'));
    expect(within(go, handoff)).toBe(true);
    expect(attrValue(go, 'onClick')).toBe('{onSwitchToAdvanced}');
    expect(attrValue(simpleElement(), 'onSwitchToAdvanced')).toBe("{() => setMode('advanced')}");

    const text = bilingual('cn2b_simple_final_handoff');
    expect(text.en).toMatch(/\bneed lines\b/);
    expect(text.en).toMatch(/\badvanced options\b/);
  });
});

describe('C6-D4 — the bulk quantity confirmation stays a bare, handler-less disabled control (accepted finding F2)', () => {
  const TEST_ID = 'cn2b-simple-confirm-quantities';

  it('exactly one element of the whole Simple surface carries it: a PhoenixButton in the final step', () => {
    const hits = SURFACE.flatMap((f) => jsxOpenings(ast(f).sf).filter((o) => testIdOf(o) === TEST_ID).map((o) => ({ f, o })));
    expect(hits.map((h) => h.f)).toEqual([WORKSPACE]);
    expect(tagOf(hits[0].o)).toBe('PhoenixButton');
    expect(within(hits[0].o, byTestId(WORKSPACE, 'cn2b-simple-pending'))).toBe(true);
    // Nothing else names it, so nothing can reach for it (e.g. to enable it imperatively).
    const mentions = SURFACE.reduce((n, f) => n + (code(f).match(new RegExp(TEST_ID, 'g'))?.length ?? 0), 0);
    expect(mentions).toBe(1);
  });

  it('its disabled is a BARE attribute — no initializer, so no state can re-enable it — and it has no handler, ref or spread', () => {
    const control = openingOf(byTestId(WORKSPACE, TEST_ID));
    const props = control.attributes.properties;
    expect(props.filter(ts.isJsxSpreadAttribute)).toHaveLength(0);
    const names = props.filter(ts.isJsxAttribute).map((a) => a.name.getText());
    expect(names.filter((n) => n === 'disabled')).toHaveLength(1);
    expect(attribute(control, 'disabled')?.initializer).toBeUndefined();
    expect(names.filter((n) => /^on[A-Z]/.test(n))).toEqual([]);
    expect(names).not.toContain('ref');
    expect(tKeys(elementOf(control))).toEqual(['cn2b_simple_confirm_quantities']);
    // The same, textually, over the element's own source.
    const source = elementOf(control).getText();
    expect(source).not.toMatch(/disabled\s*=/);
    expect(source).not.toMatch(/onClick/);
  });

  it('PhoenixButton forwards that disabled to the native button AFTER its prop spread, so nothing can override it', () => {
    const buttons = jsxOpenings(ast(PHOENIX_BUTTON).sf).filter((o) => tagOf(o) === 'button');
    expect(buttons).toHaveLength(1);
    const props = buttons[0].attributes.properties;
    const spreadAt = props.findIndex((p) => ts.isJsxSpreadAttribute(p));
    const disabledAt = props.findIndex((p) => ts.isJsxAttribute(p) && p.name.getText() === 'disabled');
    expect(spreadAt).toBeGreaterThanOrEqual(0);
    expect(disabledAt).toBeGreaterThan(spreadAt);
    expect(attrValue(buttons[0], 'disabled')).toBe('{disabled || loading}');
    const component = topLevel(PHOENIX_BUTTON).get('PhoenixButton') as ts.FunctionDeclaration;
    const pattern = component.parameters[0].name;
    expect(ts.isObjectBindingPattern(pattern) && pattern.elements.some((e) => e.name.getText() === 'disabled'), 'disabled is taken out of the spread').toBe(true);
  });

  it('its explanatory note says the action is not enabled in this build, in both languages', () => {
    expect(bilingual('cn2b_simple_confirm_quantities_disabled_note').en).toMatch(/not enabled in this build/);
    bilingual('cn2b_simple_confirm_quantities');
  });
});

describe('C6-D5 — one persisted business state: Simple writes only through canonical service exports', () => {
  const CANONICAL_RPC: Record<string, string> = {
    setBeneficiaryColumns: 'phoenix_central_needs_set_beneficiary_columns',
    setRecordDisposition: 'phoenix_central_needs_set_record_disposition',
    setBeneficiaryRegions: 'phoenix_central_needs_set_beneficiary_regions',
  };

  it("the write classifier is grounded in the service's own calls (not vacuous)", () => {
    for (const w of ['openPlanRevision', 'setNeedLine', 'submitRevision', 'approveRevision', 'recordFieldOverride', 'requestUploadTicket', 'uploadToStaging', 'finalizeImport']) {
      expect(isWrite(sinks(w)), `${w} is a write`).toBe(true);
    }
    for (const r of ['listSourceRecords', 'listDispositions', 'listBeneficiaryColumns', 'fetchReviewReadiness', 'requestSourceDownload', 'searchCentralItems', 'listBeneficiaryRegions']) {
      expect(isWrite(sinks(r)), `${r} is a read`).toBe(false);
    }
    expect(sinks('uploadToStaging').mutators).toEqual(['uploadToSignedUrl']);
    expect(sinks('requestSourceDownload').endpoints).toEqual(['/api/central-needs/source-download']);
    const endpoint = code('api/_cn2b-core/source-download.ts');
    expect(endpoint).not.toMatch(/\.(rpc|insert|update|upsert|delete|remove|upload)\(/);
  });

  it('the service writes the Simple surface reaches are exactly setBeneficiaryColumns, setRecordDisposition and setBeneficiaryRegions', () => {
    const use = serviceUseBySurface();
    const unknown = [...use.keys()].filter((name) => !topLevel(SERVICE).has(name));
    expect(unknown, 'every referenced binding is a declared service export').toEqual([]);
    const writes = Object.fromEntries([...use].filter(([name]) => isServiceFunction(name) && isWrite(sinks(name))));
    expect(writes).toEqual({
      setBeneficiaryColumns: [`${CN}/simple/SimpleInstitutionCard.tsx`],
      setRecordDisposition: [`${CN}/simple/SimpleMaterialCard.tsx`],
      setBeneficiaryRegions: [`${CN}/regions/BeneficiaryRegionLayer.tsx`],
    });
  });

  it('each of those writes calls exactly one canonical RPC, and no other service function calls that RPC', () => {
    for (const [fn, rpc] of Object.entries(CANONICAL_RPC)) {
      expect(sinks(fn), fn).toEqual({ rpcs: [rpc], endpoints: [], mutators: [] });
      const owners = [...topLevel(SERVICE).keys()].filter((name) => directRpcs(name).includes(rpc));
      expect(owners, rpc).toEqual([fn]);
    }
  });

  it('setBeneficiaryColumns and setRecordDisposition are ALSO invoked by Advanced panels the screen mounts only in Advanced Mode', () => {
    const outsideSurface = ALL_SRC.filter((f) => !SURFACE.includes(f));
    expect(callersOf('setBeneficiaryColumns', outsideSurface)).toEqual([COLUMN_PANEL]);
    expect(callersOf('setRecordDisposition', outsideSurface)).toEqual([DISPOSITION_TABLE]);
    expectAdvancedOnlyMount('CentralNeedsBeneficiaryColumnPanel', 'beneficiaries');
    expectAdvancedOnlyMount('CentralNeedsDispositionTable', 'review');
  });

  it('the regions setBeneficiaryRegions writes are read revision-wide by the screen and handed to BOTH modes', () => {
    const regionReads = callsOf(ast(SCREEN).sf, 'listBeneficiaryRegions');
    expect(regionReads.map((c) => c.arguments.map((a) => a.getText()))).toEqual([['{ planRevisionId: id }']]);
    expect(within(regionReads[0], screenCallback('reloadRevision'))).toBe(true);
    expect(attrValue(simpleElement(), 'beneficiaryRegions')).toBe('{beneficiaryRegions}');
    const advanced = jsxOpenings(stageEntry('beneficiaries')).filter((o) => tagOf(o) === 'CentralNeedsBeneficiaryColumnPanel');
    expect(advanced.map((o) => attrValue(o, 'beneficiaryRegions'))).toEqual(['{beneficiaryRegions}']);
  });

  it('Simple issues no data call of its own: no Supabase client, no .rpc(, no table or bucket .from(, only GETs of signed URLs', () => {
    const violations: string[] = [];
    for (const f of SURFACE) {
      for (const rec of importsOf(f)) {
        const values = rec.bindings.filter((b) => !b.typeOnly);
        if (/supabase/i.test(rec.spec) && (values.length > 0 || rec.namespace)) violations.push(`${f}: value import of ${rec.spec}`);
        if (rec.spec.startsWith('@/') && values.length > 0 && !/^@\/shared\/(i18n|ui)\//.test(rec.spec)) violations.push(`${f}: value import of ${rec.spec}`);
        if (rec.target === SERVICE && rec.namespace) violations.push(`${f}: namespace import of the service`);
      }
      for (const n of ast(f).all) {
        if (ts.isIdentifier(n) && n.text === 'supabase') violations.push(`${f}: names supabase`);
        if (!ts.isCallExpression(n)) continue;
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push(`${f}: dynamic import()`);
        if (isRpcCall(n)) violations.push(`${f}: ${n.getText().slice(0, 80)}`);
        if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'from' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          violations.push(`${f}: ${n.getText().slice(0, 80)}`);
        }
        if (ts.isIdentifier(n.expression) && n.expression.text === 'fetch') {
          const init = n.arguments[1];
          const method = init && ts.isObjectLiteralExpression(init)
            ? init.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'method')
            : undefined;
          if (method?.initializer.getText() !== "'GET'") violations.push(`${f}: non-GET fetch`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("Simple's import and revision-opening writes run through the screen's own handlers — the same ones Advanced's controls invoke", () => {
    const simple = simpleElement();
    expect(attrValue(simple, 'onPickFile')).toBe('{onPickFile}');
    expect(attrValue(simple, 'onVerify')).toBe('{() => void onVerify()}');
    expect(attrValue(simple, 'onOpenRevision')).toBe('{(openNext) => void onOpenRevision(openNext)}');

    // The canonical import path and the canonical revision-opening RPCs live in those handlers.
    const verify = screenCallback('onVerify');
    for (const w of ['requestUploadTicket', 'uploadToStaging', 'finalizeImport']) expect(callsOf(verify, w).length, w).toBe(1);
    const open = screenCallback('onOpenRevision');
    expect(callsOf(open, 'onOpenCorrection')).toHaveLength(1);
    expect(callsOf(open, 'onOpenAnnualDraft')).toHaveLength(1);
    expect(callsOf(screenCallback('onOpenAnnualDraft'), 'openPlanRevision')).toHaveLength(1);
    expect(callsOf(screenCallback('onOpenCorrection'), 'openCorrectionRevision')).toHaveLength(1);

    // Advanced's own stage sections invoke the very same handlers.
    expect(callsOf(stageEntry('source'), 'onPickFile').length).toBeGreaterThan(0);
    expect(callsOf(stageEntry('source'), 'onVerify').length).toBeGreaterThan(0);
    expect(callsOf(stageEntry('plan'), 'onOpenAnnualDraft').length).toBeGreaterThan(0);
    expect(callsOf(stageEntry('plan'), 'onOpenCorrection').length).toBeGreaterThan(0);
  });

  it('what Simple borrows from outside its surface reaches no service write — only pure helpers of the Advanced column panel', () => {
    const borrowed = new Map<string, Set<string>>();
    for (const f of SURFACE) {
      for (const rec of importsOf(f)) {
        if (!PARENT_MODULE.test(rec.target) || rec.target === SERVICE) continue;
        for (const b of rec.bindings) {
          if (b.typeOnly) continue;
          const names = borrowed.get(rec.target) ?? new Set<string>();
          names.add(b.imported);
          borrowed.set(rec.target, names);
        }
      }
    }
    expect(borrowed.size).toBeGreaterThan(0);
    expect([...borrowed.keys()]).not.toContain(NEED_LINE_PANEL);
    expect([...(borrowed.get(COLUMN_PANEL) ?? [])].sort())
      .toEqual(['NON_BENEFICIARY_CHOICE', 'exactMatchSuggestion', 'mappingFor', 'reasonRequiredFor']);

    for (const [module, names] of borrowed) {
      const writeLocals = new Set(importsOf(module).filter((i) => i.target === SERVICE).flatMap((i) => i.bindings)
        .filter((b) => !b.typeOnly && isServiceFunction(b.imported) && isWrite(sinks(b.imported))).map((b) => b.local));
      for (const name of names) {
        const decls = reach(module, name);
        expect(decls.length, `${module}#${name} is declared there`).toBeGreaterThan(0);
        const touched = decls.flatMap((d) => descendants(d))
          .filter((n): n is ts.Identifier => ts.isIdentifier(n) && writeLocals.has(n.text)).map((n) => n.text);
        expect(touched, `${module}#${name}`).toEqual([]);
      }
    }
  });
});
