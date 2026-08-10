import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Security contract for local/deployment environment files.
 *
 * Vite/Vercel projects commonly use names such as .env.production,
 * .env.preview and .env.development. Those files can contain deployment
 * configuration or credentials and must never become commit candidates.
 * The repository template (.env.example) is intentionally retained.
 */

describe('environment secret ignore contract', () => {
  const lines = readFileSync(join(__dirname, '../.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());

  it('ignores every .env.* variant while keeping the documented template', () => {
    const envWildcard = lines.indexOf('.env.*');
    const exampleException = lines.indexOf('!.env.example');

    expect(envWildcard).toBeGreaterThanOrEqual(0);
    expect(exampleException).toBeGreaterThan(envWildcard);
  });

  it('keeps Vercel local metadata out of Git', () => {
    expect(lines).toContain('.vercel');
  });
});
