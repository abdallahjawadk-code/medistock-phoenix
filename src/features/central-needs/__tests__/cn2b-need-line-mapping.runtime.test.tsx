/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';

/**
 * CN-2B CONFORMANCE (M212) — the operational need-line mapping surface.
 *
 * Covers what only a rendered component can prove: both languages, RTL/LTR, the
 * mandatory reason, zero-is-not-blank, and that a bulk apply previews its exact
 * reach and then asks a second time before writing anything.
 *
 * The service module is mocked at the boundary, so these tests assert the
 * COMPONENT's behaviour. The server contract itself is proven against a real
 * PostgreSQL in supabase/migrations/__tests__/212-*.dynamic.test.ts — a mocked
 * RPC could never prove authorization or a CHECK.
 */

const setNeedLine = vi.fn();
const searchCentralItems = vi.fn();
const getOrganizations = vi.fn();
const getWarehouses = vi.fn();

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: (...a: unknown[]) => getOrganizations(...a),
}));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getWarehouses: (...a: unknown[]) => getWarehouses(...a),
}));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    setNeedLine: (...a: unknown[]) => setNeedLine(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
  };
});

const { CentralNeedsNeedLinePanel } = await import('../CentralNeedsNeedLinePanel');

const BENE = '00000000-0000-0000-0000-0000000000b1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';

const disposition = (entity: string) => ({
  id: `d-${entity}`, importSessionId: 's1', targetEntity: entity,
  decision: 'mapped' as const, centralItemId: ITEM, decisionReason: null,
  decidedAt: '2026-01-01T00:00:00.000Z',
});

type PanelProps = Parameters<typeof CentralNeedsNeedLinePanel>[0];

function renderPanel(lang: 'ar' | 'en', over: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    lang,
    planRevisionId: 'rev-1',
    editable: true,
    dispositions: [disposition('sheet:0:row:5'), disposition('sheet:0:row:6')],
    needLines: [],
    claimedSources: [],
    onSaved: () => {},
    ...over,
  };
  return render(<CentralNeedsNeedLinePanel {...props} />);
}

/** Fill the form to the point where the commit path is reachable. */
async function fillValid(quantity = '120.5', reason = 'reviewer designated the final block') {
  // The institution list loads asynchronously; a select cannot hold a value
  // whose <option> has not rendered yet.
  const beneSelect = await screen.findByLabelText(T.cn2b_nl_beneficiary.en);
  await waitFor(() => expect(beneSelect.querySelector(`option[value="${BENE}"]`)).not.toBeNull());
  fireEvent.change(beneSelect, { target: { value: BENE } });
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_item_search.en), { target: { value: 'para' } });
  await waitFor(() => expect(searchCentralItems).toHaveBeenCalled());
  const itemSelect = screen.getByLabelText(T.cn2b_nl_item.en);
  await waitFor(() => expect(itemSelect.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(itemSelect, { target: { value: ITEM } });
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_quantity.en), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText(T.cn2b_nl_reason.en), { target: { value: reason } });
  // Prove the form actually holds what we typed before any commit assertion.
  expect((screen.getByLabelText(T.cn2b_nl_beneficiary.en) as HTMLSelectElement).value).toBe(BENE);
  expect((screen.getByLabelText(T.cn2b_nl_item.en) as HTMLSelectElement).value).toBe(ITEM);
  expect((screen.getByLabelText(T.cn2b_nl_quantity.en) as HTMLInputElement).value).toBe(quantity);
}

beforeEach(() => {
  setNeedLine.mockReset().mockResolvedValue({ needLineId: 'nl-1', sourceLinkCount: 1 });
  searchCentralItems.mockReset().mockResolvedValue([{ id: ITEM, name: 'Paracetamol 500mg' }]);
  getOrganizations.mockReset().mockResolvedValue([
    { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
    { id: 'x1', name: 'Authority', name_ar: 'سلطة', code: 'a1', status: 'active', organizationKind: 'pharmacy_department_authority' },
    { id: 'x2', name: 'Inactive Hospital', name_ar: 'معطل', code: 'i1', status: 'inactive', organizationKind: 'care_institution' },
  ]);
  getWarehouses.mockReset().mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('M212 need-line panel — bilingual surface', () => {
  it('renders Arabic copy and never leaks the English label into it', async () => {
    renderPanel('ar');
    expect(await screen.findByText(T.cn2b_nl_title.ar)).toBeInTheDocument();
    expect(screen.getByText(T.cn2b_nl_subtitle.ar)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_nl_title.en)).not.toBeInTheDocument();
  });

  it('renders English copy', async () => {
    renderPanel('en');
    expect(await screen.findByText(T.cn2b_nl_title.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_nl_title.ar)).not.toBeInTheDocument();
  });

  it('carries an Arabic and an English string for every new need-line key', () => {
    const keys = Object.keys(T).filter((k) => k.startsWith('cn2b_nl_') || k.startsWith('cn2b_blocker_need_line') || k === 'cn2b_panel_need_lines' || k === 'cn2b_blocker_mapped_target_entity_without_need_line');
    expect(keys.length).toBeGreaterThanOrEqual(25);
    for (const k of keys) {
      const e = T[k as keyof typeof T];
      expect(e.ar.trim(), `${k}.ar`).not.toBe('');
      expect(e.en.trim(), `${k}.en`).not.toBe('');
      // Arabic copy must actually be Arabic, never the English string reused.
      expect(/[؀-ۿ]/.test(e.ar), `${k}.ar is Arabic`).toBe(true);
      expect(e.ar, `${k} ar/en distinct`).not.toBe(e.en);
    }
  });

  it('offers only live care institutions as a beneficiary', async () => {
    renderPanel('en');
    const select = await screen.findByLabelText(T.cn2b_nl_beneficiary.en);
    await waitFor(() => expect(select.querySelectorAll('option').length).toBe(2)); // placeholder + 1
    expect(select.textContent).toContain('Beneficiary Hospital');
    expect(select.textContent).not.toContain('Authority');
    expect(select.textContent).not.toContain('Inactive Hospital');
  });
});

describe('M212 need-line panel — mandatory reason and blank-vs-zero', () => {
  it('shows the reason requirement and blocks commit without one', async () => {
    renderPanel('en');
    await fillValid('10', '');
    expect(screen.getByText(T.cn2b_nl_reason_required.en)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: T.cn2b_nl_save.en });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('treats zero as a valid quantity', async () => {
    renderPanel('en');
    await fillValid('0');
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeEnabled();
  });

  it('treats blank as NOT zero — commit stays unreachable', async () => {
    renderPanel('en');
    await fillValid('');
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
    expect(setNeedLine).not.toHaveBeenCalled();
  });

  it('refuses a negative quantity client-side too', async () => {
    renderPanel('en');
    await fillValid('-5');
    expect(screen.getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
  });

  it('sends the quantity as an exact string, never a float', async () => {
    renderPanel('en');
    await fillValid('120.125');
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(await screen.findByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const payload = setNeedLine.mock.calls[0][0] as { approvedQuantity: unknown };
    expect(payload.approvedQuantity).toBe('120.125');
    expect(typeof payload.approvedQuantity).toBe('string');
  });
});

describe('M212 need-line panel — bulk apply previews then asks again', () => {
  it('shows the exact affected row count and writes nothing until confirmed', async () => {
    renderPanel('en');
    await fillValid();
    // Select both unclaimed rows.
    for (const entity of ['sheet:0:row:5', 'sheet:0:row:6']) {
      fireEvent.click(screen.getByLabelText(entity, { exact: false }));
    }
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_preview.en }));

    const preview = await screen.findByTestId('cn2b-nl-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-nl-affected')).toHaveTextContent('2');
    // Still nothing written — a preview is not an apply.
    expect(setNeedLine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const payload = setNeedLine.mock.calls[0][0] as { sourceTargetEntities: unknown[] };
    expect(payload.sourceTargetEntities).toHaveLength(2);
  });

  it('cancelling the preview writes nothing', async () => {
    renderPanel('en');
    await fillValid();
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(await screen.findByRole('button', { name: T.cn2b_nl_bulk_cancel.en }));
    expect(screen.queryByTestId('cn2b-nl-preview')).not.toBeInTheDocument();
    expect(setNeedLine).not.toHaveBeenCalled();
  });
});

describe('M212 need-line panel — conversion state and read-only revision', () => {
  it('sends no canonical unit when a conversion is required', async () => {
    renderPanel('en');
    await fillValid('40');
    fireEvent.click(screen.getByLabelText(T.cn2b_nl_unit_conversion_required.en, { exact: false }));
    fireEvent.click(screen.getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(await screen.findByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    const p = setNeedLine.mock.calls[0][0] as { approvedUnit: unknown; unitConversionState: unknown };
    expect(p.unitConversionState).toBe('conversion_required');
    expect(p.approvedUnit).toBeNull();
  });

  it('offers no mapping control once the revision is no longer editable', async () => {
    renderPanel('en', { editable: false });
    expect(await screen.findByTestId('cn2b-nl-readonly')).toBeInTheDocument();
    expect(screen.queryByLabelText(T.cn2b_nl_beneficiary.en)).not.toBeInTheDocument();
  });

  it('reports mapping completeness against the mapped rows', async () => {
    renderPanel('en', {
      claimedSources: [
        { importSessionId: 's1', targetEntity: 'sheet:0:row:5' },
        { importSessionId: 's1', targetEntity: 'sheet:0:row:6' },
      ],
    });
    const state = await screen.findByTestId('cn2b-nl-completeness');
    expect(state).toHaveTextContent(T.cn2b_nl_complete.en);
    expect(state).toHaveTextContent('2/2');
  });
});

describe('M212 — the client never becomes the authority', () => {
  const SERVICE = readFileSync(
    join(__dirname, '..', 'central-needs.service.ts'), 'utf8');
  const PANEL = readFileSync(
    join(__dirname, '..', 'CentralNeedsNeedLinePanel.tsx'), 'utf8');

  it('writes need lines only through the canonical RPC', () => {
    expect(SERVICE).toContain("supabase.rpc('phoenix_central_needs_set_need_line'");
    for (const direct of [
      ".from('central_needs_need_lines').insert",
      ".from('central_needs_need_lines').update",
      ".from('central_needs_need_lines').delete",
      ".from('central_needs_need_line_sources').insert",
      ".from('central_needs_need_line_sources').delete",
    ]) {
      expect(SERVICE, direct).not.toContain(direct);
    }
  });

  it('infers no beneficiary from workbook shape — mapping stays human', () => {
    for (const heuristic of [
      'all_institutions_annual_needs', 'individual_institution_annual_needs',
      'INSTITUTION_HEADER_HINTS', 'sheetName', 'detectFamily',
    ]) {
      expect(PANEL, heuristic).not.toContain(heuristic);
    }
  });

  it('keeps the canonical unit vocabulary identical to the migration', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../supabase/migrations/212_phoenix_central_needs_need_lines.sql'), 'utf8');
    for (const u of ['box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other']) {
      expect(SERVICE, u).toContain(`'${u}'`);
      expect(sql, u).toContain(`'${u}'`);
    }
  });
});
