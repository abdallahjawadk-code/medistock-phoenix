import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

/**
 * SECURITY — open-redirect regression guard (react-router CVE-2025-68470 bypass /
 * GHSA-wrjc-x8rr-h8h6 / GHSA-337j-9hxr-rhxg / GHSA-jjmj-jmhj-qwj2).
 *
 * Those advisories describe open redirects reachable through react-router's
 * `<Link to=…>` / `useNavigate()` when the destination is built from
 * user-controlled input (query params, hash fragments, etc.) containing
 * patterns like `//evil.example`, `\\evil.example`, `/\evil.example`, or
 * `javascript:` URIs (including their URL-encoded forms).
 *
 * Investigation (2026-07-24): this app does not use react-router for routing
 * at all, so the unused react-router and react-router-dom dependencies were
 * removed instead of retained as an unnecessary attack surface. No source file
 * imports either package, and no `useNavigate`/`<Link to=`/`<Navigate to=` call
 * site exists anywhere in src/. The only redirect-adjacent browser APIs used
 * are `window.history.replaceState` (three call sites, all with a hardcoded
 * literal or `window.location.pathname` as the destination — never a value
 * derived from a query string, hash, or other user-controlled input) and
 * read-only parsing of `window.location.search` / `window.location.hash`
 * (never written back into a navigation target).
 *
 * This test pins that invariant so it fails loudly — instead of silently
 * regressing — if a future change introduces a dynamic/attacker-influenced
 * navigation target.
 */

const SRC = join(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '__mocks__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (['.ts', '.tsx'].includes(extname(entry)) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function readAll(files: string[]): { file: string; content: string }[] {
  return files.map((file) => ({ file, content: readFileSync(file, 'utf8') }));
}

const files = readAll(walk(SRC));

// The exact attack strings called out in the react-router open-redirect
// advisories, plus their URL-encoded equivalents.
const ATTACK_STRINGS = [
  '//evil.example',
  '\\\\evil.example',
  '/\\evil.example',
  'javascript:alert(1)',
  '%2F%2Fevil.example',
  '%5C%5Cevil.example',
  'javascript%3Aalert(1)',
];

describe('open-redirect guard: react-router / navigation surface', () => {
  it('does not carry unused react-router packages as an unnecessary attack surface', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    for (const dep of ['react-router', 'react-router-dom']) {
      expect(pkg.dependencies?.[dep], `${dep} is unused and must stay absent`).toBeUndefined();
      expect(pkg.devDependencies?.[dep], `${dep} is unused and must stay absent`).toBeUndefined();
    }
  });

  it('never imports from react-router / react-router-dom in application source', () => {
    // No route table exists in this app (state-based screen switching instead),
    // so there is no <Link>/useNavigate/<Navigate> surface to audit. If this
    // ever changes, the new call sites MUST be audited for open-redirect
    // exposure before this assertion is loosened.
    const offenders = files.filter(({ content }) =>
      /from\s+['"]react-router(-dom)?['"]/.test(content),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it('never calls useNavigate() / renders <Link to=/<Navigate to=', () => {
    const pattern = /\buseNavigate\s*\(|<Link\s+to=|<Navigate\s+to=/;
    const offenders = files.filter(({ content }) => pattern.test(content));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it('never writes an attacker-influenceable value to window.location.href/assign/replace', () => {
    const pattern = /location\.href\s*=|location\.assign\s*\(|location\.replace\s*\(/;
    const offenders = files.filter(({ content }) => pattern.test(content));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it('every window.history.replaceState/pushState call uses a hardcoded or same-origin-pathname target', () => {
    const callPattern = /window\.history\.(replaceState|pushState)\(([^)]*)\)/g;
    const calls: { file: string; args: string }[] = [];
    for (const { file, content } of files) {
      for (const match of content.matchAll(callPattern)) {
        calls.push({ file, args: match[2] });
      }
    }
    // Sanity check the scanner itself found the known call sites.
    expect(calls.length).toBeGreaterThan(0);
    for (const { file, args } of calls) {
      const safe = /window\.location\.pathname/.test(args) || /,\s*['"]\/[a-zA-Z0-9/_-]*['"]\s*\)?$/.test(`,${args.split(',').pop()})`);
      expect(safe, `${file}: history call target "${args}" is neither window.location.pathname nor a hardcoded literal path`).toBe(true);
      // Must never forward the raw query string or hash back into the URL.
      expect(args).not.toMatch(/window\.location\.search/);
      expect(args).not.toMatch(/window\.location\.hash/);
    }
  });

  it('documents that no navigation sink in this app is reachable with the CVE attack strings', () => {
    // There is no navigate()/Link sink in this codebase for these strings to
    // reach (proven above). This test exists so the attack strings are still
    // exercised against a same-origin-only guard shape, in case a navigation
    // sink is introduced later — copy this predicate into the new sink.
    function isSameOriginPath(target: string): boolean {
      if (!target.startsWith('/')) return false; // must be path-absolute
      if (target.startsWith('//')) return false; // protocol-relative
      if (target.includes('\\')) return false; // backslash tricks
      if (/^javascript:/i.test(target)) return false;
      try {
        const decoded = decodeURIComponent(target);
        if (decoded.startsWith('//') || decoded.includes('\\') || /^javascript:/i.test(decoded)) return false;
      } catch {
        return false;
      }
      return true;
    }

    for (const attack of ATTACK_STRINGS) {
      expect(isSameOriginPath(attack), `attack string "${attack}" must be rejected`).toBe(false);
    }
    // Legitimate internal paths must still pass.
    expect(isSameOriginPath('/dashboard')).toBe(true);
    expect(isSameOriginPath('/warehouse/dispatch')).toBe(true);
  });
});
