import { readFileSync } from 'node:fs';
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

const RUNTIME_ADAPTERS = [
  {
    publicPath: '/api/central-needs/upload-ticket',
    destination: '/api/cn2b-runtime/upload-ticket',
    file: 'api/cn2b-runtime/upload-ticket.ts',
    canonical: '../central-needs/upload-ticket.ts',
  },
  {
    publicPath: '/api/central-needs/finalize-import',
    destination: '/api/cn2b-runtime/finalize-import',
    file: 'api/cn2b-runtime/finalize-import.ts',
    canonical: '../central-needs/finalize-import.ts',
  },
  {
    publicPath: '/api/central-needs/source-download',
    destination: '/api/cn2b-runtime/source-download',
    file: 'api/cn2b-runtime/source-download.ts',
    canonical: '../central-needs/source-download.ts',
  },
] as const;

describe('CN-2B Vercel TypeScript runtime contract', () => {
  it('rewrites relative TypeScript import extensions for Vercel emitted functions', () => {
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

  it('routes every public CN-2B endpoint through a supported named POST adapter', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
    ) as VercelConfig;
    const rewrites = new Map(
      (config.rewrites ?? []).map((rewrite) => [rewrite.source, rewrite.destination]),
    );

    for (const adapter of RUNTIME_ADAPTERS) {
      expect(rewrites.get(adapter.publicPath)).toBe(adapter.destination);

      const source = readFileSync(resolve(process.cwd(), adapter.file), 'utf8');
      expect(source).toContain(`import handler from '${adapter.canonical}';`);
      expect(source).toContain('export async function POST(request: Request): Promise<Response>');
      expect(source).toContain('return handler(request);');
      expect(source).not.toContain('export default { fetch: handler };');
      expect(source).not.toContain('export default async function');
    }
  });
});
