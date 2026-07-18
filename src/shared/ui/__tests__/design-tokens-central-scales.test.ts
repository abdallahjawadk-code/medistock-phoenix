import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const tokens = read('shared/lib/tokens.css');
const global = read('shared/lib/global.css');

// W1: tokens.css is the single canonical source for scale primitives
// (spacing, typography, motion, z-index). Cinematic accent colors stay in
// phoenix-nexus.css as the --nx-* extension layer.
describe('central design-token scales (W1)', () => {
  it('defines a spacing scale on a 4pt base', () => {
    for (const t of ['--sp-1', '--sp-2', '--sp-4', '--sp-6', '--sp-8', '--sp-12', '--sp-16'])
      expect(tokens).toContain(t);
  });

  it('defines a typography scale (family, size, weight, line-height)', () => {
    for (const t of ['--font-sans', '--font-ar', '--fs-base', '--fs-xl', '--fs-3xl',
                     '--fw-regular', '--fw-semibold', '--fw-bold', '--lh-tight', '--lh-relaxed'])
      expect(tokens).toContain(t);
  });

  it('defines a motion scale honoring the 150–400ms daily-interaction budget', () => {
    for (const t of ['--dur-fast', '--dur-base', '--dur-slow', '--ease-standard', '--ease-emphasized'])
      expect(tokens).toContain(t);
    expect(tokens).toContain('--dur-base: 250ms');
    expect(tokens).toContain('--dur-slow: 400ms');
  });

  it('defines a layered z-index scale (topbar < drawer < backdrop < modal < toast < tooltip)', () => {
    for (const t of ['--z-topbar', '--z-drawer', '--z-backdrop', '--z-modal', '--z-toast', '--z-tooltip'])
      expect(tokens).toContain(t);
  });

  it('wires base typography to the central family token (no scattered literal)', () => {
    expect(global).toContain('font-family: var(--font-sans)');
    expect(global).toContain('font-size: var(--fs-base)');
  });
});
