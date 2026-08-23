import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

const globalCss = read('shared/lib/global.css');
const convergenceCss = read('shared/lib/phase-a-visual-convergence.css');
const signatureCss = read('shared/lib/phase-a-auth-welcome-signature.css');
const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');

const marker = 'MOBILE-DRAWER-PERFORMANCE-HOTFIX-A';
const mobileContract = signatureCss.slice(signatureCss.indexOf(marker));

function declarationBlock(source: string, selector: string): string {
  const selectorIndex = source.indexOf(selector);
  expect(selectorIndex).toBeGreaterThan(-1);
  const open = source.indexOf('{', selectorIndex);
  const close = source.indexOf('}', open);
  expect(open).toBeGreaterThan(selectorIndex);
  expect(close).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

describe('mobile drawer performance contract', () => {
  it('forbids live blur and filter rasterization on mobile drawer layers', () => {
    expect(signatureCss.indexOf(marker)).toBeGreaterThan(-1);
    expect(mobileContract).toMatch(/@media \(max-width: 767px\)/);

    const panel = declarationBlock(mobileContract, '.premium-mobile-drawer');
    expect(panel).toMatch(/-webkit-backdrop-filter:\s*none/);
    expect(panel).toMatch(/(?:^|\n)\s*backdrop-filter:\s*none/);
    expect(panel).toMatch(/(?:^|\n)\s*filter:\s*none/);
    expect(panel).toMatch(/will-change:\s*transform,\s*opacity/);

    const backdrop = declarationBlock(mobileContract, '.premium-drawer-backdrop');
    expect(backdrop).toMatch(/-webkit-backdrop-filter:\s*none/);
    expect(backdrop).toMatch(/(?:^|\n)\s*backdrop-filter:\s*none/);
  });

  it('disables fixed body background compositing at the mobile breakpoint', () => {
    const body = declarationBlock(mobileContract, 'body');
    expect(body).toMatch(/background-attachment:\s*scroll/);
  });

  it('keeps the opening keyframes limited to transform and opacity', () => {
    const start = globalCss.indexOf('@keyframes si');
    const end = globalCss.indexOf('@keyframes bp', start);
    const keyframes = globalCss.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(keyframes).toContain('@keyframes si-rtl');
    expect(keyframes).toMatch(/opacity:/);
    expect(keyframes).toMatch(/transform:\s*translateX/);
    expect(keyframes).not.toMatch(/(?:left|right|width|inset|margin|padding|background-position)\s*:/);
  });

  it('uses the navigation list as the single drawer scroll surface', () => {
    expect(drawer).toMatch(/className="premium-sidebar premium-dialog-panel premium-mobile-drawer"[\s\S]*overflowY:\s*'hidden'/);
    expect(drawer).toMatch(/className="premium-drawer-nav"[\s\S]*minHeight:\s*0[\s\S]*overflowY:\s*'auto'/);

    const nav = declarationBlock(mobileContract, '.premium-drawer-nav');
    expect(nav).toMatch(/overscroll-behavior:\s*contain/);
    expect(nav).toMatch(/-webkit-overflow-scrolling:\s*touch/);
  });

  it('retains the global reduced-motion contract', () => {
    expect(convergenceCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*1ms !important/);
  });
});
