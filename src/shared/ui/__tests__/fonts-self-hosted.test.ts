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

  // The design source links both families from the Google Fonts CDN. We ship
  // the same families self-hosted instead, because the production CSP allows
  // font-src 'self' data: only. Inter has a variable build; IBM Plex Sans
  // Arabic does not, so its four design weights are imported statically.
  it('imports the self-hosted @fontsource CSS in main', () => {
    expect(mainTsx).toContain('@fontsource-variable/inter/wght.css');
    for (const w of [400, 500, 600, 700]) {
      expect(mainTsx).toContain(`@fontsource/ibm-plex-sans-arabic/arabic-${w}.css`);
      expect(mainTsx).toContain(`@fontsource/ibm-plex-sans-arabic/latin-${w}.css`);
    }
  });

  it('declares both families as dependencies', () => {
    expect(pkg.dependencies?.['@fontsource-variable/inter']).toBeTruthy();
    expect(pkg.dependencies?.['@fontsource/ibm-plex-sans-arabic']).toBeTruthy();
  });

  it('points the central font tokens at the self-hosted families', () => {
    expect(tokens).toContain("'Inter Variable'");
    expect(tokens).toContain("'IBM Plex Sans Arabic'");
  });
});
