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
    expect(credits).toContain('<span>');
    expect(credits).not.toContain('<img');
    expect(credits).not.toContain('<canvas');
  });
});
