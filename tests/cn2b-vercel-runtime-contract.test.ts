import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Tsconfig {
  compilerOptions?: {
    allowImportingTsExtensions?: boolean;
    rewriteRelativeImportExtensions?: boolean;
    noEmit?: boolean;
  };
  references?: Array<{ path?: string }>;
}

interface VercelConfig {
  rewrites?: Array<{ source?: string; destination?: string }>;
}

const PUBLIC_ROUTES = [
  {
    publicPath: '/api/central-needs/upload-ticket',
    file: 'api/central-needs/upload-ticket.ts',
    core: '../_cn2b-core/upload-ticket.ts',
    coreFile: 'api/_cn2b-core/upload-ticket.ts',
    oldAdapter: 'api/cn2b-runtime/upload-ticket.ts',
  },
  {
    publicPath: '/api/central-needs/finalize-import',
    file: 'api/central-needs/finalize-import.ts',
    core: '../_cn2b-core/finalize-import.ts',
    coreFile: 'api/_cn2b-core/finalize-import.ts',
    oldAdapter: 'api/cn2b-runtime/finalize-import.ts',
  },
  {
    publicPath: '/api/central-needs/source-download',
    file: 'api/central-needs/source-download.ts',
    core: '../_cn2b-core/source-download.ts',
    coreFile: 'api/_cn2b-core/source-download.ts',
    oldAdapter: 'api/cn2b-runtime/source-download.ts',
  },
] as const;

describe('CN-2B Vercel TypeScript runtime contract', () => {
  it('rewrites relative TypeScript imports in the root and API compiler contexts', () => {
    const root = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8'),
    ) as Tsconfig;
    const api = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.api.json'), 'utf8'),
    ) as Tsconfig;

    for (const config of [root, api]) {
      expect(config.compilerOptions?.allowImportingTsExtensions).toBe(true);
      expect(config.compilerOptions?.rewriteRelativeImportExtensions).toBe(true);
      expect(config.compilerOptions?.noEmit).toBe(true);
    }
    expect(root.references?.map((reference) => reference.path)).toContain('./tsconfig.api.json');
  });

  it('makes the canonical public routes named POST functions and keeps business logic in helper modules', () => {
    for (const route of PUBLIC_ROUTES) {
      const source = readFileSync(resolve(process.cwd(), route.file), 'utf8');
      expect(source).toContain(`import handler from '${route.core}';`);
      expect(source).toContain('export async function POST(request: Request): Promise<Response>');
      expect(source).toContain('return handler(request);');
      expect(source).not.toContain('export default');

      const core = readFileSync(resolve(process.cwd(), route.coreFile), 'utf8');
      expect(core).toContain('export default async function handler(req: Request): Promise<Response>');
      expect(existsSync(resolve(process.cwd(), route.oldAdapter))).toBe(false);
    }
  });

  it('does not shadow canonical API files with rewrites', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
    ) as VercelConfig;
    const rewrites = new Map(
      (config.rewrites ?? []).map((rewrite) => [rewrite.source, rewrite.destination]),
    );

    for (const route of PUBLIC_ROUTES) {
      expect(rewrites.has(route.publicPath)).toBe(false);
    }
    expect(rewrites.get('/((?!api/).*)')).toBe('/index.html');
  });
});
