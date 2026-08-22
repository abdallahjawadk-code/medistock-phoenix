/**
 * FACILITY-AUTHORITY-REENTRY-GUARD — the graph engine (TEST-ONLY).
 *
 * H Unit 3. This module changes no runtime behaviour: it is imported only by
 * `facility-authority-reentry-guard.test.ts`, and it never executes product
 * code — it reads it with the TypeScript compiler API that already ships as a
 * dev dependency. No new package is introduced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT GUARDS, AND WHY THE PREVIOUS GUARD WAS NOT ENOUGH
 * ─────────────────────────────────────────────────────────────────────────────
 * `screen-access.ts` confines a facility-scoped (L2) role — currently only
 * `health_center_manager` — to `FACILITY_SAFE_SCREENS`. That allow-list is
 * pinned by `r1-3-supply-reachability.test.ts`, which asserts the literal
 * `[3, 6, 15, 18]` and the branch ordering around it.
 *
 * That guards WHICH SCREENS an L2 role may open. It says nothing about WHAT
 * those screens can do. Adding an authority call inside a screen that is
 * already on the list — directly, through a new nested helper, through a hook,
 * or by moving an existing writer into a reachable module — passes every
 * existing test. This engine closes that gap by measuring the authority
 * actually REACHABLE from each safe screen and comparing it to an exact
 * reviewed baseline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY SYMBOL GRANULARITY IS LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 * A module-granularity import graph is unusable here, and that is measured
 * rather than assumed. `PhoenixOrgScope.tsx` imports `getOrganizations` from
 * `organizations.service.ts` — a module that also exports `assignProfileRole`.
 * Following MODULE edges therefore reports RBAC and delegated-scope writers as
 * reachable from all four safe screens (28 command RPCs, 4 direct table
 * writes). Following the SYMBOLS actually referenced reports 14 RPCs and zero
 * table writes, and no RBAC/delegation writer at all — because the only UI that
 * invokes those is `features/users/DelegatedAccessPanel.tsx`, on screen 14,
 * correctly outside the allow-list.
 *
 * So this engine walks identifiers, resolves each through the TypeScript
 * checker (which handles named, aliased, default and re-exported bindings
 * authoritatively), and enqueues only the declarations that reachable code
 * genuinely references.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED POSTURE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every reachable `.rpc('…')` is treated as AUTHORITY unless its exact name is
 * in `PRESENTATION_ONLY_RPCS`. There is deliberately no naming heuristic: a
 * brand-new RPC reachable from a safe screen fails by default, which is the
 * "future RPC is invisible" hole in the old guard. Direct PostgREST relation
 * writes are always authority sinks.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '../../../../');

const SCREEN_ACCESS = 'src/shared/authz/screen-access.ts';
const SCREEN_REGISTRY = 'src/app/AuthenticatedApp.tsx';

export const repoRel = (p: string): string => relative(REPO_ROOT, p).replace(/\\/g, '/');
const abs = (p: string): string => join(REPO_ROOT, p);

/**
 * READ-ONLY RPC EXCEPTIONS — keyed by EXACT name, never by pattern.
 *
 * Each was read at its callsite and confirmed to return rows without
 * commanding state. A prefix/suffix rule (`/^get|list|read|search/`) is
 * explicitly NOT used: `phoenix_inventory_fefo_batches` and
 * `phoenix_movement_timeline` would both escape such a rule by accident, and a
 * future `phoenix_get_and_lock_…` would escape it dangerously.
 */
export const PRESENTATION_ONLY_RPCS: ReadonlyMap<string, string> = new Map([
  ['phoenix_inventory_fefo_batches',
    'Reads candidate FEFO batches for display; commands no movement. Called by dispatch.service::getFefoAlternatives.'],
  ['phoenix_movement_timeline',
    'Reads the movement history projection for a document; writes nothing. Called by movement-timeline.service::getMovementTimeline.'],
  ['phoenix_outlet_replenishment_reversible_batches',
    'Reads which replenishment batches are still reversible; performs no reversal. Called by emergency-replenishment.service::getReversibleBatches.'],
]);

/** PostgREST relation-write primitives that count as authority sinks. */
export const DIRECT_WRITE_OPS = ['insert', 'update', 'upsert', 'delete'] as const;

export interface AuthorityTuple {
  screen: number;
  entryComponent: string;
  callsiteFile: string;
  callsiteSymbol: string;
  sinkType: 'rpc' | 'table-write';
  sink: string;
}

/** Stable identity of a reachability. Deliberately NOT the RPC name alone: a
 *  writer that moves file, gains a new hook, or becomes reachable from another
 *  safe screen produces a different key and must be re-reviewed. */
export const tupleKey = (t: AuthorityTuple): string =>
  `${t.screen}|${t.entryComponent}|${t.callsiteFile}|${t.callsiteSymbol}|${t.sinkType}|${t.sink}`;

export interface AnalyzeResult {
  screens: number[];
  entrypoints: Map<number, string>;
  authority: AuthorityTuple[];
  presentation: AuthorityTuple[];
  visitedSymbols: number;
  reachableFiles: string[];
}

export interface AnalyzeOptions {
  /** repo-relative path -> file content. Shadows or adds files in-memory only;
   *  nothing is written to disk. Used exclusively by the negative controls. */
  overlay?: Record<string, string>;
}

/** A compiler host that serves overlay files from memory, ahead of disk. */
function createHost(options: ts.CompilerOptions, overlay: Map<string, string>): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const norm = (p: string) => resolve(p).replace(/\\/g, '/');
  const byAbs = new Map<string, string>();
  for (const [rel, content] of overlay) byAbs.set(norm(abs(rel)), content);

  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVersion, onError, shouldCreate) => {
    const hit = byAbs.get(norm(fileName));
    if (hit !== undefined) {
      return ts.createSourceFile(fileName, hit, langVersion, true,
        /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    }
    return originalGetSourceFile(fileName, langVersion, onError, shouldCreate);
  };
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => byAbs.has(norm(fileName)) || originalFileExists(fileName);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => byAbs.get(norm(fileName)) ?? originalReadFile(fileName);

  // Module resolution also probes directories and canonicalises paths. Without
  // these, an overlay file inside a folder that does not exist on disk — which
  // is exactly what "a NEW nested helper" means — is unresolvable and the
  // negative controls would silently pass by finding nothing.
  const overlayDirs = new Set<string>();
  for (const p of byAbs.keys()) {
    for (let d = dirname(p); d && d !== dirname(d); d = dirname(d)) overlayDirs.add(norm(d));
  }
  const originalDirectoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dirName) =>
    overlayDirs.has(norm(dirName)) || (originalDirectoryExists ? originalDirectoryExists(dirName) : false);

  const originalRealpath = host.realpath?.bind(host);
  host.realpath = (path) =>
    byAbs.has(norm(path)) || overlayDirs.has(norm(path))
      ? path
      : (originalRealpath ? originalRealpath(path) : path);

  const originalGetDirectories = host.getDirectories?.bind(host);
  host.getDirectories = (dirName) => {
    const base = originalGetDirectories ? originalGetDirectories(dirName) : [];
    const prefix = norm(dirName).replace(/\/?$/, '/');
    const extra = [...overlayDirs]
      .filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes('/'))
      .map((d) => d.slice(prefix.length));
    return [...new Set([...base, ...extra])];
  };
  return host;
}

/** Compiler options mirroring tsconfig.app.json, so `@/…` resolves the way the
 *  application actually resolves it rather than by hand-written guessing. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = join(REPO_ROOT, 'tsconfig.app.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) throw new Error(`cannot read tsconfig.app.json: ${raw.error.messageText}`);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, REPO_ROOT);
  return { ...parsed.options, noEmit: true, skipLibCheck: true, skipDefaultLibCheck: true };
}

const isProductionFile = (p: string): boolean => {
  const r = repoRel(p);
  return r.startsWith('src/') &&
    !r.includes('__tests__') &&
    !/\.(test|spec)\.tsx?$/.test(r) &&
    !r.includes('node_modules');
};

/** Read FACILITY_SAFE_SCREENS from its canonical declaration, via the AST. */
function readFacilitySafeScreens(program: ts.Program): number[] {
  const sf = program.getSourceFile(abs(SCREEN_ACCESS));
  if (!sf) throw new Error(`cannot load ${SCREEN_ACCESS}`);
  let found: number[] | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) &&
        n.name.text === 'FACILITY_SAFE_SCREENS' && n.initializer &&
        ts.isArrayLiteralExpression(n.initializer)) {
      const nums = n.initializer.elements.map((e) =>
        ts.isNumericLiteral(e) ? Number(e.text) : NaN);
      if (nums.some(Number.isNaN)) throw new Error('FACILITY_SAFE_SCREENS holds a non-numeric element');
      found = nums;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error('FACILITY_SAFE_SCREENS declaration not found in screen-access.ts');
  return found;
}

/**
 * Resolve each safe screen id to its production entry component, from the
 * canonical rendering switch. Fails closed when a screen has no resolvable
 * entry, or resolves ambiguously — so adding an id to FACILITY_SAFE_SCREENS
 * automatically widens this guard's roots instead of silently escaping it.
 */
function deriveEntrypoints(
  program: ts.Program, checker: ts.TypeChecker, screens: number[],
): Map<number, { file: string; decl: ts.Node; component: string }> {
  const sf = program.getSourceFile(abs(SCREEN_REGISTRY));
  if (!sf) throw new Error(`cannot load ${SCREEN_REGISTRY}`);

  const byScreen = new Map<number, ts.Identifier[]>();
  const visit = (n: ts.Node): void => {
    if (ts.isCaseClause(n) && ts.isNumericLiteral(n.expression)) {
      const id = Number(n.expression.text);
      if (screens.includes(id)) {
        const tags: ts.Identifier[] = [];
        const scan = (m: ts.Node): void => {
          if (ts.isJsxOpeningElement(m) || ts.isJsxSelfClosingElement(m)) {
            if (ts.isIdentifier(m.tagName) && /^[A-Z]/.test(m.tagName.text)) tags.push(m.tagName);
          }
          ts.forEachChild(m, scan);
        };
        n.statements.forEach(scan);
        byScreen.set(id, (byScreen.get(id) ?? []).concat(tags));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const out = new Map<number, { file: string; decl: ts.Node; component: string }>();
  for (const id of screens) {
    const tags = byScreen.get(id) ?? [];
    const unique = [...new Map(tags.map((t) => [t.text, t])).values()];
    if (unique.length === 0) {
      throw new Error(`facility-safe screen ${id} has no resolvable production entry component in ${SCREEN_REGISTRY}`);
    }
    if (unique.length > 1) {
      throw new Error(`facility-safe screen ${id} resolves ambiguously to ${unique.map((u) => u.text).join(', ')}`);
    }
    const decl = resolveToDeclaration(checker, unique[0]);
    if (!decl) throw new Error(`cannot resolve entry component ${unique[0].text} for screen ${id}`);
    if (!isProductionFile(decl.getSourceFile().fileName)) {
      throw new Error(`entry component ${unique[0].text} for screen ${id} resolves outside production source: ${repoRel(decl.getSourceFile().fileName)}`);
    }
    out.set(id, { file: repoRel(decl.getSourceFile().fileName), decl, component: unique[0].text });
  }
  return out;
}

/** Resolve an identifier to the declaration it actually binds to, following
 *  import aliases and re-exports through the checker. */
function resolveToDeclaration(checker: ts.TypeChecker, id: ts.Identifier): ts.Node | null {
  let sym = checker.getSymbolAtLocation(id);
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch { /* unresolvable alias */ }
  }
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return null;
  return decls.find((d) => isProductionFile(d.getSourceFile().fileName)) ?? decls[0];
}

/** The nearest enclosing named declaration — the "callsite symbol". */
function enclosingSymbolName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
  }
  return '<module>';
}

/** `.rpc('name')` → name. */
function rpcNameOf(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'rpc') return null;
  const a = call.arguments[0];
  return a && ts.isStringLiteralLike(a) ? a.text : null;
}

/** `.from('rel')….insert|update|upsert|delete(` → "rel.op". */
function tableWriteOf(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e)) return null;
  const op = e.name.text as (typeof DIRECT_WRITE_OPS)[number];
  if (!(DIRECT_WRITE_OPS as readonly string[]).includes(op)) return null;
  // Walk left along the builder chain looking for the `.from('rel')` that
  // anchors this write, e.g. supabase.from('x').update({…}).eq(…).
  let cur: ts.Node = e.expression;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const ce = cur.expression;
      if (ts.isPropertyAccessExpression(ce) && ce.name.text === 'from') {
        const a = cur.arguments[0];
        return a && ts.isStringLiteralLike(a) ? `${a.text}.${op}` : `<dynamic>.${op}`;
      }
      cur = ce;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.expression; continue; }
    return null;
  }
}

/**
 * Walk the authority reachable from every facility-safe screen, at symbol
 * granularity.
 */
export function analyzeFacilityAuthorityReach(options: AnalyzeOptions = {}): AnalyzeResult {
  const overlay = new Map<string, string>(Object.entries(options.overlay ?? {}));
  const opts = compilerOptions();
  const rootNames = [abs(SCREEN_ACCESS), abs(SCREEN_REGISTRY), ...[...overlay.keys()].map(abs)];
  const program = ts.createProgram({ rootNames, options: opts, host: createHost(opts, overlay) });
  const checker = program.getTypeChecker();

  const screens = readFacilitySafeScreens(program);
  const entries = deriveEntrypoints(program, checker, screens);

  const authority: AuthorityTuple[] = [];
  const presentation: AuthorityTuple[] = [];
  const reachableFiles = new Set<string>();
  let visitedSymbols = 0;

  for (const [screen, entry] of entries) {
    const seen = new Set<ts.Node>();
    const stack: ts.Node[] = [entry.decl];
    while (stack.length) {
      const decl = stack.pop()!;
      if (seen.has(decl)) continue;
      seen.add(decl);
      visitedSymbols++;
      const file = decl.getSourceFile();
      if (!isProductionFile(file.fileName)) continue;
      reachableFiles.add(repoRel(file.fileName));

      const scan = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const rpc = rpcNameOf(n);
          if (rpc) {
            const t: AuthorityTuple = {
              screen,
              entryComponent: `${entry.file}::${entry.component}`,
              callsiteFile: repoRel(file.fileName),
              callsiteSymbol: enclosingSymbolName(n),
              sinkType: 'rpc',
              sink: rpc,
            };
            (PRESENTATION_ONLY_RPCS.has(rpc) ? presentation : authority).push(t);
          }
          const write = tableWriteOf(n);
          if (write) {
            authority.push({
              screen,
              entryComponent: `${entry.file}::${entry.component}`,
              callsiteFile: repoRel(file.fileName),
              callsiteSymbol: enclosingSymbolName(n),
              sinkType: 'table-write',
              sink: write,
            });
          }
        }
        // Follow only identifiers this reachable code actually references.
        if (ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
          const target = resolveToDeclaration(checker, n);
          if (target && target !== decl && isProductionFile(target.getSourceFile().fileName)) {
            if (!seen.has(target)) stack.push(target);
          }
        }
        ts.forEachChild(n, scan);
      };
      scan(decl);
    }
  }

  const dedupe = (list: AuthorityTuple[]): AuthorityTuple[] =>
    [...new Map(list.map((t) => [tupleKey(t), t])).values()]
      .sort((a, b) => tupleKey(a).localeCompare(tupleKey(b)));

  return {
    screens,
    entrypoints: new Map([...entries].map(([k, v]) => [k, `${v.file}::${v.component}`])),
    authority: dedupe(authority),
    presentation: dedupe(presentation),
    visitedSymbols,
    reachableFiles: [...reachableFiles].sort(),
  };
}

/** Render one tuple for a failure message, per the required diagnostic shape. */
export const renderTuple = (t: AuthorityTuple, reason: string): string =>
  [
    `  SCREEN          = ${t.screen}`,
    `  ENTRY_COMPONENT = ${t.entryComponent}`,
    `  CALLSITE_FILE   = ${t.callsiteFile}`,
    `  CALLSITE_SYMBOL = ${t.callsiteSymbol}`,
    `  SINK_TYPE       = ${t.sinkType}`,
    `  SINK            = ${t.sink}`,
    `  REASON          = ${reason}`,
  ].join('\n');

/** Read a repository file as text (used by tests to build overlays). */
export const readRepoFile = (rel: string): string => readFileSync(abs(rel), 'utf8');
export const dirOf = (rel: string): string => dirname(rel);
