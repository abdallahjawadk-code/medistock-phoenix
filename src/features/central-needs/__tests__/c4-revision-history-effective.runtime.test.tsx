/** @vitest-environment jsdom */
/**
 * C4 — the "effective (approved)" mark in the lifecycle history is a DISPLAY
 * label only, and fails closed to "ambiguous" when the plan holds more than one
 * approved revision or the lifecycle refuses as ambiguous.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RevisionLifecycle } from '../central-needs.service';

const fetchRevisionLifecycle = vi.fn();
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return { ...actual, fetchRevisionLifecycle: (...a: unknown[]) => fetchRevisionLifecycle(...a) };
});
const { CentralNeedsRevisionHistory } = await import('../CentralNeedsRevisionHistory');
const { CentralNeedsError } = await import('../central-needs.service');
const { T } = await import('@/shared/i18n/strings');

afterEach(() => { cleanup(); fetchRevisionLifecycle.mockReset(); });

const lifecycle = (revisions: RevisionLifecycle['revisions'], effectiveRevisionId: string | null): RevisionLifecycle => ({
  planId: 'p', planYear: 2026, effectiveRevisionId, revisions, events: [],
});

async function show() {
  render(<CentralNeedsRevisionHistory lang="en" organizationId="org" planYear={2026} />);
  fireEvent.click(screen.getByRole('button', { name: T.cn2b_history_show.en }));
  return screen.findByTestId('cn4-effective-label');
}

describe('C4 — the effective label is display only and fails closed', () => {
  it('one approved revision: named as effective, "display only"', async () => {
    fetchRevisionLifecycle.mockResolvedValue(lifecycle([
      { id: 'r1', revisionNumber: 1, status: 'superseded', effective: false },
      { id: 'r2', revisionNumber: 2, status: 'approved', effective: true },
    ], 'r2'));
    const label = await show();
    expect(label).toHaveAttribute('data-effective', 'r2');
    expect(label).toHaveTextContent(T.cn4_effective_revision.en.replace('__N__', '2'));
  });

  it('two approved revisions: "ambiguous" and nothing marked — never the newest-first pick', async () => {
    fetchRevisionLifecycle.mockResolvedValue(lifecycle([
      { id: 'r1', revisionNumber: 1, status: 'approved', effective: true },
      { id: 'r2', revisionNumber: 2, status: 'approved', effective: true },
    ], 'r2'));
    const label = await show();
    expect(label).toHaveAttribute('data-effective', 'ambiguous');
    expect(label).toHaveTextContent(T.cn4_effective_ambiguous.en);
  });

  it('a lifecycle refusal as ambiguous: "ambiguous"', async () => {
    fetchRevisionLifecycle.mockRejectedValue(new CentralNeedsError('central_needs_lifecycle_state_ambiguous'));
    const label = await show();
    expect(label).toHaveAttribute('data-effective', 'ambiguous');
  });
});
