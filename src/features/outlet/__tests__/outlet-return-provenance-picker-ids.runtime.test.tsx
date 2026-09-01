/**
 * @vitest-environment jsdom
 *
 * OUTLET RETURN PROVENANCE PICKER — per-candidate field identity.
 *
 * THE DEFECT THIS FILE LOCKS OUT
 * (PHX-DEFECT-2026-09-02-OUTLET-RETURN-PROVENANCE-PICKER-LABEL-ID-COLLISION).
 * This picker renders a quantity input, a reason select and a conditional
 * reason-detail input for EVERY returnable candidate, through
 * `results.map(candidate => ...)` — its only real rendering shape. None of
 * those three fields passes an explicit `id`, so while `PhoenixInput` /
 * `PhoenixSelect` derived their id from label TEXT alone, every candidate's
 * reason select collided on `id="return-reason"`, every candidate's
 * reason-detail input on `id="reason-detail"`, and any two candidates whose
 * computed `safeReturnable()` cap happened to match collided on
 * `id="quantity-received-/-N"`.
 *
 * The three UAT controls held at FAIL for this component
 * (`:141:input#1`, `:148:select#1`, `:156:input#1` in ledger 496) are exactly
 * those three fields.
 *
 * Cases 1-4 fail against the pre-repair shared components. Cases 5-8 assert
 * behaviour the repair must NOT change — per-candidate state isolation, the
 * Add callback closing over its own candidate, and the four controls that were
 * already PASS — and hold before and after.
 *
 * `safeReturnable()`, `RETURN_REASON_CODES` and the expiry logic are the REAL
 * imported implementations, not mocks. `onAdd` is a plain callback prop
 * asserted with `vi.fn()`; this component has no service, RPC or database
 * boundary of any kind and none is claimed here. Every fixture value is
 * synthetic.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutletReturnProvenancePicker } from '../OutletReturnProvenancePicker';
import type { OutletReturnableLine } from '../outlet-return-draft';

const base: OutletReturnableLine = {
  dispatchLineId: 'dl-synth-a', scientificName: 'Synthetic Amoxicillin A', batchNumber: 'BATCH-SYNTH-A',
  expiryDate: null, unit: 'box', receivedQuantity: 10, returnedQuantity: 0, status: 'accepted',
  tradeName: null, concentration: null, dosageForm: null, nationalCode: null, internalBatchReference: null,
  dispatchNumber: 'DISP-SYNTH-A', dispatchSentAt: '2026-08-01T00:00:00Z',
};
// Deliberately EQUAL receivedQuantity -> equal computed cap -> identical
// quantity label text, which is what made the quantity ids collide.
const CANDIDATE_A: OutletReturnableLine = { ...base };
const CANDIDATE_B: OutletReturnableLine = {
  ...base, dispatchLineId: 'dl-synth-b', scientificName: 'Synthetic Paracetamol B',
  batchNumber: 'BATCH-SYNTH-B', dispatchNumber: 'DISP-SYNTH-B',
};
const CANDIDATE_C: OutletReturnableLine = {
  ...base, dispatchLineId: 'dl-synth-c', scientificName: 'Synthetic Ibuprofen C',
  batchNumber: 'BATCH-SYNTH-C', dispatchNumber: 'DISP-SYNTH-C',
};

function renderPicker(props: Partial<React.ComponentProps<typeof OutletReturnProvenancePicker>> = {}) {
  return render(
    <OutletReturnProvenancePicker
      lang="en"
      candidates={[CANDIDATE_A, CANDIDATE_B, CANDIDATE_C]}
      existingLines={[]}
      usedProvenanceIds={[]}
      onAdd={vi.fn()}
      {...props}
    />,
  );
}

/** The three candidate cards, in render order. */
const cards = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-testid="outlet-return-picker-results"] > .phoenix-card')] as HTMLElement[];

const duplicatesIn = (c: HTMLElement) => {
  const ids = [...c.querySelectorAll('[id]')].map(el => el.id);
  return [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
};

afterEach(cleanup);

describe('OutletReturnProvenancePicker · per-candidate field identity', () => {
  // ---- 1. quantity inputs (ledger control :141:input#1) ----
  it('gives every candidate its own quantity input id, even with identical computed caps', () => {
    const { container } = renderPicker();
    const qtyInputs = [...container.querySelectorAll('input[inputmode="numeric"]')] as HTMLInputElement[];
    expect(qtyInputs).toHaveLength(3);
    // All three labels read "Quantity received / 10" — identical text, distinct ids.
    expect(new Set(qtyInputs.map(i => i.id)).size).toBe(3);
    expect(screen.getAllByLabelText('Quantity received / 10')).toHaveLength(3);
  });

  // ---- 2. reason selects (ledger control :148:select#1) ----
  it('gives every candidate its own reason select id', () => {
    const { container } = renderPicker();
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    expect(selects).toHaveLength(3);
    expect(new Set(selects.map(s => s.id)).size).toBe(3);
    expect(screen.getAllByLabelText('Return reason')).toHaveLength(3);
  });

  // ---- 3. reason-detail inputs (ledger control :156:input#1) ----
  it('gives every simultaneously-visible reason-detail input its own id', () => {
    const { container } = renderPicker();
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    // Put ALL THREE candidates into the 'other' reason, revealing all three
    // conditional reason-detail inputs at once.
    selects.forEach(s => fireEvent.change(s, { target: { value: 'other' } }));

    const detailInputs = screen.getAllByLabelText('Reason detail') as HTMLInputElement[];
    expect(detailInputs).toHaveLength(3);
    expect(new Set(detailInputs.map(i => i.id)).size).toBe(3);
    expect(duplicatesIn(container)).toEqual([]);
  });

  // ---- 4. every label resolves inside its own candidate card ----
  it('keeps every label.control inside its own candidate card', () => {
    const { container } = renderPicker();
    [...container.querySelectorAll('select')].forEach(s =>
      fireEvent.change(s, { target: { value: 'other' } }));

    expect(duplicatesIn(container)).toEqual([]);

    for (const card of cards(container)) {
      const labels = [...card.querySelectorAll('label[for]')] as HTMLLabelElement[];
      expect(labels.length).toBeGreaterThanOrEqual(3); // quantity, reason, reason detail
      for (const label of labels) {
        const control = label.control as HTMLElement | null;
        expect(control, `label "${label.textContent}"`).not.toBeNull();
        expect(control!.id).toBe(label.htmlFor);
        expect(control!.closest('.phoenix-card')).toBe(card);
      }
    }
  });

  // ---- 5. editing one candidate must not disturb another ----
  it('keeps each candidate\'s typed state independent', () => {
    const { container } = renderPicker();
    const qtyInputs = [...container.querySelectorAll('input[inputmode="numeric"]')] as HTMLInputElement[];

    fireEvent.change(qtyInputs[1], { target: { value: '4' } });
    expect(qtyInputs[1]).toHaveValue('4');
    expect(qtyInputs[0]).toHaveValue('');
    expect(qtyInputs[2]).toHaveValue('');

    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    fireEvent.change(selects[2], { target: { value: 'damaged' } });
    expect(selects[2]).toHaveValue('damaged');
    expect(selects[0]).toHaveValue('excess'); // RETURN_REASON_CODES[0], untouched
    expect(selects[1]).toHaveValue('excess');
  });

  // ---- 6. the Add button still closes over its OWN candidate ----
  it('invokes onAdd with the candidate whose own Add button was pressed', () => {
    const onAdd = vi.fn();
    const { container } = renderPicker({ onAdd });
    const qtyInputs = [...container.querySelectorAll('input[inputmode="numeric"]')] as HTMLInputElement[];
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    expect(addButtons).toHaveLength(3);

    // Fill and submit the SECOND candidate only.
    fireEvent.change(qtyInputs[1], { target: { value: '3' } });
    expect(addButtons[1]).toBeEnabled();
    fireEvent.click(addButtons[1]);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(CANDIDATE_B, 3, 'excess', null);
    // Its own quantity resets; the siblings are untouched.
    expect(qtyInputs[1]).toHaveValue('');
    expect(qtyInputs[0]).toHaveValue('');
  });

  // ---- 7. the four already-PASS controls still behave (74/79/86/163) ----
  it('keeps the empty states, the search filter and the Add gating intact', () => {
    // 74 — no candidates at all.
    const empty = render(
      <OutletReturnProvenancePicker
        lang="en" candidates={[]} existingLines={[]} usedProvenanceIds={[]} onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText('No received materials are returnable from this depot')).toBeInTheDocument();
    empty.unmount();

    // 79 — the search box filters the list.
    const { container } = renderPicker();
    fireEvent.change(screen.getByLabelText('Search actually received materials'), {
      target: { value: 'BATCH-SYNTH-B' },
    });
    expect(screen.getByText('Synthetic Paracetamol B')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Amoxicillin A')).not.toBeInTheDocument();

    // 86 — a query matching nothing shows the generic hint.
    fireEvent.change(screen.getByLabelText('Search actually received materials'), {
      target: { value: 'no-such-material-xyz' },
    });
    expect(screen.getByText('Data will appear here once added')).toBeInTheDocument();

    // 163 — Add gating against the REAL safeReturnable() cap.
    fireEvent.change(screen.getByLabelText('Search actually received materials'), { target: { value: '' } });
    const qty = [...container.querySelectorAll('input[inputmode="numeric"]')][0] as HTMLInputElement;
    const add = screen.getAllByRole('button', { name: 'Add' })[0];
    expect(add).toBeDisabled();
    fireEvent.change(qty, { target: { value: '11' } });   // over the cap of 10
    expect(add).toBeDisabled();
    fireEvent.change(qty, { target: { value: '10' } });   // exactly the cap
    expect(add).toBeEnabled();
  });

  // ---- 8. the 'other' reason still gates Add on a non-empty detail ----
  it('still requires a trimmed reason detail when a candidate picks "other"', () => {
    const onAdd = vi.fn();
    const { container } = renderPicker({ onAdd });
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    const qtyInputs = [...container.querySelectorAll('input[inputmode="numeric"]')] as HTMLInputElement[];

    fireEvent.change(selects[0], { target: { value: 'other' } });
    fireEvent.change(qtyInputs[0], { target: { value: '2' } });
    const add = screen.getAllByRole('button', { name: 'Add' })[0];
    expect(add).toBeDisabled(); // detail still empty

    const detail = screen.getByLabelText('Reason detail');
    fireEvent.change(detail, { target: { value: '   ' } });
    expect(add).toBeDisabled(); // whitespace only

    fireEvent.change(detail, { target: { value: '  torn carton  ' } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith(CANDIDATE_A, 2, 'other', 'torn carton');
  });
});
