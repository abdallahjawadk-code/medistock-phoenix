import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * INTERACTIVE-GUIDE-IG1 — the STATIC half of the safety contract (AD-04).
 *
 * The runtime half lives in `guide-mutation-freedom.runtime.test.tsx`, which
 * drives a whole tour with a spy on the Supabase client and proves it is never
 * touched. This half is the one that survives a refactor: it reads the guide's
 * own source and fails if a service, an RPC wrapper or a mutation ever becomes
 * reachable from this directory at all.
 *
 * Both are needed. A runtime spy proves the paths the test walked; source
 * inspection proves the paths it did not.
 */

const GUIDE_DIR = join(__dirname, '..');

function collectSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The guide's own tests legitimately import a spy target.
      if (entry === '__tests__') continue;
      files.push(...collectSources(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

/**
 * Comments are stripped before every code-shape assertion.
 *
 * The guide's own modules document WHY they refuse `data-testid`, visible-text
 * selectors and raw query strings, so a naive scan of the raw file would flag
 * each explanation as the violation it forbids. `text` keeps the whole file
 * for the assertions that legitimately want it; `code` is what the shape
 * checks read.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES = collectSources(GUIDE_DIR).map(path => {
  const text = readFileSync(path, 'utf8');
  return {
    path: relative(GUIDE_DIR, path).replace(/\\/g, '/'),
    text,
    code: stripComments(text),
  };
});

const IMPORT_LINE = /^\s*import[\s\S]*?from\s+'([^']+)'/gm;

function importsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_LINE)) found.push(match[1]);
  return found;
}

describe('guide safety — the guide cannot reach a service', () => {
  it('finds the guide source it is meant to be guarding', () => {
    expect(SOURCES.length).toBeGreaterThan(5);
    expect(SOURCES.map(s => s.path)).toContain('GuideEngine.tsx');
    expect(SOURCES.map(s => s.path)).toContain('GuideTourOverlay.tsx');
  });

  it('imports nothing from the Supabase layer, directly or transitively by name', () => {
    for (const source of SOURCES) {
      for (const specifier of importsOf(source.code)) {
        expect(
          /supabase/i.test(specifier),
          `${source.path} imports "${specifier}"`,
        ).toBe(false);
        expect(
          /\.service$|\/services\//.test(specifier),
          `${source.path} imports the service "${specifier}"`,
        ).toBe(false);
      }
    }
  });

  it('contains no RPC, query or mutation call shape anywhere', () => {
    const forbidden: [RegExp, string][] = [
      [/\.rpc\s*\(/, 'an RPC call'],
      [/\.from\s*\(\s*'/, 'a table query'],
      [/\.insert\s*\(/, 'an insert'],
      [/\.update\s*\(/, 'an update'],
      [/\.upsert\s*\(/, 'an upsert'],
      [/\.delete\s*\(/, 'a delete'],
      [/\bfetch\s*\(/, 'a network fetch'],
      [/XMLHttpRequest/, 'an XHR'],
      [/navigator\.sendBeacon/, 'a beacon'],
      [/new WebSocket/, 'a socket'],
    ];
    for (const source of SOURCES) {
      for (const [pattern, label] of forbidden) {
        expect(pattern.test(source.code), `${source.path} contains ${label}`).toBe(false);
      }
    }
  });

  it('registers no submit handler and renders no form', () => {
    for (const source of SOURCES) {
      expect(/onSubmit/.test(source.code), `${source.path} has onSubmit`).toBe(false);
      expect(/<form/i.test(source.code), `${source.path} renders a form`).toBe(false);
      // A button inside the guide must never default to type="submit".
      const buttons = source.code.match(/<button(?![^>]*type=)/g) ?? [];
      expect(buttons, `${source.path} has an untyped <button>`).toEqual([]);
    }
  });

  it('sends nothing to an external destination', () => {
    for (const source of SOURCES) {
      expect(/https?:\/\//.test(source.code), `${source.path} names a URL`).toBe(false);
    }
  });
});

describe('guide safety — anchors are inert and language-neutral', () => {
  const anchorsSource = SOURCES.find(s => s.path === 'guide.anchors.ts');

  it('declares every anchor as a dotted, language-neutral id', () => {
    expect(anchorsSource).toBeDefined();
    const ids = Array.from((anchorsSource as { text: string }).text.matchAll(/'(guide\.[^']+)'/g))
      .map(match => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(id).toMatch(/^guide\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/);
      expect(/[؀-ۿ]/.test(id), `${id} carries Arabic`).toBe(false);
    }
  });

  it('never selects a target by visible text, test id or CSS class', () => {
    for (const source of SOURCES) {
      expect(/data-testid/.test(source.code), `${source.path} targets a test id`).toBe(false);
      expect(/getByText|textContent\s*===/.test(source.code), `${source.path} targets visible text`).toBe(false);
      // Selectors are built exclusively by guideAnchorSelector.
      const selectorCalls = source.code.match(/querySelector(?:All)?\s*\(\s*[`'"]/g) ?? [];
      expect(selectorCalls, `${source.path} builds a raw selector string`).toEqual([]);
    }
  });
});

describe('guide safety — persistence surface', () => {
  it('writes to exactly one storage key, and it is the declared guide key', () => {
    const keys = new Set<string>();
    for (const source of SOURCES) {
      for (const match of source.code.matchAll(/localStorage\.(?:setItem|getItem|removeItem)\(\s*([A-Za-z_]+)/g)) {
        keys.add(match[1]);
      }
    }
    expect(Array.from(keys)).toEqual(['GUIDE_PROGRESS_STORAGE_KEY']);
  });

  it('uses no session storage, cookies or IndexedDB', () => {
    for (const source of SOURCES) {
      expect(/sessionStorage/.test(source.code), `${source.path} uses sessionStorage`).toBe(false);
      expect(/document\.cookie/.test(source.code), `${source.path} uses cookies`).toBe(false);
      expect(/indexedDB/.test(source.code), `${source.path} uses IndexedDB`).toBe(false);
    }
  });
});

describe('guide performance boundary (AD-07)', () => {
  /**
   * The lazy boundary, asserted at the only place it can silently break: a
   * STATIC import of the engine or the registry from anywhere outside the
   * guide's own lazy graph would pull every tour into the shell's chunk, and
   * nothing about the running application would look different.
   *
   * The production build proves the outcome (the tour copy and the guide
   * stylesheet are emitted as their own chunks); this proves the cause, in a
   * test that costs nothing to run.
   */
  const SRC = join(__dirname, '..', '..', '..');

  function collectAllSources(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectAllSources(full));
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
    return files;
  }

  const LAZY_ONLY = ['GuideEngine', 'guide.registry', 'GuideTourOverlay', 'guide.css'];

  it('is reached from the application only through a dynamic import', () => {
    const offenders: string[] = [];
    for (const file of collectAllSources(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      // The guide's own lazy graph and its tests may import each other freely.
      if (rel.startsWith('features/guide/')) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of importsOf(code)) {
        if (LAZY_ONLY.some(name => specifier.includes(name))) {
          offenders.push(`${rel} statically imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the shell import only the tiny, copy-free host and anchor modules', () => {
    const allowed = new Set(['GuideHost', 'guide.anchors', 'GuideEntryButton']);
    const seen = new Set<string>();
    for (const file of collectAllSources(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('features/guide/')) continue;
      for (const specifier of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        const match = specifier.match(/features\/guide\/(.+)$/);
        if (match) seen.add(match[1]);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const module of seen) {
      expect(allowed.has(module), `the shell imports features/guide/${module}`).toBe(true);
    }
  });
});
