import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const welcome = readFileSync(join(__dirname, '..', 'PhoenixWelcomeExperience.tsx'), 'utf8');

describe('Phoenix welcome copy contract', () => {
  it('keeps the exact approved issuer credit as live React text', () => {
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
  });

  // STAGE1-SUPERVISION-ATTRIBUTION-A: PHASE3-LIVING-INTERFACE-CREDIT-REMOVAL-A
  // had removed this line and this test guarded its ABSENCE. An explicit later
  // instruction reinstated it on the welcome/splash surface, so the assertion
  // is deliberately flipped back to guard its PRESENCE — verbatim.
  it('renders the exact supervision-credit line as live React text', () => {
    expect(welcome).toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).toContain('nexus-welcome__credits-sup');
    const credits = welcome.slice(welcome.indexOf('nexus-welcome__credits'));
    expect(credits).toMatch(/>\s*بإشراف الصيدلاني باسم كاظم رمح\s*</);
  });

  it('places the supervision line immediately BELOW the issuance line', () => {
    const issuance = welcome.indexOf('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
    const supervision = welcome.indexOf('بإشراف الصيدلاني باسم كاظم رمح');
    expect(issuance).toBeGreaterThan(-1);
    expect(supervision).toBeGreaterThan(issuance);
    // Nothing but the divider rule may sit between the two lines.
    const between = welcome.slice(issuance, supervision);
    expect(between).toContain('nexus-welcome__credits-rule');
    expect(between).not.toMatch(/nexus-welcome__credits-name[^]*nexus-welcome__credits-name/);
  });

  it('keeps the supervision line subordinate to, and RTL with, the issuance line', () => {
    // Both lines live inside the one dir="rtl" credits block, so the Arabic
    // renders right-to-left regardless of the active UI language.
    expect(welcome).toMatch(/className="nexus-welcome__credits"\s+dir="rtl"/);
    // Subordinate styling is carried by credits-sup, NOT by credits-name.
    expect(welcome).toMatch(/nexus-welcome__credits-sup">بإشراف الصيدلاني باسم كاظم رمح</);
    expect(welcome).not.toMatch(/nexus-welcome__credits-name">بإشراف/);
  });

  // The line is Arabic-only by the same convention as the issuance line above:
  // no i18n key, and therefore no invented English transliteration.
  it('does not invent an English transliteration for the supervision line', () => {
    expect(welcome).not.toContain('Under the supervision of Pharmacist Basim Kazim Ramh');
  });

  it('renders the supervision line exactly once', () => {
    expect(welcome.split('بإشراف الصيدلاني باسم كاظم رمح').length - 1).toBe(1);
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
