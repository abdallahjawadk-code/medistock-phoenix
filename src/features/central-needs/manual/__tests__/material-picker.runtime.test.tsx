/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MaterialPicker } from '../MaterialPicker';
import type { CatalogOption } from '../manual-journey.service';

afterEach(cleanup);

const amoxicillin: CatalogOption = { id: 'amox', name: 'Amoxicillin 500 mg', nameAr: null, nationalCode: '00021-A', concentration: '500 mg', dosageForm: 'Capsules', unit: 'box' };
const paracetamol: CatalogOption = { id: 'para', name: 'Paracetamol 500 mg', nameAr: null, nationalCode: '00022-B', concentration: '500 mg', dosageForm: 'Tablets', unit: 'box' };

function Selection({ search }: { search: (query: string) => Promise<CatalogOption[]> }) {
  const [selected, setSelected] = useState<CatalogOption[]>([]);
  return <MaterialPicker lang="en" scopeKey="org:revision" search={search} selected={selected}
    onPick={(item) => setSelected((current) => [...current, item])}
    onRemove={(id) => setSelected((current) => current.filter((item) => item.id !== id))} onRequestRegistration={() => undefined} />;
}

const searchFor = (query: string) => {
  fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};

describe('PRISM material selection', () => {
  it('preserves multiple selections across searches and removes only the selected material', async () => {
    const search = vi.fn(async (query: string) => query === 'amox' ? [amoxicillin] : [paracetamol]);
    render(<Selection search={search} />);
    searchFor('amox');
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    expect(screen.getByRole('button', { name: 'Selected' })).toBeDisabled();
    expect(screen.getByText('00021-A')).toHaveAttribute('dir', 'ltr');
    searchFor('para');
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    const selected = screen.getByRole('region', { name: 'Selected materials' });
    expect(within(selected).getByText('Amoxicillin 500 mg')).toBeInTheDocument();
    expect(within(selected).getByText('Paracetamol 500 mg')).toBeInTheDocument();
    fireEvent.click(within(selected).getByRole('button', { name: 'Remove Amoxicillin 500 mg' }));
    expect(within(selected).queryByText('Amoxicillin 500 mg')).toBeNull();
    expect(within(selected).getByText('Paracetamol 500 mg')).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not present previous search results while the next query is pending', async () => {
    let resolve!: (hits: CatalogOption[]) => void;
    const search = vi.fn<(query: string) => Promise<CatalogOption[]>>()
      .mockResolvedValueOnce([amoxicillin])
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<Selection search={search} />);
    searchFor('amox');
    await screen.findByRole('button', { name: 'Use' });
    searchFor('para');
    expect(screen.getByText('Searching registered materials…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
    await act(async () => resolve([paracetamol]));
    expect(await screen.findByText('Paracetamol 500 mg')).toBeInTheDocument();
    expect(screen.queryByText('Amoxicillin 500 mg')).toBeNull();
  });

  it('discards a late result when the organization or revision changes', async () => {
    let resolve!: (hits: CatalogOption[]) => void;
    const search = vi.fn(() => new Promise<CatalogOption[]>((done) => { resolve = done; }));
    const props = { lang: 'en' as const, search, selected: [], onPick: vi.fn(), onRemove: vi.fn(), onRequestRegistration: vi.fn() };
    const { rerender } = render(<MaterialPicker {...props} scopeKey="org:revision-1" />);
    searchFor('amox');
    rerender(<MaterialPicker {...props} scopeKey="org:revision-2" />);
    await act(async () => resolve([amoxicillin]));
    await waitFor(() => expect(screen.getByLabelText('Search a registered material')).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
    expect(props.onPick).not.toHaveBeenCalled();
  });
});
