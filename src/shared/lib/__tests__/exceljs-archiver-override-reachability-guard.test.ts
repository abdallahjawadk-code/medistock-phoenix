/**
 * XLSX-SECURITY-FIX-EXCELJS-ARCHIVER-OVERRIDE — reachability guard.
 *
 * package.json's `overrides` block forces `exceljs > archiver` to 8.0.0 and
 * `exceljs > unzipper` to 0.12.5 (both semver-major, API-breaking jumps from
 * exceljs's own declared ^5.0.0 / ^10.0.11 ranges) to close npm audit's
 * brace-expansion/minimatch findings (GHSA-mh99-v99m-4gvg) to zero. This is
 * SAFE ONLY because this application never reaches the exceljs code paths
 * that use those two packages:
 *
 *   - `archiver` and `unzipper` are required exclusively by exceljs's
 *     STREAMING Workbook API (`ExcelJS.stream.xlsx.WorkbookWriter` /
 *     `WorkbookReader`, in exceljs's `lib/stream/xlsx/*.js`).
 *   - This repo's four real exceljs call sites (professional-export.ts,
 *     receipt-xlsx.ts, global-material-export.ts, and any future one) all
 *     use the BUFFER API instead (`new ExcelJS.Workbook()` +
 *     `wb.xlsx.writeBuffer()` / `wb.xlsx.load()`), implemented in exceljs's
 *     `lib/xlsx/xlsx.js`, which requires `jszip` directly and never touches
 *     archiver/unzipper at all — see
 *     src/shared/lib/__tests__/xlsx-security-fix-ooxml-roundtrip.test.ts for
 *     the round-trip proof that this path works correctly under the
 *     overridden versions.
 *
 * If any production source ever starts using the streaming API, or imports
 * `archiver`/`unzipper` directly, the override's safety argument breaks —
 * those packages' post-override versions have a genuinely different,
 * untested API (archiver 8's factory export changed from a callable
 * function to a `{ Archiver, ... }` object — see the commit that added
 * these overrides). This guard fails loudly the moment that happens, so
 * the override can't silently become unsafe.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

const SRC = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (['.ts', '.tsx'].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

const SRC_FILES = walk(SRC);
const rel = (p: string) => relative(PHOENIX, p).replace(/\\/g, '/');

/** Read a file with comments stripped, so documenting the prohibition (as this file itself does) never counts as violating it. */
function readCode(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Application source = everything that ships. This guard file itself is excluded (it names the forbidden patterns in its own doc comment/strings). */
const APP_FILES = SRC_FILES.filter(p => !p.endsWith('exceljs-archiver-override-reachability-guard.test.ts'));

describe('exceljs archiver/unzipper override safety: the streaming API stays unreachable', () => {
  it('no source file imports ExcelJS.stream / the streaming xlsx writer or reader', () => {
    const offenders = APP_FILES
      .filter(p => /\bstream\s*\.\s*xlsx\b|ExcelJS\s*\.\s*stream\b|exceljs\/lib\/stream/.test(readCode(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no source file references WorkbookWriter or WorkbookReader (the streaming classes that require archiver/unzipper)', () => {
    const offenders = APP_FILES
      .filter(p => /\bWorkbookWriter\b|\bWorkbookReader\b/.test(readCode(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no source file imports archiver or unzipper directly', () => {
    const offenders = APP_FILES
      .filter(p => /from\s+['"]archiver['"]|require\(\s*['"]archiver['"]\s*\)|from\s+['"]unzipper['"]|require\(\s*['"]unzipper['"]\s*\)/.test(readCode(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('every real exceljs call site uses the buffer API only (writeBuffer/load), never the streaming API', () => {
    const exceljsCallers = APP_FILES.filter(p => !rel(p).includes('__tests__') && /['"]exceljs['"]/.test(readCode(p)));
    // Sanity check the scan itself still finds the known real call sites — a
    // silently-broken scan (e.g. after a file move) must not read as "clean".
    expect(exceljsCallers.length).toBeGreaterThanOrEqual(3);
    for (const p of exceljsCallers) {
      const code = readCode(p);
      expect(code).not.toMatch(/\.stream\s*\.\s*xlsx/);
    }
  });

  it('package.json documents the archiver/unzipper overrides with their target versions', () => {
    const pkg = JSON.parse(readFileSync(join(PHOENIX, 'package.json'), 'utf8')) as {
      overrides?: { exceljs?: { archiver?: string; unzipper?: string } };
    };
    expect(pkg.overrides?.exceljs?.archiver).toBe('8.0.0');
    expect(pkg.overrides?.exceljs?.unzipper).toBe('0.12.5');
  });
});
