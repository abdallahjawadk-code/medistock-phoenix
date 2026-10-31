// @vitest-environment node
/**
 * GHSA-g3hv-75wg-m249: minimatch 11 changes matching internals and removes
 * several APIs. Exercise the installed consumers' real discovery/ignore paths,
 * including ESLint's partial-directory traversal and estree's default-project
 * boundary. These fixtures prove this application's dependency integration;
 * they are not a claim of equivalence for every minimatch 10 pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ESLint } from 'eslint';
import { clearCaches, parseAndGenerateServices } from '@typescript-eslint/typescript-estree';
import readdirGlob from 'readdir-glob';

const requireFromTest = createRequire(import.meta.url);
let fixture: string | undefined;

function writeFixture(files: Record<string, string>): string {
  const root = fixture!;
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'phoenix-minimatch-consumers-'));
});

afterEach(() => {
  clearCaches();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe('minimatch security update: installed consumer compatibility', () => {
  it('resolves the patched version from each actual consumer, including the nested estree override', () => {
    for (const consumer of [
      '@eslint/config-array',
      'eslint',
      '@typescript-eslint/typescript-estree',
      'readdir-glob',
    ]) {
      const consumerRequire = createRequire(requireFromTest.resolve(consumer));
      const metadata = JSON.parse(readFileSync(consumerRequire.resolve('minimatch/package.json'), 'utf8'));
      expect(metadata.version, consumer).toBe('11.0.3');
    }
  });

  it('ESLint traverses partial directory matches and config-array keeps exclusions effective', async () => {
    const root = writeFixture({
      'src/top.js': 'debugger;',
      'src/deep/المواد.mjs': 'debugger;',
      'src/deep/.hidden.js': 'debugger;',
      'src/deep/generated/ignored.js': 'debugger;',
      'src/deep/skip.test.js': 'debugger;',
      'src/deep/readme.txt': 'debugger;',
      'outside/unselected.js': 'debugger;',
    });
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        { ignores: ['**/generated/**', '**/*.test.js'] },
        { files: ['src/**/*.{js,mjs}'], rules: { 'no-debugger': 'error' } },
      ],
    });

    const results = await eslint.lintFiles(['src/**/*.{js,mjs}']);
    expect(results.map(result => relative(root, result.filePath).replace(/\\/g, '/')).sort()).toEqual([
      'src/deep/.hidden.js', 'src/deep/المواد.mjs', 'src/top.js',
    ].sort());
    for (const result of results) {
      expect(result.fatalErrorCount).toBe(0);
      expect(result.messages.map(message => message.ruleId)).toEqual(['no-debugger']);
    }
    expect(await eslint.isPathIgnored(join(root, 'src/deep/generated/ignored.js'))).toBe(true);
    expect(await eslint.isPathIgnored(join(root, 'src/deep/المواد.mjs'))).toBe(false);
  });

  it.each([false, true])('readdir-glob preserves globstar/braces/Arabic names and dot=%s', async dot => {
    const root = writeFixture({
      'root.csv': '',
      '2026/احتياج.xlsx': '',
      'deep/table.csv': '',
      '.secret.csv': '',
      'deep/.cache/مواد.xlsx': '',
      'deep/readme.txt': '',
      'ignored/omitted.xlsx': '',
      'skip/deep/omitted.csv': '',
    });
    const matches = await new Promise<string[]>((resolve, reject) => {
      readdirGlob(root, {
        pattern: '**/*.{xlsx,csv}', dot, nodir: true,
        ignore: 'ignored/**', skip: 'skip',
      }, (error, paths) => {
        if (error) reject(error);
        else resolve([...(paths ?? [])].sort());
      });
    });
    expect(matches).toEqual([
      'root.csv', '2026/احتياج.xlsx', 'deep/table.csv',
      ...(dot ? ['.secret.csv', 'deep/.cache/مواد.xlsx'] : []),
    ].sort());
  });

  it('estree allows a matched dotfile in its default project and rejects a deeper unmatched file', () => {
    const source = 'export const count = 1;';
    const root = writeFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true, noLib: true, types: [] },
        include: ['src/**/*.ts'],
        typeAcquisition: { enable: false },
      }),
      'src/included.ts': 'export {};',
      'config/.allowed.mjs': source,
      'config/deeper/rejected.mjs': source,
    });
    const options = {
      tsconfigRootDir: root,
      projectService: { allowDefaultProject: ['config/*.mjs'], defaultProject: 'tsconfig.json' },
    };
    const allowed = join(root, 'config/.allowed.mjs');
    const result = parseAndGenerateServices(source, { ...options, filePath: allowed });
    expect(result.ast.body).toHaveLength(1);
    expect(result.services.program?.getSourceFile(allowed)?.text).toBe(source);
    expect(() => parseAndGenerateServices(source, {
      ...options, filePath: join(root, 'config/deeper/rejected.mjs'),
    })).toThrow(/allowDefaultProject[\s\S]*does not match/);
  });
});
