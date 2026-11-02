/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ gate: 'on', owner: 'owner-a', actor: 'actor-a', contract: vi.fn() }));
vi.mock('@/app/AppContext', () => ({ useApp: () => ({ lang: 'en', activeOrgId: state.owner, profile: { id: state.actor } }) }));
vi.mock('../manual/manual-needs-gate', () => ({ useManualNeedsTabGate: () => state.gate }));
vi.mock('../annual-catalog/annual-needs.service', () => ({ getAnnualNeedsContract: state.contract }));
vi.mock('../CentralNeedsScreen', () => ({ CentralNeedsScreen: () => <div data-testid="legacy-needs">Previous files<input aria-label="Legacy draft" /></div> }));
vi.mock('../manual/ManualNeedsTab', () => ({ ManualNeedsTab: () => <div data-testid="current-needs">Current annual entry</div> }));
import { AnnualNeedsEntryScreen } from '../AnnualNeedsEntryScreen';
beforeEach(() => { state.gate = 'on'; state.owner = 'owner-a'; state.actor = 'actor-a'; state.contract.mockReset().mockResolvedValue({ version: 1 }); });
afterEach(cleanup);
it('keeps the established screen when the manual gate is off without probing the new contract', () => {
  state.gate = 'off'; render(<AnnualNeedsEntryScreen />);
  expect(screen.getByTestId('legacy-needs')).toBeVisible(); expect(state.contract).not.toHaveBeenCalled();
});
it('waits for the gate without flashing the legacy screen', () => {
  state.gate = 'checking'; render(<AnnualNeedsEntryScreen />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking annual planning'); expect(screen.queryByTestId('legacy-needs')).toBeNull();
});
it('opens the actual annual journey and keeps it mounted while previous history is disclosed', async () => {
  render(<AnnualNeedsEntryScreen />); const current = await screen.findByTestId('current-needs');
  expect(screen.queryByTestId('legacy-needs')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show previous files and history' }));
  expect(screen.getByTestId('legacy-needs')).toBeVisible(); expect(screen.getByTestId('current-needs')).toBe(current);
  const legacy = screen.getByTestId('legacy-needs');
  fireEvent.change(screen.getByLabelText('Legacy draft'), { target: { value: 'Unsubmitted work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Hide previous files and history' }));
  expect(screen.getByTestId('legacy-needs')).toBe(legacy); expect(legacy).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Show previous files and history' }));
  expect(screen.getByTestId('legacy-needs')).toBe(legacy); expect(screen.getByLabelText('Legacy draft')).toHaveValue('Unsubmitted work');
  expect(screen.getByTestId('current-needs')).toBe(current);
});
it('explains exact contract absence while preserving the established screen', async () => {
  state.contract.mockResolvedValue(null); render(<AnnualNeedsEntryScreen />);
  expect(await screen.findByTestId('legacy-needs')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('New annual planning is awaiting activation in this environment');
});
it('shows contract failure explicitly and retries without silently falling back', async () => {
  state.contract.mockRejectedValueOnce(new Error('Denied')); render(<AnnualNeedsEntryScreen />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Annual planning could not be verified');
  expect(screen.queryByTestId('legacy-needs')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry annual planning' })); await screen.findByTestId('current-needs');
});
it('discards a late verified contract after the actor loses the gate', async () => {
  let resolve!: (value: unknown) => void; state.contract.mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<AnnualNeedsEntryScreen />); await waitFor(() => expect(state.contract).toHaveBeenCalledOnce());
  state.gate = 'off'; view.rerender(<AnnualNeedsEntryScreen />); await act(async () => resolve({ version: 1 }));
  expect(screen.getByTestId('legacy-needs')).toBeVisible(); expect(screen.queryByTestId('current-needs')).toBeNull();
});
