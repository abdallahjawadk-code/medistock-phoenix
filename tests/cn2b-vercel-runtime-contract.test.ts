import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RootTsconfig {
  compilerOptions?: {
    allowImportingTsExtensions?: boolean;
    noEmit?: boolean;
  };
  references?: Array<{ path?: string }>;
}

describe('CN-2B Vercel TypeScript runtime contract', () => {
  it('keeps the root tsconfig compatible with Vercel function compilation', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8'),
    ) as RootTsconfig;

    expect(config.compilerOptions?.allowImportingTsExtensions).toBe(true);
    expect(config.compilerOptions?.noEmit).toBe(true);
    expect(config.references?.map((reference) => reference.path)).toContain('./tsconfig.api.json');
  });
});
