import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const welcome = readFileSync(join(__dirname, '..', 'PhoenixWelcomeExperience.tsx'), 'utf8');

describe('Phoenix welcome copy contract', () => {
  it('keeps the exact approved issuer credit as live React text', () => {
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
  });

  it('uses the correct supervision spelling and approved full name', () => {
    expect(welcome).toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).not.toContain('بأشراف');
  });

  it('does not bake either Arabic credit into an image or canvas', () => {
    const credits = welcome.slice(welcome.indexOf('nexus-welcome__credits'));
    // The invariant is that both credits are LIVE, selectable React text
    // nodes — never rasterised into an image, a canvas or a CSS background.
    // (The element tag itself is incidental; assert the text, not the tag.)
    expect(credits).toMatch(/>\s*تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم\s*</);
    expect(credits).toMatch(/>\s*بإشراف الصيدلاني باسم كاظم رمح\s*</);
    expect(credits).not.toContain('<img');
    expect(credits).not.toContain('<canvas');
    expect(credits).not.toContain('background-image');
  });
});
