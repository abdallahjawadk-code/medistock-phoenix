import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbookBytes } from '../../import/parser-core';
import { extractAnnualIdentityBlock, ANNUAL_SOURCE_LIMITS } from '../annual-catalog-source';
import { reviewAnnualSourceOccurrences } from '../annual-catalog.model';
import type { AnnualSourceBlock } from '../annual-catalog.contract';
import { cell, simpleInput, structuralFixture, structuralInput, SCOPE } from './fixture-helpers';

describe('annual source identity — bounded evidence adapter', () => {
  it('uses the existing parser, keeps leading zeros and never emits quantity/institution cells', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Name', 'National code', 'Unit', 'Institution', 'Annual need'],
      ['Amoxicillin 500 mg', '000123-04', 'box', 'SYNTHETIC-INSTITUTION-DO-NOT-COPY', 87654321],
    ]), 'Identity');
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
    const input = simpleInput();
    input.parsed = await parseWorkbookBytes(bytes, 'synthetic-identity.xlsx', { runtime: 'node', now: () => '2026-10-31T00:00:00.000Z' });
    const [result] = extractAnnualIdentityBlock(input);
    expect(result.fields.nationalCode).toMatchObject({ state: 'value', text: '000123-04', witness: { cell: { coordinate: { a1: 'B2' }, rawValue: '000123-04' } } });
    expect(result.source.sha256).toBe(input.parsed.input.sha256);
    expect(result.source.parser).toEqual(input.parsed.identity);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-INSTITUTION-DO-NOT-COPY');
    expect(JSON.stringify(result)).not.toContain('87654321');
  });

  it('does not even read value getters outside the mapped block', () => {
    const input = simpleInput();
    const quantityCell = cell(1, 3, 100);
    Object.defineProperty(quantityCell, 'rawValue', { get() { throw new Error('quantity_was_read'); } });
    input.parsed.workbook!.sheets[0].cells.push(quantityCell);
    expect(extractAnnualIdentityBlock(input)).toHaveLength(1);
  });

  it.each([{ ownerOrgId: 'owner-b', planningYear: 2026 }, { ownerOrgId: 'owner-a', planningYear: 2027 }])(
    'rejects a source bound to another scope: %o', (other) => {
      const input = simpleInput(); input.sourceScope = other;
      expect(() => extractAnnualIdentityBlock(input)).toThrow('annual_catalog_scope_mismatch');
    },
  );

  it('preserves current, old and barcode separately, never fills a missing current code from either', () => {
    const input = structuralInput('dental-deleted-old-code');
    input.parsed.workbook!.sheets[0].cells.push(cell(1, 4, 'Barcode'), cell(5, 4, '0000007654321'));
    input.block.columns.barcode = { column: 4, headerRow: 1, expectedHeaderText: 'Barcode' };
    const [result] = extractAnnualIdentityBlock(input);
    expect(result.fields.currentNationalCode).toMatchObject({ state: 'missing', reason: 'blank' });
    expect(result.fields.previousNationalCode).toMatchObject({ state: 'value', text: 'M12-B0f-002' });
    expect(result.fields.barcode).toMatchObject({ state: 'value', text: '0000007654321' });
    const review = reviewAnnualSourceOccurrences(SCOPE, [result]);
    expect(review.fields.nationalCode.state).toBe('missing');
    expect(review.canonicalIdentity).toBe('unresolved');
  });

  it('retains mixed-row headers and the declared block, not a guessed common header row', () => {
    const [result] = extractAnnualIdentityBlock(structuralInput('dental-durable-new-code'));
    expect(result.fields.unit).toMatchObject({ state: 'value', text: 'kit', witness: { header: { coordinate: { a1: 'D1' } } } });
    expect(result.fields.currentNationalCode).toMatchObject({ text: 'DNI-RE00-001', witness: { header: { coordinate: { a1: 'A2' } } } });
    expect(result.fields.previousNationalCode).toMatchObject({ text: 'M12-B0d-001' });
    expect(result.source).toMatchObject({ blockId: '1:A:C:D', row: 3 });
  });

  it('uses declared nonadjacent name and unit columns', () => {
    const [result] = extractAnnualIdentityBlock(structuralInput('genetics-name-column-c'));
    expect(result.fields.scientificName).toMatchObject({ state: 'value', witness: { cell: { coordinate: { col: 2, a1: 'C4' } } } });
    expect(result.fields.unit).toMatchObject({ state: 'value', witness: { cell: { coordinate: { col: 4, a1: 'E4' } } } });
  });

  it('keeps trailing spaces as source evidence instead of silently normalizing identifiers', () => {
    const [result] = extractAnnualIdentityBlock(structuralInput('essential-code-trailing-spaces'));
    expect(result.fields.nationalCode).toMatchObject({ state: 'value', text: '04-K00-016  ' });
    expect(result.fields.unit).toMatchObject({ state: 'value', text: 'Tablet ' });
  });

  it('rejects numeric identifiers for interpretation and retains their original type/formatting as evidence', () => {
    const input = simpleInput();
    const numeric = cell(1, 1, 123); numeric.formattedText = '000123';
    input.parsed.workbook!.sheets[0].cells[4] = numeric;
    const [result] = extractAnnualIdentityBlock(input);
    expect(result.fields.nationalCode).toMatchObject({ state: 'invalid', reason: 'non_text', witness: { cell: { rawValue: 123, formattedText: '000123' } } });
    expect(reviewAnnualSourceOccurrences(SCOPE, [result]).fields.nationalCode.state).toBe('missing');
  });

  it('keeps formulas/errors untrusted, without evaluating them or treating cached text as identity', () => {
    const input = simpleInput();
    input.parsed.workbook!.sheets[0].cells[3] = { ...cell(1, 0, 'Cached name'), isFormula: true, formula: 'D2' };
    input.parsed.workbook!.sheets[0].cells[5] = { ...cell(1, 2, '#REF!'), valueType: 'error', errorCode: '#REF!' };
    const [result] = extractAnnualIdentityBlock(input);
    expect(result.fields.scientificName).toMatchObject({ state: 'invalid', reason: 'formula' });
    expect(result.fields.unit).toMatchObject({ state: 'invalid', reason: 'non_text' });
  });

  it('distinguishes absent, explicit blank, empty text and unmapped fields; NA is ordinary unreviewed source text', () => {
    const input = simpleInput();
    input.parsed.workbook!.sheets[0].cells[4] = cell(1, 1, null);
    input.parsed.workbook!.sheets[0].cells[5] = cell(1, 2, '');
    input.parsed.workbook!.sheets[0].cells.push(cell(0, 3, 'Form'), cell(1, 3, 'N/A'), cell(0, 4, 'Strength'));
    input.block.columns.dosageForm = { column: 3, expectedHeaderText: 'Form' };
    input.block.columns.concentration = { column: 4, expectedHeaderText: 'Strength' };
    const [result] = extractAnnualIdentityBlock(input);
    expect(result.fields.nationalCode).toMatchObject({ state: 'missing', reason: 'blank' });
    expect(result.fields.unit).toMatchObject({ state: 'missing', reason: 'empty_text' });
    expect(result.fields.concentration).toMatchObject({ state: 'missing', reason: 'missing_cell', witness: { cell: { coordinate: { a1: 'E2' } } } });
    expect(result.fields.nameAr).toEqual({ state: 'missing', reason: 'unmapped', witness: null });
    expect(result.fields.dosageForm).toMatchObject({ state: 'value', text: 'N/A' });
  });

  it('does not inherit merged or previous-row values into an incomplete material', () => {
    const input = simpleInput(); input.block.lastRow = 2;
    input.parsed.workbook!.sheets[0].mergedRanges = ['C2:C3'];
    input.parsed.workbook!.sheets[0].cells.push(cell(2, 0, 'Second material'), cell(2, 1, '000124'));
    const result = extractAnnualIdentityBlock(input);
    expect(result[1].fields.unit).toMatchObject({ state: 'missing', reason: 'missing_cell' });
  });

  it('skips rows that have quantities but no identity cells, without creating zero requirements', () => {
    const input = simpleInput(); input.block.lastRow = 2;
    input.parsed.workbook!.sheets[0].cells.push(cell(2, 3, 0));
    expect(extractAnnualIdentityBlock(input)).toHaveLength(1);
  });

  it('rejects changed header semantics, duplicate identity columns and nonidentity mappings', () => {
    const changed = simpleInput(); changed.parsed.workbook!.sheets[0].cells[1].rawValue = 'OLD CODE';
    expect(() => extractAnnualIdentityBlock(changed)).toThrow('annual_catalog_header_mismatch');
    const duplicate = simpleInput(); duplicate.block.columns.currentNationalCode = { column: 1, expectedHeaderText: 'National code' };
    expect(() => extractAnnualIdentityBlock(duplicate)).toThrow('annual_catalog_columns_invalid');
    const quantity = simpleInput(); quantity.block.columns = { ...quantity.block.columns, quantity: { column: 3, expectedHeaderText: 'Need' } } as AnnualSourceBlock['columns'];
    expect(() => extractAnnualIdentityBlock(quantity)).toThrow('annual_catalog_unknown_identity_field');
  });

  it('enforces parser/result, region, text, cell and coordinate bounds', () => {
    const rejected = simpleInput(); rejected.parsed.outcome = 'rejected';
    expect(() => extractAnnualIdentityBlock(rejected)).toThrow('annual_catalog_source_rejected');
    const unknownParser = simpleInput(); unknownParser.parsed.identity.contractVersion = 'unreviewed-next-contract';
    expect(() => extractAnnualIdentityBlock(unknownParser)).toThrow('annual_catalog_parser_contract_mismatch');
    const long = simpleInput(); long.block.lastRow = ANNUAL_SOURCE_LIMITS.maxRows;
    expect(() => extractAnnualIdentityBlock(long)).toThrow('annual_catalog_block_invalid');
    const huge = simpleInput(); huge.parsed.workbook!.sheets[0].cells.length = ANNUAL_SOURCE_LIMITS.maxCells + 1;
    expect(() => extractAnnualIdentityBlock(huge)).toThrow('annual_catalog_cell_limit');
    const duplicate = simpleInput(); duplicate.parsed.workbook!.sheets[0].cells.push(cell(1, 1, 'different'));
    expect(() => extractAnnualIdentityBlock(duplicate)).toThrow('annual_catalog_coordinate_invalid');
    const longText = simpleInput(); longText.parsed.workbook!.sheets[0].cells[3].rawValue = 'a'.repeat(4001);
    expect(extractAnnualIdentityBlock(longText)[0].fields.scientificName).toMatchObject({ state: 'invalid', reason: 'text_too_long' });
  });

  it('does not alias mutable parser evidence or expose source comments', () => {
    const input = simpleInput(); const source = input.parsed.workbook!.sheets[0].cells[3];
    source.hasComment = true; source.commentText = 'SYNTHETIC PRIVATE NOTE';
    const [result] = extractAnnualIdentityBlock(input);
    source.rawValue = 'Later mutation'; source.coordinate.a1 = 'Z99';
    expect(result.fields.scientificName).toMatchObject({ text: 'Amoxicillin 500 mg', witness: { cell: { coordinate: { a1: 'A2' }, hasComment: true } } });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC PRIVATE NOTE');
  });

  it('identifies the sanitized fixture as structural evidence, not an original-file replay', () => {
    expect(structuralFixture.fixtureKind).toBe('sanitized_structural_not_original_workbook_replay');
    expect(structuralFixture.originalQuantityOrInstitutionCellsIncluded).toBe(false);
    for (const sample of structuralFixture.samples) expect(extractAnnualIdentityBlock(structuralInput(sample.sampleId))).toHaveLength(1);
  });
});
