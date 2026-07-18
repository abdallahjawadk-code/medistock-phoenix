import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const globalCss = read('shared/lib/global.css');
const tokens = read('shared/lib/tokens.css');
const mainTsx = read('main.tsx');
const pkg = JSON.parse(read('../package.json')) as { dependencies?: Record<string, string> };

// W1: fonts must be self-hosted (no external CDN) so the production CSP
// (style-src 'self'; font-src 'self' data:) is satisfied.
describe('fonts are self-hosted (no external CDN)', () => {
  it('has no Google Fonts (or any external font) reference in CSS', () => {
    for (const css of [globalCss, tokens]) {
      expect(css).not.toMatch(/fonts\.googleapis\.com/);
      expect(css).not.toMatch(/fonts\.gstatic\.com/);
      expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/i);
    }
  });

  it('imports the self-hosted @fontsource-variable weight-axis CSS in main', () => {
    expect(mainTsx).toContain("@fontsource-variable/dm-sans/wght.css");
    expect(mainTsx).toContain("@fontsource-variable/noto-sans-arabic/wght.css");
  });

  it('declares the variable families as dependencies', () => {
    expect(pkg.dependencies?.['@fontsource-variable/dm-sans']).toBeTruthy();
    expect(pkg.dependencies?.['@fontsource-variable/noto-sans-arabic']).toBeTruthy();
  });

  it('points the central font tokens at the self-hosted variable families', () => {
    expect(tokens).toContain("'DM Sans Variable'");
    expect(tokens).toContain("'Noto Sans Arabic Variable'");
  });
});
