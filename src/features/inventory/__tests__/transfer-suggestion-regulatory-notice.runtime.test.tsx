/**
 * @vitest-environment jsdom
 *
 * TRANSFER-SUGGESTIONS REGULATORY NOTICE — the eleven proofs.
 *
 * The change has two halves and they are proven differently.
 *
 * The PANEL half is about POSITION and UNIQUENESS: one banner, above the list,
 * never inside a card. Position is a property of the source order, so those
 * proofs compare string OFFSETS rather than merely asserting a marker exists —
 * "contains ts_regulatory_notice" would pass just as happily if the banner had
 * been pasted into every card, which is the exact defect being excluded.
 *
 * The DIALOG half is about STATE, and state is invisible to a source scan: a
 * source scan cannot tell `useState(false)` that is reset on open from one
 * that is not. Those proofs therefore render the real dialog and drive it the
 * way an operator does.
 *
 * The last two proofs are boundary proofs: a stale suggestion still cannot
 * reach this dialog at all, and the one AUDITED regulatory acknowledgement
 * still lives — only — on the request submit/review path.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InventoryDraftDocumentDialog } from '../InventoryDraftDocumentDialog';

vi.mock('@/app/AppContext', () => ({ useApp: () => ({ lang: 'en' as const }) }));

const root = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const panel = read('src/features/inventory/InventoryIntelligencePanel.tsx');
const dialogSrc = read('src/features/inventory/InventoryDraftDocumentDialog.tsx');
const directSupply = read('src/features/network/DirectSupplyOperations.tsx');

/** Source with comments removed, so a scan judges CODE, not prose. Both files
 *  legitimately DISCUSS phoenix_record_regulatory_ack in a comment explaining
 *  why they must never call it — a raw scan cannot tell the two apart. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Offset of `needle`, asserted to occur exactly once. */
const onlyAt = (haystack: string, needle: string) => {
  const first = haystack.indexOf(needle);
  expect(first, `not found: ${needle}`).toBeGreaterThan(-1);
  expect(haystack.indexOf(needle, first + 1), `expected exactly one: ${needle}`).toBe(-1);
  return first;
};

/** Where the per-suggestion card body starts — everything after it is repeated
 *  once per suggestion, so nothing in there is a page-level notice. */
const CARD_LOOP = '(suggestions.data ?? []).map(s => {';

describe('1-4 · the panel renders ONE regulatory banner, above the list', () => {
  it('1 · the banner is rendered before any suggestion card', () => {
    const heading = onlyAt(panel, "t('inv_suggestions_title', lang)");
    const banner = onlyAt(panel, 'data-testid="inv-suggestions-regulatory-banner"');
    const cards = onlyAt(panel, CARD_LOOP);

    // section heading  <  banner  <  the card loop
    expect(banner).toBeGreaterThan(heading);
    expect(banner).toBeLessThan(cards);

    // It also precedes every branch the list can take, so it is on screen
    // while suggestions are still loading, on error, and when there are none.
    for (const branch of [
      '{suggestions.loading && <PhoenixLoadingState',
      '{!suggestions.loading && suggestions.error && (',
      "t('inv_empty_suggestions', lang)",
    ]) {
      expect(panel.indexOf(branch), branch).toBeGreaterThan(banner);
    }
  });

  it('2 · the banner carries ts_regulatory_notice with warning semantics', () => {
    const banner = panel.slice(
      panel.indexOf('data-testid="inv-suggestions-regulatory-banner"'),
      panel.indexOf(CARD_LOOP),
    );
    expect(banner).toContain("t('ts_regulatory_notice', lang)");
    expect(banner).toContain("t('inv_regulatory_banner_title', lang)");
    // Accessible warning semantics, a warning icon, and warning tokens.
    expect(panel).toContain('role="alert"');
    expect(banner).toContain('<PhoenixIcon name="warning"');
    expect(banner).toContain('var(--warn)');
    expect(banner).toContain('var(--warn2)');
    // Full width of the section, and RTL/LTR-safe.
    expect(banner).toContain("width: '100%'");
    expect(banner).toContain('borderInlineStartWidth');
    expect(banner).toContain('dir="auto"');
  });

  it('3 · the ordinary recommendation-only notice is still rendered, below it', () => {
    const banner = onlyAt(panel, 'data-testid="inv-suggestions-regulatory-banner"');
    const note = onlyAt(panel, "t('inv_recommendation_note', lang)");
    const cards = onlyAt(panel, CARD_LOOP);

    expect(note).toBeGreaterThan(banner);
    expect(note).toBeLessThan(cards);
    expect(panel).toContain('role="note"');

    // The two notices remain DIFFERENT statements — the weaker one was not
    // quietly swapped for the regulatory wording, nor removed.
    expect(panel).toContain("t('inv_recommendation_note', lang)");
    expect(panel).toContain("t('ts_regulatory_notice', lang)");
  });

  it('4 · the regulatory warning is not repeated inside every card', () => {
    // Exactly one occurrence in the whole panel...
    onlyAt(panel, "t('ts_regulatory_notice', lang)");
    onlyAt(panel, "t('inv_regulatory_banner_title', lang)");
    onlyAt(panel, 'role="alert"');

    // ...and none of it inside the per-suggestion card body.
    const cardBody = panel.slice(panel.indexOf(CARD_LOOP));
    expect(cardBody).not.toContain('ts_regulatory_notice');
    expect(cardBody).not.toContain('inv_regulatory_banner_title');
    expect(cardBody).not.toContain('inv-suggestions-regulatory-banner');
    expect(cardBody).not.toContain('role="alert"');
  });
});

describe('5-9 · the draft dialog requires BOTH a document number and the ack', () => {
  afterEach(cleanup);

  const CREATE = /create draft/i;

  const renderDialog = (onConfirm = vi.fn()) => {
    const view = render(
      <InventoryDraftDocumentDialog open onCancel={() => {}} onConfirm={onConfirm} />,
    );
    return {
      onConfirm,
      reopen: () => {
        view.rerender(<InventoryDraftDocumentDialog open={false} onCancel={() => {}} onConfirm={onConfirm} />);
        view.rerender(<InventoryDraftDocumentDialog open onCancel={() => {}} onConfirm={onConfirm} />);
      },
    };
  };

  const ack = () => screen.getByTestId('inv-draft-reg-ack');
  const docNumber = () => screen.getByLabelText(/document number/i);
  const createButton = () => screen.getByRole('button', { name: CREATE });

  it('5 · opens with the acknowledgement unchecked and its requirement shown', () => {
    renderDialog();
    expect(ack()).not.toBeChecked();
    expect(screen.getByText(/must confirm the regulatory review/i)).toBeInTheDocument();
    // The pre-existing "this moves no stock" warning is still there.
    expect(screen.getByText(/does not reserve stock/i)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });

  it('6 · a document number alone leaves Create draft disabled', () => {
    renderDialog();
    fireEvent.change(docNumber(), { target: { value: 'DOC-1' } });
    expect(ack()).not.toBeChecked();
    expect(createButton()).toBeDisabled();
  });

  it('7 · the acknowledgement alone leaves Create draft disabled', () => {
    renderDialog();
    fireEvent.click(ack());
    expect(ack()).toBeChecked();
    // Whitespace is not a document number either.
    fireEvent.change(docNumber(), { target: { value: '   ' } });
    expect(createButton()).toBeDisabled();
  });

  it('8 · both together enable it, and confirm passes the trimmed number', () => {
    const { onConfirm } = renderDialog();
    fireEvent.change(docNumber(), { target: { value: '  DOC-7  ' } });
    fireEvent.click(ack());

    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('DOC-7');
  });

  it('9 · reopening the dialog resets the acknowledgement to false', () => {
    const { reopen } = renderDialog();
    fireEvent.change(docNumber(), { target: { value: 'DOC-9' } });
    fireEvent.click(ack());
    expect(createButton()).toBeEnabled();

    reopen();

    expect(ack()).not.toBeChecked();
    expect(docNumber()).toHaveValue('');
    expect(createButton()).toBeDisabled();
    expect(screen.getByText(/must confirm the regulatory review/i)).toBeInTheDocument();
  });
});

describe('10-11 · the surrounding contract is untouched', () => {
  it('10 · a stale suggestion still cannot reach the draft dialog', () => {
    // The dialog opens from ONE place, and that place is inside the server's
    // createDraft permission — which a stale suggestion never carries. The
    // acknowledgement is an ADDITIONAL gate downstream of it, never a way in.
    const guard = onlyAt(panel, '{action.allowedActions.createDraft && (');
    const opener = onlyAt(panel, 'setDraftTarget(s)');
    expect(opener).toBeGreaterThan(guard);
    expect(panel).toContain('open={draftTarget !== null}');

    // Staleness is still the server's decision, not re-derived on the client.
    expect(panel).toContain("action.freshnessState === 'stale'");
    expect(panel).not.toContain('isSuggestionStale');

    // And the dialog itself gained no escape hatch: confirming needs both.
    expect(dialogSrc).toContain("const canConfirm = trimmed !== '' && regulatoryAck;");
    expect(dialogSrc).toContain('disabled={!canConfirm || busy}');
    expect(dialogSrc).toContain('if (canConfirm) onConfirm(trimmed);');
  });

  it('11 · the audited request-level acknowledgement is unchanged and unduplicated', () => {
    // Still recorded, still only on the transfer submit/review path.
    expect(directSupply).toContain("supabase.rpc('phoenix_record_regulatory_ack'");
    expect(directSupply).toContain("t('ts_regulatory_notice', lang)");
    expect(directSupply).toContain("t('ts_ack_checkbox', lang)");

    // The suggestion page adds NO second audit event. Judged on code with the
    // comments stripped: both files DISCUSS the RPC precisely to say they must
    // not call it, and that prose must not be mistaken for a call site.
    expect(codeOnly(panel)).not.toContain('phoenix_record_regulatory_ack');
    expect(codeOnly(dialogSrc)).not.toContain('phoenix_record_regulatory_ack');
    expect(codeOnly(dialogSrc)).not.toContain('supabase');
    // ...and the stripping is not what made those pass: the RPC is still
    // reachable from exactly one call site in the codebase.
    expect(codeOnly(directSupply)).toContain("supabase.rpc('phoenix_record_regulatory_ack'");

    // The dialog's ack is local state only — it is never sent anywhere.
    expect(dialogSrc).toContain('const [regulatoryAck, setRegulatoryAck] = useState(false);');
    expect(dialogSrc).toContain('onConfirm: (documentNumber: string) => void;');
  });
});
