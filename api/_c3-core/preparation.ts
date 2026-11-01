/** Trusted Node computation, unwired until worker/HTTP boundaries are accepted.
 * This routine must run inside an enforceably terminating worker before exposure. */
import { createHash } from 'node:crypto';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import { readAnnualOriginalAsCaller } from './original-reader.ts';
import { createAnnualExtractionEngine, type AnnualExtractionTemplate, type AnnualExtractionResult } from '../../src/features/central-needs/annual-catalog/annual-extraction-core.ts';
import type { AnnualCatalogScope } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import { replayWorkbook } from '../../src/features/central-needs/import/node-replay.ts';
import { DEFAULT_PARSER_LIMITS, type FileParseResult } from '../../src/features/central-needs/import/contract.ts';

export interface RegisteredAnnualLayout {
  template: AnnualExtractionTemplate;
  /** Explicitly reviewed whole-workbook shape, including non-extracted sheets. */
  workbookSheets: { index: number; name: string }[];
}
type Prepared = Extract<AnnualExtractionResult, { status: 'prepared' }>;
export type AnnualPreparationResult = { status: 'prepared'; candidate: Prepared; persisted: false;
  registrySha256: string; registrationSha256: string } | {
  status: 'held'; reason: 'layout_unavailable' | 'layout_ambiguous' | 'parse_rejected' | 'evidence_limit';
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function matchesLayout(registration: RegisteredAnnualLayout, parsed: FileParseResult): boolean {
  const sheets = parsed.workbook?.sheets;
  if (!sheets || registration.workbookSheets.length !== sheets.length
    || !registration.workbookSheets.every((expected, i) => expected.index === sheets[i].index && expected.name === sheets[i].name)) return false;
  return registration.template.blocks.every(block => {
    const sheet = sheets.find(s => s.index === block.sheetIndex);
    return sheet && Object.values(block.columns).every(binding => binding && sheet.cells.some(c =>
      c.coordinate.row === (binding.headerRow ?? block.headerRow) && c.coordinate.col === binding.column
      && c.presence === 'value' && c.valueType === 'string' && !c.isFormula && c.rawValue === binding.expectedHeaderText));
  }) && registration.template.classificationCells.every(anchor => {
    const block = registration.template.blocks.find(b => b.blockId === anchor.blockId);
    const sheet = sheets.find(s => s.index === block?.sheetIndex);
    return sheet?.cells.some(c => c.coordinate.row === anchor.row && c.coordinate.col === anchor.column
      && c.presence === 'value' && c.valueType === 'string' && !c.isFormula && c.rawValue === anchor.expectedText);
  });
}

export function createAnnualOriginalPreparationService(registrations: readonly RegisteredAnnualLayout[]) {
  if (registrations.length > 100 || registrations.some(r => !Array.isArray(r.workbookSheets)
    || r.workbookSheets.length < 1 || r.workbookSheets.length > DEFAULT_PARSER_LIMITS.maxSheets
    || r.workbookSheets.some((s, i) => s.index !== i || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 255)
    || new Set(r.workbookSheets.map(s => s.name)).size !== r.workbookSheets.length)) throw new Error('c3_registry_invalid');
  const serialized = JSON.stringify(registrations);
  const registry: RegisteredAnnualLayout[] = JSON.parse(serialized);
  const registrySha256 = digest(serialized);
  const engine = createAnnualExtractionEngine(registry.map(r => r.template));
  return {
    async prepare(caller: AuthenticatedCaller, scope: AnnualCatalogScope, originalId: string): Promise<AnnualPreparationResult> {
      const original = await readAnnualOriginalAsCaller(caller, scope, originalId);
      const parsed = await replayWorkbook(original.bytes, original.filename);
      if (parsed.outcome !== 'accepted' || !parsed.workbook) return { status: 'held', reason: 'parse_rejected' };
      const possible = registry.filter(r => matchesLayout(r, parsed));
      const matches: { candidate: Prepared; registrationSha256: string }[] = [];
      for (const registration of possible) {
        // Bound all blocks together using actual physical row extent. Never
        // truncate witnesses, or allocate 32 overlapping 10k-row projections.
        let rowSlots = 0;
        for (const block of registration.template.blocks) {
          const sheet = parsed.workbook.sheets.find(s => s.index === block.sheetIndex)!;
          const lastPhysicalRow = sheet.cells.reduce((max, c) => Math.max(max, c.coordinate.row), -1);
          rowSlots += Math.max(0, Math.min(block.lastRow, lastPhysicalRow) - block.firstRow + 1);
        }
        if (rowSlots > 10_000) return { status: 'held', reason: 'evidence_limit' };
        // Shape/header recognition is only a prefilter. The accepted core
        // independently reparses, hashes and validates all candidate witnesses.
        const candidate = await engine.extract({ scope: original.scope, original,
          templateId: registration.template.id, templateVersion: registration.template.version });
        if (candidate.status !== 'prepared') continue;
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 2_097_152) return { status: 'held', reason: 'evidence_limit' };
        matches.push({ candidate, registrationSha256: digest(JSON.stringify(registration)) });
        if (matches.length > 1) return { status: 'held', reason: 'layout_ambiguous' };
      }
      return matches.length === 1 ? { status: 'prepared', ...matches[0], registrySha256, persisted: false }
        : { status: 'held', reason: 'layout_unavailable' };
    },
  };
}
