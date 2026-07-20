import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const tokens = read('shared/lib/tokens.css');
const global = read('shared/lib/global.css');
const nexus = read('shared/lib/phoenix-nexus.css');
const topbar = read('shared/ui/PhoenixTopbar.tsx');
const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');

// W1 a11y closure — the interactive shell chrome (language + theme toggles,
// mobile menu/drawer-close, bottom nav, command trigger) must offer a ≥44px hit
// area, expose a real keyboard focus indicator, and never introduce horizontal
// overflow. These are source-scan contracts in the repo's established style.
describe('W1 shell — touch targets ≥44px', () => {
  it('defines a single 44px touch-target token', () => {
    expect(tokens).toMatch(/--touch-target:\s*44px/);
  });

  it('sizes every .nexus-control (language + theme toggles) to the token via logical props', () => {
    const block = nexus.slice(nexus.indexOf('.nexus-control {'));
    expect(block).toMatch(/min-inline-size:\s*var\(--touch-target\)/);
    expect(block).toMatch(/min-block-size:\s*var\(--touch-target\)/);
    // The old sub-44 hardcodes must be gone from the control base.
    const base = block.slice(0, block.indexOf('}'));
    expect(base).not.toMatch(/min-(width|height):\s*36px/);
  });

  it('drops the sub-44 inline overrides that used to shrink topbar controls', () => {
    // menu button was 42px, theme button was 36px — both now inherit the token.
    expect(topbar).not.toMatch(/width:\s*'42px'/);
    expect(topbar).not.toMatch(/width:\s*'36px'/);
    expect(topbar).not.toMatch(/height:\s*'36px'/);
  });

  it('grows the mobile drawer-close control to the touch-target token', () => {
    expect(drawer).toMatch(/minInlineSize:\s*'var\(--touch-target\)'/);
    expect(drawer).toMatch(/minBlockSize:\s*'var\(--touch-target\)'/);
    expect(drawer).not.toMatch(/width:\s*'34px'/);
  });

  it('keeps bottom-nav and command-trigger targets at ≥44px', () => {
    const bottomNav = read('shared/ui/PhoenixMobileBottomNav.tsx');
    const palette = read('shared/ui/CommandPalette.tsx');
    // The bottom nav now expresses the minimum through --touch-target (44px,
    // defined in tokens.css) instead of a repeated literal, and sizes its rows
    // taller than the minimum at 52px, as the design source does.
    expect(bottomNav).toMatch(/minWidth:\s*'var\(--touch-target\)'/);
    expect(bottomNav).toMatch(/minHeight:\s*'52px'/);
    expect(palette).toMatch(/minWidth:\s*'44px'/);
    expect(palette).toMatch(/minHeight:\s*'44px'/);
  });
});

describe('W1 shell — real keyboard focus-visible', () => {
  it('defines a two-tone focus ring with an accent outline and a contrasting halo', () => {
    const block = global.slice(global.indexOf(':focus-visible {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/outline:\s*3px solid var\(--focus-ring\)/);
    expect(rule).toMatch(/outline-offset:/);
    // Non-color cue: a contrasting halo (box-shadow) layered on the outline.
    expect(rule).toMatch(/box-shadow:.*var\(--focus-ring-contrast\)/);
  });

  it('gives the focus contrast tone a light↔dark flip (legible in both themes)', () => {
    expect(tokens).toMatch(/--focus-ring-contrast:/);
    const dark = tokens.slice(tokens.indexOf('[data-theme="dark"]'));
    expect(dark).toMatch(/--focus-ring-contrast:/);
  });

  it('carries the same ring onto the nexus-control focus state', () => {
    expect(nexus).toMatch(/\.nexus-control:focus-visible\s*\{/);
    const block = nexus.slice(nexus.indexOf('.nexus-control:focus-visible'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/outline:\s*3px solid var\(--focus-ring\)/);
    expect(rule).toMatch(/box-shadow:.*var\(--focus-ring-contrast\)/);
  });

  it('does not signal focus with hue alone (offset + halo are geometric cues)', () => {
    const block = global.slice(global.indexOf(':focus-visible {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/outline-offset:\s*2px/);
    expect(rule).toMatch(/box-shadow:/);
  });
});

describe('W1 shell — no horizontal overflow after the enlarged targets', () => {
  it('clips the shell so a wider control row cannot scroll the page sideways', () => {
    const block = nexus.slice(nexus.indexOf('.premium-shell.nexus-shell {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/overflow:\s*clip/);
  });

  it('lets the topbar title flex/shrink so the fixed-size controls never push width', () => {
    // title column is the flexible element; controls stay flexShrink:0 at 44px.
    expect(nexus).toMatch(/\.nexus-topbar-title\s*\{[^}]*min-width:\s*0/s);
    expect(nexus).toMatch(/\.nexus-topbar-title\s*\{[^}]*flex:\s*1/s);
    expect(topbar).toMatch(/flexShrink:\s*0/);
  });
});
