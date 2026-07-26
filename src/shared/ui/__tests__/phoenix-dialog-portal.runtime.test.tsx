/**
 * @vitest-environment jsdom
 *
 * PHOENIX-DIALOG-PORTAL-STACKING-FIX — regression test.
 *
 * A real authenticated E2E session found this live: opening
 * DispenseComposerDialog (one of PhoenixDialog's 22 real consumers) within
 * ~0.4s of the underlying screen re-rendering put the page's own copyright
 * <footer class="nexus-shell__brand"> ahead of the dialog's submit button
 * in pointer-event hit-testing, even though the dialog declares
 * `z-index: 300`. Root cause: `.premium-main`'s entrance animation
 * (nexus-page-enter, animating opacity/transform/filter — each of which
 * independently forces a new CSS stacking context per spec) transiently
 * isolates EACH of `.premium-main`'s direct children into its own stacking
 * context for the animation's duration. A dialog rendered INLINE inside
 * one of those children has its z-index scoped to that temporary,
 * isolated context — it can never out-rank a LATER SIBLING of that
 * ancestor (like the footer) via z-index, because that comparison never
 * reaches the document root while the animation is active.
 *
 * The fix (PhoenixDialog.tsx): render via createPortal to document.body,
 * removing the dialog from that DOM subtree entirely, so its stacking can
 * never again be subject to any ancestor's transient stacking context.
 * This test proves the structural property the fix depends on — the
 * dialog's DOM node is NOT a descendant of wherever it's rendered from —
 * which a component-tree assertion (React Testing Library's default
 * render container) cannot see, but querying document.body can.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { PhoenixDialog } from '../PhoenixDialog';

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="host-subtree">
      <PhoenixDialog open={open} onClose={() => setOpen(false)} title="Test Dialog">
        <button type="button">Confirm dispense</button>
      </PhoenixDialog>
    </div>
  );
}

describe('PhoenixDialog renders via a portal to document.body, not inline in its host subtree', () => {
  it('the dialog panel is NOT a descendant of the component that rendered it', () => {
    const { container } = render(<Harness />);
    const hostSubtree = container.querySelector('[data-testid="host-subtree"]');
    expect(hostSubtree).not.toBeNull();

    // The whole point of the fix: nothing dialog-related lives inside the
    // host subtree anymore — it was rendered straight to document.body.
    expect(hostSubtree?.querySelector('[role="dialog"]')).toBeNull();
    expect(hostSubtree?.textContent).not.toContain('Confirm dispense');
  });

  it('the dialog panel IS present as a direct-to-body portal target, reachable via document.body', () => {
    render(<Harness />);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Confirms it's outside React Testing Library's own render container
    // (a wrapper div RTL itself appends to document.body) — the portal
    // target is document.body directly, a sibling of that render
    // container, not nested inside it.
    expect(dialog?.closest('[data-testid="host-subtree"]')).toBeNull();
  });

  it('dialog content (a real consumer control) is queryable via screen, proving it still renders and is interactive', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Confirm dispense' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closing the dialog removes it from document.body entirely (no orphaned portal node left behind)', () => {
    render(<Harness />);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // PhoenixDialog has no built-in close button — its overlay's own
    // backdrop div (the dialog's first child) is what invokes onClose.
    const backdrop = dialog!.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
