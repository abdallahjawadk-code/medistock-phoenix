/**
 * CANONICAL-STOCK-CUTOVER — Status Center correction retirement.
 *
 * The last reachable item_availability quantity writer (Status Center →
 * AdjustQuantityModal → applyAvailabilityMovement, migration 034) is retired.
 * item_availability is a read-only projection (083); a Status Center row is an
 * AGGREGATE and can never be edited directly. Corrections now require picking an
 * explicit canonical outlet_stock LOT and go through the guarded migration-086
 * RPC (outlet_stock.count scoped, expected-generation, reservation-safe,
 * reason-mandatory, append-only). These static source assertions pin that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const statusCenter = read('features/status/StatusCenterScreen.tsx');
const launcher = read('features/status/AvailabilityStockCorrectionModal.tsx');
const strings = read('shared/i18n/strings.ts');

describe('A) the manual aggregate writer is gone', () => {
  it('AdjustQuantityModal.tsx stays deleted and unimported anywhere in production', () => {
    expectRetiredSurfaceAbsent('AdjustQuantityModal');
  });

  it('Status Center calls no item_availability quantity writer', () => {
    expect(statusCenter).not.toContain('applyAvailabilityMovement');
    expect(statusCenter).not.toContain('upsertAvailability');
    expect(statusCenter).not.toContain('<AdjustQuantityModal');
  });

  it('Status Center mounts the canonical correction launcher instead', () => {
    expect(statusCenter).toContain('<AvailabilityStockCorrectionModal');
    expect(statusCenter).toContain('setCorrectRow(r');
  });
});

describe('B) the launcher forces explicit canonical lot selection and the guarded 086 path', () => {
  it('loads canonical outlet_stock lots and never writes item_availability itself', () => {
    expect(launcher).toContain('getOutletStock(');
    expect(launcher).not.toContain('applyAvailabilityMovement');
    expect(launcher).not.toContain('upsertAvailability');
    expect(launcher).not.toMatch(/\.from\(/);
  });

  it('requires an explicit lot pick before any correction opens', () => {
    // A selectedLot must be chosen; the correction modal opens only then.
    expect(launcher).toContain('selectedLot');
    expect(launcher).toContain('setSelectedLot(lot)');
    expect(launcher).toContain('open={selectedLot !== null}');
  });

  it('delegates the write to the guarded OutletStockCorrectionModal (migration 086)', () => {
    expect(launcher).toContain('<OutletStockCorrectionModal');
    expect(launcher).toContain('lot={selectedLot}');
  });

  it('gates on the scoped outlet_stock.count permission, resolved for the row outlet', () => {
    expect(launcher).toContain('useOutletCountPermission(');
    expect(launcher).toContain('canCorrect');
  });

  it('reloads the read projection after a correction (canonical reload)', () => {
    expect(launcher).toContain('onCorrected()');
  });
});

describe('C) every new correction string is bilingual', () => {
  for (const key of [
    'sc_correct_stock_action', 'sc_correct_stock_title', 'sc_correct_stock_pick_lot',
    'sc_correct_stock_no_lots', 'sc_correct_stock_no_outlet',
  ]) {
    it(`${key} defines ar and en`, () => {
      const line = strings.split('\n').find(l => l.trimStart().startsWith(`${key}:`));
      expect(line, key).toBeTruthy();
      expect(line, `${key} ar`).toMatch(/ar:\s*'[^']+'/);
      expect(line, `${key} en`).toMatch(/en:\s*'[^']+'/);
    });
  }
});
