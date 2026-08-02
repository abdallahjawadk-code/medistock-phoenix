/**
 * MOBILE-PWA-PRESENTATION-HOTFIX — contract tests for the four production
 * defects fixed by this hotfix:
 *   1. mobile scroll ownership + reachability of the final control;
 *   2. Welcome Phoenix composition (no amputated wings on portrait);
 *   3. ONE context-aware smart search controller;
 *   4. versioned app-icon references (covered in detail by
 *      auth-brand-icon-mobile-logout-passkey.test.ts).
 *
 * This repo renders no components in tests, so layout invariants are pinned
 * as source contracts (the live-browser measurements backing them are in
 * docs/phoenix/mobile-pwa-hotfix-evidence.md), while the search text logic is
 * tested behaviorally. Sources are newline-normalized for CRLF checkouts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeSearchText,
  findNormalizedMatch,
  normalizedIncludes,
} from '../../lib/search-normalize';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const nexusCss = read('shared/lib/phoenix-nexus.css');
const appShell = read('shared/ui/PhoenixAppShell.tsx');
const palette = read('shared/ui/CommandPalette.tsx');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// ─── 1. Mobile scroll ownership + reachability ───────────────────────────────

describe('the app shell has exactly one scroll owner and the final control is reachable', () => {
  it('the shell is a FIXED viewport frame (vh fallback + dvh), not min-height-grown', () => {
    const shellRule = nexusCss.slice(
      nexusCss.indexOf('.premium-shell.nexus-shell {'),
      nexusCss.indexOf('.premium-shell.nexus-shell::before'),
    );
    expect(shellRule).toContain('height: 100vh;');
    expect(shellRule).toContain('height: 100dvh;');
    expect(shellRule).toContain('overflow: clip;');
    // The regression this hotfix fixed: min-height alone let the document
    // become the scroller and the fixed bottom nav covered the content tail.
    expect(shellRule).not.toMatch(/min-height:\s*100dvh/);
  });

  it('the app column may shrink (min-height:0) so <main> actually scrolls', () => {
    const columnRule = nexusCss.slice(
      nexusCss.indexOf('.nexus-app-column {'),
      nexusCss.indexOf('.nexus-app-column::before'),
    );
    expect(columnRule).toContain('min-height: 0;');
  });

  it('<main> is the scroll owner: minHeight 0 + overflowY auto', () => {
    expect(appShell).toContain('minHeight: 0,');
    expect(appShell).toContain("overflowY: 'auto'");
  });

  it('mobile bottom padding clears nav + safe area, so the last card scrolls into view', () => {
    expect(appShell).toContain(
      "'calc(var(--bnh) + 14px + env(safe-area-inset-bottom, 0px))'",
    );
  });

  it('the shell ends with page content and no copyright footer or reserved block', () => {
    expect(appShell).toContain("<div style={{ flex: '1 0 auto', minWidth: 0 }}>{children}</div>");
    expect(appShell).not.toContain('MasarCopyrightSeal');
    expect(appShell).not.toContain('nexus-shell__brand');
    expect(nexusCss).not.toContain('.nexus-shell__brand');
    expect(nexusCss).not.toContain('.masar-seal');
  });

  it('the retired floating search leaves no overlay CSS or keyboard marker behind', () => {
    expect(nexusCss).not.toContain('premium-command-trigger');
    expect(nexusCss).not.toContain('html[data-keyboard="open"]');
    expect(appShell).not.toContain('window.visualViewport');
    expect(appShell).not.toContain("setAttribute('data-keyboard', 'open')");
  });

  it('the viewport meta exposes safe-area insets and keeps Android keyboard resizing honest', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).toContain('interactive-widget=resizes-content');
  });
});

// ─── 2. Welcome Phoenix composition ──────────────────────────────────────────

describe('the complete Phoenix survives every viewport', () => {
  const welcomeBlock = nexusCss.slice(nexusCss.indexOf('.nexus-welcome__plate {'));

  it('portrait/narrow viewports switch the plate to contain — nothing amputated', () => {
    expect(welcomeBlock).toContain('@media (max-aspect-ratio: 5/4)');
    const portrait = welcomeBlock.slice(welcomeBlock.indexOf('@media (max-aspect-ratio: 5/4)'));
    expect(portrait).toContain('object-fit: contain;');
  });

  it('wide viewports keep cover with the approved focal point', () => {
    const base = welcomeBlock.slice(0, welcomeBlock.indexOf('@media (max-aspect-ratio: 5/4)'));
    expect(base).toContain('object-fit: cover;');
    expect(base).toContain('object-position: center 44%;');
  });

  it('the experience scrolls rather than clipping credits on short viewports', () => {
    const welcomeRoot = nexusCss.slice(
      nexusCss.indexOf('.nexus-welcome {'),
      nexusCss.indexOf('.nexus-welcome__webgl'),
    );
    expect(welcomeRoot).toContain('min-height: 100dvh;');
    expect(welcomeRoot).toContain('overflow-y: auto;');
  });

  // PHASE-A-CLAUDE-A7.2: a later, separately-reviewed phase (Premium Living
  // Auth & Welcome) deliberately retires this photographic plate — the
  // reference board's own "no Phoenix bird as hero" contract — for an
  // original inline-SVG supply-network illustration. The historical concern
  // this test guarded (a mobile-portrait crop amputating part of the bird)
  // no longer applies to a vector illustration the same way; the STRONGER
  // replacement is InstitutionalSupplyMotif's own safe-band layout contract,
  // asserted directly against its source below.
  // PHASE-A-CLAUDE-A7.2.3: the A7.2/A7.2.2 vector illustrations were both
  // superseded by real photography served through <AuthSupplyHero>, and both
  // vector files were deleted. The hero is now legitimately an <img>, so the
  // old "contains no <img>" clause no longer expresses anything meaningful.
  // The invariant it actually existed to protect — the Welcome hero is never
  // fetched from off-origin at runtime — is asserted directly instead, which
  // is strictly stronger than a tag check.
  it('the Welcome hero is served from local build-hashed assets, never fetched at runtime', () => {
    const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');
    const scene = read('shared/ui/AuthSupplyHero.tsx');
    expect(welcome).toContain('AuthSupplyHero');
    expect(welcome).not.toContain('/assets/phoenix/runtime/phoenix-welcome-clean');
    expect(scene).not.toMatch(/https?:\/\//);
    expect(scene).not.toMatch(/data:image/);
    expect(scene).not.toMatch(/fetch\(|XMLHttpRequest/);
    // Sources arrive only as static imports Vite hashes into the bundle.
    expect(scene).toMatch(/import \w+ from '@\/assets\/auth-welcome\//);
  });
});

// ─── 3. Smart search — normalization + matching (behavioral) ─────────────────

describe('Arabic/English search normalization', () => {
  it('folds hamza seats, taa marbuta, final yaa and hamza carriers', () => {
    expect(normalizeSearchText('مُسْتَشْفَى')).toBe('مستشفي');
    expect(normalizeSearchText('أحمد')).toBe('احمد');
    expect(normalizeSearchText('إدارة')).toBe('اداره');
    expect(normalizeSearchText('مؤسسة')).toBe('موسسه');
  });

  it('strips harakat and tatweel so decorated names still match', () => {
    expect(normalizedIncludes('مستشفى الحِلَّة التعليمي', 'الحله')).toBe(true);
    expect(normalizedIncludes('الــمـسـتـودع', 'المستودع')).toBe(true);
  });

  it('matches English case-insensitively and codes/cities verbatim', () => {
    expect(normalizedIncludes('Al-Hilla Teaching Hospital', 'hilla')).toBe(true);
    expect(normalizedIncludes('babil-main', 'BABIL')).toBe(true);
    expect(normalizedIncludes('الحلة', 'حله')).toBe(true);
  });

  it('never matches on an empty or whitespace query', () => {
    expect(findNormalizedMatch('anything', '   ')).toBeNull();
  });

  it('maps the highlight range back to the ORIGINAL string, diacritics included', () => {
    const original = 'مستشفى الحِلَّة التعليمي';
    const match = findNormalizedMatch(original, 'الحله');
    expect(match).not.toBeNull();
    const highlighted = original.slice(match!.start, match!.end);
    // The highlighted slice is the decorated original text of the hit.
    expect(normalizeSearchText(highlighted)).toBe('الحله');
    expect(original.includes(highlighted)).toBe(true);
  });
});

describe('one keyboard search controller — never two competing surfaces', () => {
  it('the `/` shortcut routes to the local field when one exists, else the palette', () => {
    expect(palette).toContain("'.premium-main input[type=\"search\"], .premium-main [data-phoenix-local-search]'");
    const smartOpen = palette.slice(palette.indexOf('const smartOpen'), palette.indexOf('useEffect(() => {\n    function isTypingContext'));
    expect(smartOpen).toContain('findLocalSearchField()');
    expect(smartOpen).toContain('scrollIntoView');
    expect(smartOpen).toContain('focus({ preventScroll: true })');
    expect(smartOpen).toContain('return;'); // local field found -> NO palette
    expect(smartOpen).toContain('setOpen(true)');
    expect(palette).not.toContain('premium-command-trigger');
  });

  it('supports `/` (outside typing contexts) and Ctrl/Cmd+K, with Esc to close', () => {
    expect(palette).toContain("e.key === '/'");
    expect(palette).toContain('isTypingContext(e.target)');
    expect(palette).toContain("e.key.toLowerCase() === 'k'");
    expect(palette).toContain("e.key === 'Escape'");
  });

  it('institution matching is normalized over name/name_ar/code/city and debounced', () => {
    expect(palette).toContain('findNormalizedMatch');
    expect(palette).toContain('org.name_ar, org.name, org.code, org.city');
    expect(palette).toContain('setTimeout(() => setDebouncedQuery(query), 150)');
  });

  it('search reads only the RLS-scoped institution list, lazily, on open', () => {
    expect(palette).toContain('getOrganizations()');
    expect(palette).toContain('if (!open || orgs !== null) return;');
    // No direct table reads and no other service imports.
    expect(palette).not.toContain('supabase.');
    expect(palette).not.toMatch(/\.from\(['"]/);
  });

  it('offers clear button, result count and empty state', () => {
    expect(palette).toContain("t('cc_palette_clear', lang)");
    expect(palette).toContain("t('cc_palette_results', lang)");
    expect(palette).toContain("t('cc_palette_no_results', lang)");
    expect(palette).toContain('<Highlighted');
  });
});
