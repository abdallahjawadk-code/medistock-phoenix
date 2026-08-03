/**
 * @vitest-environment jsdom
 *
 * PHASE-C4-FOCUS-AND-MODAL-SAFETY — the mission's read-only audit of
 * PhoenixDialog (which MobilePrintFallbackModal is a straightforward
 * consumer of) found the whole Focus and Modal Safety contract ALREADY
 * correctly implemented: role="dialog" + aria-modal, title linked via
 * aria-labelledby, focus moved into the panel on open, Tab/Shift+Tab
 * trapped within it, Escape closes, and focus returned to whatever
 * triggered the open on close. Per the mission's explicit instruction, no
 * source change was made there — this file is the missing proof, through a
 * REAL consumer (MobilePrintFallbackModal), that the existing contract
 * actually holds at runtime; a source-scan alone would not catch a focus
 * trap or Escape-handling regression.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MobilePrintFallbackModal } from '../MobilePrintFallbackModal';

vi.mock('@/shared/lib/reportExport', () => ({
  downloadPrintableHtml: vi.fn(() => true),
  openPrintWindow: vi.fn(() => true),
  isLikelyMobilePrintContext: () => true,
}));

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open trigger</button>
      <MobilePrintFallbackModal
        open={open}
        html="<html><body>report</body></html>"
        title="Test Report"
        fileNameBase="test-report"
        lang="en"
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

describe('MobilePrintFallbackModal — dialog semantics (via PhoenixDialog, runtime proof)', () => {
  it('exposes role=dialog, aria-modal, and a title linked via aria-labelledby', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open trigger' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).not.toBeNull();
    expect(titleEl).toHaveTextContent('Mobile print options');
  });

  it('the Close button has a real accessible name', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open trigger' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('MobilePrintFallbackModal — focus management (via PhoenixDialog, runtime proof)', () => {
  it('moves focus into the dialog on open, landing on its first focusable control', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    fireEvent.click(trigger);

    await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Preview report' })));
  });

  it('returns focus to the trigger that opened it once the dialog closes', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab cycles forward from the last focusable control back to the first, never leaking focus to the page behind it', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open trigger' }));
    await screen.findByRole('dialog');

    const first = screen.getByRole('button', { name: 'Preview report' });
    const last = screen.getByRole('button', { name: 'Close' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable control wraps to the last, staying inside the dialog', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open trigger' }));
    await screen.findByRole('dialog');

    const first = screen.getByRole('button', { name: 'Preview report' });
    const last = screen.getByRole('button', { name: 'Close' });
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('MobilePrintFallbackModal — Escape closes and returns focus (via PhoenixDialog, runtime proof)', () => {
  it('Escape closes the dialog and returns focus to the trigger, matching the existing project-wide contract', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});
