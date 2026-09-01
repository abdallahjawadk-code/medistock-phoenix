/**
 * @vitest-environment jsdom
 *
 * DispenseContextDialog — beneficiary-type field isolation (regression).
 *
 * THE DEFECT THIS FILE LOCKS OUT. Switching beneficiary type left the other
 * type's values in component state, and handleSubmit() forwarded every field
 * unconditionally. Typing a patient identifier, switching to `internal_order`,
 * and submitting therefore sent patient-only values alongside an
 * `internal_order` discriminator. The server refused the write — migration
 * 134's phoenix_movement_dispense_context_type_fields_chk keeps patient-only
 * columns NULL on an internal_order row, so no contradictory row could ever be
 * persisted (proved separately in
 * supabase/migrations/__tests__/134-dispense-context-beneficiary-field-exclusivity.dynamic.test.ts)
 * — but the operator was blocked from completing a legitimate recording by an
 * error the client does not map, and sensitive patient fields left the client
 * inside a request that had no need to carry them.
 *
 * Every one of these tests fails against the pre-repair component.
 *
 * PRIVACY: all values below are synthetic, obviously-not-real constants. No
 * patient value is printed by any assertion.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispenseContextDialog } from '../DispenseContextDialog';
import type { OutletMovementForContext } from '../dispense-context.service';

const svc = vi.hoisted(() => ({ recordDispenseContext: vi.fn() }));
vi.mock('../dispense-context.service', async () => {
  const actual = await vi.importActual<typeof import('../dispense-context.service')>('../dispense-context.service');
  return { ...actual, recordDispenseContext: svc.recordDispenseContext };
});

const SYNTH_MRN = 'SYNTHETIC-MRN-NOT-REAL';
const SYNTH_NAME = 'SYNTHETIC-NAME-NOT-REAL';
const SYNTH_ORDER = 'SYNTHETIC-ORDER-REF';

const MOVEMENT: OutletMovementForContext = {
  id: 'mv-iso-1', scientificName: 'Amoxicillin', batchNumber: 'B1', createdAt: '2026-08-01T00:00:00Z',
};

const LBL = {
  type: 'Beneficiary type',
  refType: 'Patient document *',
  mrn: 'Medical record number / identifier *',
  name: 'Patient name',
  order: 'Internal order reference *',
  notes: 'Notes (optional)',
};

function renderDialog(props: Partial<React.ComponentProps<typeof DispenseContextDialog>> = {}) {
  return render(
    <DispenseContextDialog
      open movement={MOVEMENT} lang="en" canRecord
      onClose={vi.fn()} onSuccess={vi.fn()} {...props}
    />,
  );
}

const setType = (v: 'patient' | 'internal_order') =>
  fireEvent.change(screen.getByLabelText(LBL.type), { target: { value: v } });

const ok = () => ({ ok: true, idempotentReplay: false, id: 'dc-1', beneficiaryType: 'patient' as const });

describe('DispenseContextDialog · beneficiary-type field isolation', () => {
  beforeEach(() => { svc.recordDispenseContext.mockReset().mockResolvedValue(ok()); });
  afterEach(cleanup);

  // ---- 1. Patient fields are cleared when switching to internal_order ----
  it('clears every patient field when switching away from patient', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    fireEvent.change(screen.getByLabelText(LBL.name), { target: { value: SYNTH_NAME } });

    setType('internal_order');
    setType('patient'); // come back and inspect the real state

    expect(screen.getByLabelText(LBL.mrn)).toHaveValue('');
    expect(screen.getByLabelText(LBL.name)).toHaveValue('');
    expect(screen.getByLabelText(LBL.refType)).toHaveValue('');
  });

  // ---- 2. Internal-order fields are cleared when switching to patient ----
  it('clears the internal-order reference when switching away from internal_order', () => {
    renderDialog();
    setType('internal_order');
    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });

    setType('patient');
    setType('internal_order'); // come back and inspect the real state

    expect(screen.getByLabelText(LBL.order)).toHaveValue('');
  });

  // ---- 3. Submission carries ONLY the active type's fields ----
  it('THE REGRESSION: a patient identifier typed before switching never reaches an internal_order submit', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    fireEvent.change(screen.getByLabelText(LBL.name), { target: { value: SYNTH_NAME } });

    setType('internal_order');
    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(svc.recordDispenseContext).toHaveBeenCalledTimes(1));
    const arg = svc.recordDispenseContext.mock.calls[0][0];
    expect(arg.beneficiaryType).toBe('internal_order');
    expect(arg.internalOrderReference).toBe(SYNTH_ORDER);
    expect(arg.patientIdentifier).toBeUndefined();
    expect(arg.patientName).toBeUndefined();
    expect(arg.patientReferenceType).toBeUndefined();
  });

  it('THE REGRESSION (reverse): an internal-order reference typed before switching never reaches a patient submit', async () => {
    renderDialog();
    setType('internal_order');
    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });

    setType('patient');
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(svc.recordDispenseContext).toHaveBeenCalledTimes(1));
    const arg = svc.recordDispenseContext.mock.calls[0][0];
    expect(arg.beneficiaryType).toBe('patient');
    expect(arg.patientIdentifier).toBe(SYNTH_MRN);
    expect(arg.internalOrderReference).toBeUndefined();
  });

  // ---- 4. Legitimate flows still succeed ----
  it('a valid patient recording still succeeds and carries its own fields', async () => {
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'card' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    fireEvent.change(screen.getByLabelText(LBL.name), { target: { value: SYNTH_NAME } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const arg = svc.recordDispenseContext.mock.calls[0][0];
    expect(arg).toMatchObject({
      beneficiaryType: 'patient',
      patientIdentifier: SYNTH_MRN,
      patientName: SYNTH_NAME,
      patientReferenceType: 'card',
    });
    expect(arg.internalOrderReference).toBeUndefined();
  });

  it('a valid internal_order recording still succeeds and carries its own field', async () => {
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });
    setType('internal_order');
    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(svc.recordDispenseContext.mock.calls[0][0]).toMatchObject({
      beneficiaryType: 'internal_order',
      internalOrderReference: SYNTH_ORDER,
    });
  });

  // ---- 5. Nothing else regressed ----
  it('shared notes survive a beneficiary-type switch (notes is not type-specific)', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.notes), { target: { value: 'shared note' } });
    setType('internal_order');
    expect(screen.getByLabelText(LBL.notes)).toHaveValue('shared note');

    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(svc.recordDispenseContext).toHaveBeenCalledTimes(1));
    expect(svc.recordDispenseContext.mock.calls[0][0].notes).toBe('shared note');
  });

  it('validation gating still holds after a switch: submit stays disabled until the new type is satisfied', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    // Switching wipes the patient fields, so the form must NOT stay submittable.
    setType('internal_order');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(LBL.order), { target: { value: SYNTH_ORDER } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('cancel still closes without any service call, and still resets the form', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(svc.recordDispenseContext).not.toHaveBeenCalled();
    expect(screen.getByLabelText(LBL.mrn)).toHaveValue('');
  });

  it('idempotency is preserved: a retry of the same failed attempt reuses its request id', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });

    svc.recordDispenseContext.mockRejectedValueOnce({ message: 'patient_identifier_or_name_required' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const first = svc.recordDispenseContext.mock.calls[0][0].requestId;

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(svc.recordDispenseContext).toHaveBeenCalledTimes(2));
    expect(svc.recordDispenseContext.mock.calls[1][0].requestId).toBe(first);
  });

  it('a conflict still mints a fresh request id for the next attempt', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(LBL.refType), { target: { value: 'chart' } });
    fireEvent.change(screen.getByLabelText(LBL.mrn), { target: { value: SYNTH_MRN } });

    svc.recordDispenseContext.mockRejectedValueOnce({ message: 'movement_id_conflict' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const first = svc.recordDispenseContext.mock.calls[0][0].requestId;

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(svc.recordDispenseContext).toHaveBeenCalledTimes(2));
    expect(svc.recordDispenseContext.mock.calls[1][0].requestId).not.toBe(first);
  });

  it('permission gating is unchanged: without canRecord the form is not rendered at all', () => {
    renderDialog({ canRecord: false });
    expect(screen.queryByLabelText(LBL.type)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(LBL.mrn)).not.toBeInTheDocument();
  });
});
