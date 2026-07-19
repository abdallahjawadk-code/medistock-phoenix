import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const login = read('src/features/auth/LoginScreen.tsx');
const welcome = read('src/features/auth/PhoenixWelcomeExperience.tsx');
const css = read('src/shared/lib/phoenix-nexus.css');

describe('Phoenix cinematic hero runtime', () => {
  it('uses optimized AVIF with WebP fallback on the login gateway', () => {
    expect(login).toContain('phoenix-login.avif');
    expect(login).toContain('phoenix-login.webp');
    expect(login).toContain('type="image/avif"');
    expect(login).toContain('type="image/webp"');
    expect(login).toContain('nexus-login__hero-media');
  });

  it('uses the text-free clean plate for welcome and never the baked keyframe', () => {
    expect(welcome).toContain('phoenix-welcome-clean.avif');
    expect(welcome).toContain('phoenix-welcome-clean.webp');
    expect(welcome).not.toContain('keyframe');
    expect(welcome).not.toContain('phoenix-welcome-rebirth-keyframe');
  });

  it('keeps titles and credits as accessible live text', () => {
    expect(welcome).toContain('role="dialog"');
    expect(welcome).toContain('aria-modal="true"');
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
    expect(welcome).toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).toContain('onClick={finish}');
  });

  it('marks cinematic media decorative and dimensioned to avoid layout shift', () => {
    expect(login).toContain('aria-hidden="true"');
    expect(login).toContain('width="1672"');
    expect(login).toContain('height="941"');
    expect(welcome).toContain('aria-hidden="true"');
    expect(welcome).toContain('width="1672"');
    expect(welcome).toContain('height="941"');
  });

  it('keeps every runtime derivative below the 600KB performance budget', () => {
    const files = [
      'public/assets/phoenix/runtime/phoenix-login.avif',
      'public/assets/phoenix/runtime/phoenix-login.webp',
      'public/assets/phoenix/runtime/phoenix-welcome-clean.avif',
      'public/assets/phoenix/runtime/phoenix-welcome-clean.webp',
    ];
    for (const file of files) {
      expect(statSync(join(ROOT, file)).size, file).toBeLessThanOrEqual(600 * 1024);
    }
  });

  it('provides responsive, mobile and reduced-motion styling', () => {
    expect(css).toContain('.nexus-login__hero-media');
    expect(css).toContain('.nexus-welcome__phoenix-media');
    expect(css).toContain('@media (max-width: 940px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.nexus-login__hero-media img { animation: none !important;');
  });
});
