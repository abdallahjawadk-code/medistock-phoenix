import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const welcome = readFileSync(join(__dirname, '..', 'PhoenixWelcomeExperience.tsx'), 'utf8');

describe('Phoenix welcome copy contract', () => {
  it('keeps the exact approved issuer credit as live React text', () => {
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
  });

  // PHASE3-LIVING-INTERFACE-CREDIT-REMOVAL-A: the separate supervision-credit
  // line was intentionally removed from the welcome experience (a later,
  // explicit product decision) — this test now guards its ABSENCE instead of
  // its presence, and must never be flipped back without an equally explicit
  // instruction to reintroduce the credit.
  it('does not render the removed supervision-credit line', () => {
    expect(welcome).not.toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).not.toContain('Under the supervision of Pharmacist Basim Kazim Ramh');
    expect(welcome).not.toContain('nexus-welcome__credits-sup');
  });

  it('does not bake the remaining issuer credit into an image or canvas', () => {
    const credits = welcome.slice(welcome.indexOf('nexus-welcome__credits'));
    // The invariant is that the credit is LIVE, selectable React text — never
    // rasterised into an image, a canvas or a CSS background.
    // (The element tag itself is incidental; assert the text, not the tag.)
    expect(credits).toMatch(/>\s*تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم\s*</);
    expect(credits).not.toContain('<img');
    expect(credits).not.toContain('<canvas');
    expect(credits).not.toContain('background-image');
  });
});
