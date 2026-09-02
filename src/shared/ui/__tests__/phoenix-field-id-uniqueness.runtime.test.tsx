/**
 * @vitest-environment jsdom
 *
 * SHARED PHOENIX FIELD ID UNIQUENESS — the systemic regression lock.
 *
 * THE DEFECT THIS FILE LOCKS OUT.
 * `PhoenixInput` and `PhoenixSelect` both derived their DOM `id` from the
 * LABEL TEXT whenever no explicit `id` prop was supplied:
 *
 *     const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-') ?? generatedId;
 *
 * The `useId()` value in `generatedId` was unreachable while a label existed,
 * so any two instances sharing a label rendered the SAME id. That is invalid
 * HTML — an id must be unique in the tree — and it breaks label association for
 * every occurrence after the first: `getElementById`, the DOM `label.control`
 * property, and a screen reader activating a label all resolve to the FIRST
 * match in document order only.
 *
 * This is a SYSTEMIC risk, not a one-screen bug: at the time of this repair 127
 * of 128 `PhoenixInput` call sites and 52 of 56 `PhoenixSelect` call sites
 * relied on the implicit id, and ~32 files render these fields inside a
 * `.map()` — the exact shape that collides. Two separate UAT findings
 * (PHX-DEFECT-2026-09-01-EMERGENCY-REPLENISHMENT-DUPLICATE-SELECT-ID and
 * PHX-DEFECT-2026-09-02-OUTLET-RETURN-PROVENANCE-PICKER-LABEL-ID-COLLISION)
 * were both instances of it.
 *
 * Tests 1-3 and 7 fail against the pre-repair components. Tests 4-6 assert the
 * behaviour the repair must NOT change (explicit ids honoured verbatim, error
 * wiring intact, ids stable across rerender) and pass both before and after.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PhoenixInput } from '../PhoenixInput';
import { PhoenixSelect } from '../PhoenixSelect';

const OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

/** Every id present in the container, in document order. */
const idsIn = (c: HTMLElement) => [...c.querySelectorAll('[id]')].map(el => el.id);
const duplicatesIn = (c: HTMLElement) => {
  const ids = idsIn(c);
  return [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
};

afterEach(cleanup);

describe('PhoenixInput / PhoenixSelect · implicit id uniqueness', () => {
  // ---- 1. two PhoenixInput with the same label ----
  it('gives two PhoenixInput instances sharing a label different ids', () => {
    const { container } = render(
      <>
        <PhoenixInput label="Quantity" />
        <PhoenixInput label="Quantity" />
      </>,
    );
    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);
    expect(inputs[0].id).toBeTruthy();
    expect(duplicatesIn(container)).toEqual([]);
  });

  // ---- 2. two PhoenixSelect with the same label ----
  it('gives two PhoenixSelect instances sharing a label different ids', () => {
    const { container } = render(
      <>
        <PhoenixSelect label="Return reason" options={OPTIONS} />
        <PhoenixSelect label="Return reason" options={OPTIONS} />
      </>,
    );
    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(2);
    expect(selects[0].id).not.toBe(selects[1].id);
    expect(selects[0].id).toBeTruthy();
    expect(duplicatesIn(container)).toEqual([]);
  });

  // ---- 3. every label resolves to its own local control ----
  it('associates every label with its own control, across both components', () => {
    const { container } = render(
      <>
        <div data-testid="row-1">
          <PhoenixInput label="Quantity" defaultValue="one" />
          <PhoenixSelect label="Return reason" options={OPTIONS} />
        </div>
        <div data-testid="row-2">
          <PhoenixInput label="Quantity" defaultValue="two" />
          <PhoenixSelect label="Return reason" options={OPTIONS} />
        </div>
      </>,
    );

    const labels = [...container.querySelectorAll('label[for]')] as HTMLLabelElement[];
    expect(labels).toHaveLength(4);

    for (const label of labels) {
      // Exactly one control answers to this label's `for`.
      expect(container.querySelectorAll(`[id="${CSS.escape(label.htmlFor)}"]`)).toHaveLength(1);
      // `label.control` is what a browser and assistive tech actually use.
      const control = label.control as HTMLElement | null;
      expect(control, `label "${label.textContent}"`).not.toBeNull();
      expect(control!.id).toBe(label.htmlFor);
      // ...and it lives in the SAME row as its label, never the other one.
      expect(label.closest('[data-testid]')).toBe(control!.closest('[data-testid]'));
    }

    // Both rows are independently reachable by label.
    expect(screen.getAllByLabelText('Quantity')).toHaveLength(2);
    expect(screen.getAllByLabelText('Return reason')).toHaveLength(2);
  });

  // ---- 4. explicit ids are returned verbatim (backward compatibility) ----
  it('honours an explicit id exactly, unchanged, for both components', () => {
    const { container } = render(
      <>
        <PhoenixInput id="repl-qty" label="Quantity" />
        <PhoenixSelect id="repl-route" label="Route" options={OPTIONS} />
        <PhoenixSelect id="rev-route" label="Route" options={OPTIONS} />
      </>,
    );
    expect(container.querySelector('input')!.id).toBe('repl-qty');
    const selects = container.querySelectorAll('select');
    expect(selects[0].id).toBe('repl-route');
    expect(selects[1].id).toBe('rev-route');

    // The label points at the caller's exact id, and the caller's id is not
    // decorated, prefixed, or suffixed in any way.
    const labels = [...container.querySelectorAll('label[for]')] as HTMLLabelElement[];
    expect(labels.map(l => l.htmlFor)).toEqual(['repl-qty', 'repl-route', 'rev-route']);
    expect(duplicatesIn(container)).toEqual([]);
  });

  // ---- 5. error/description ids follow the SAME final id, per instance ----
  it('wires each error message to its own control, with unique error ids', () => {
    const { container } = render(
      <>
        <PhoenixInput label="Quantity" error="too many" />
        <PhoenixInput label="Quantity" error="too few" />
        <PhoenixSelect label="Return reason" options={OPTIONS} error="pick one" />
        <PhoenixSelect label="Return reason" options={OPTIONS} error="pick another" />
      </>,
    );

    for (const control of [...container.querySelectorAll('input, select')] as HTMLElement[]) {
      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy, `control #${control.id} should describe its error`).toBeTruthy();
      // The error id is derived from THIS control's final id...
      expect(describedBy).toBe(`${control.id}-error`);
      // ...and resolves to exactly one element, which is the error paragraph.
      const errorEl = container.querySelectorAll(`[id="${CSS.escape(describedBy!)}"]`);
      expect(errorEl).toHaveLength(1);
      expect(control.getAttribute('aria-invalid')).toBe('true');
    }
    expect(duplicatesIn(container)).toEqual([]);
  });

  // ---- 6. ids are stable across rerender ----
  it('keeps generated ids stable across a rerender', () => {
    const { container, rerender } = render(
      <>
        <PhoenixInput label="Quantity" value="a" onChange={() => {}} />
        <PhoenixSelect label="Return reason" options={OPTIONS} value="a" onChange={() => {}} />
      </>,
    );
    const before = idsIn(container);

    rerender(
      <>
        <PhoenixInput label="Quantity" value="b" onChange={() => {}} />
        <PhoenixSelect label="Return reason" options={OPTIONS} value="b" onChange={() => {}} />
      </>,
    );
    expect(idsIn(container)).toEqual(before);
  });

  // ---- 7. a mapped list — the real-world collision shape ----
  it('produces no duplicate id when the same field is rendered across a mapped list', () => {
    const rows = ['r1', 'r2', 'r3', 'r4'];
    const { container } = render(
      <>
        {rows.map(r => (
          <div key={r} data-row={r}>
            <PhoenixInput label="Quantity received / 10" />
            <PhoenixSelect label="Return reason" options={OPTIONS} />
            <PhoenixInput label="Reason detail" />
          </div>
        ))}
      </>,
    );

    expect(container.querySelectorAll('input')).toHaveLength(rows.length * 2);
    expect(container.querySelectorAll('select')).toHaveLength(rows.length);
    expect(duplicatesIn(container)).toEqual([]);

    // Each row's three labels resolve into that row, never a neighbour's.
    for (const row of [...container.querySelectorAll('[data-row]')] as HTMLElement[]) {
      const labels = [...row.querySelectorAll('label[for]')] as HTMLLabelElement[];
      expect(labels).toHaveLength(3);
      for (const label of labels) {
        expect((label.control as HTMLElement | null)?.closest('[data-row]')).toBe(row);
      }
    }
  });

  // ---- unlabelled fields keep working (the pre-existing useId path) ----
  it('still generates a unique id when no label is supplied at all', () => {
    const { container } = render(
      <>
        <PhoenixInput aria-label="bare one" />
        <PhoenixInput aria-label="bare two" />
      </>,
    );
    const inputs = container.querySelectorAll('input');
    expect(inputs[0].id).toBeTruthy();
    expect(inputs[0].id).not.toBe(inputs[1].id);
    expect(container.querySelectorAll('label')).toHaveLength(0);
  });
});
