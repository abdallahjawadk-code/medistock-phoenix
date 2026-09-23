/**
 * C4 — the client's pure region rules: geometry, X1, obstacles, the verbatim
 * conversion fence, G3 and the Simple one-click suppression.
 */
import { describe, expect, it } from 'vitest';
import {
  addsFromDrafts,
  boundsIntersect,
  boundsLabel,
  boundsOfNeed,
  conversionOf,
  conversionsWithoutRegion,
  draftObstacles,
  loadedLayerConflict,
  oneClickConfirmSuppressed,
  regionGovernsColumn,
  renderedParserMatchesSession,
  RUNNING_PARSER_IDENTITY,
} from '../beneficiaryRegions';
import type { BeneficiaryRegionVersion, ScopeColumnMapping } from '../../central-needs.service';
import type { InstitutionMapping } from '../../mapping/institutionMapping';
import { CN2A_CONTRACT_VERSION, SHEETJS_TARBALL_SHA256, SHEETJS_VERSION } from '../../import/contract.ts';

const WHOLE = 1_048_575;

const version = (over: Partial<BeneficiaryRegionVersion> = {}): BeneficiaryRegionVersion => ({
  versionId: 'v1', regionId: 'r1', versionNo: 1, supersedesVersionId: null, planRevisionId: 'rev',
  importSessionId: 's1', sheetIndex: 0, rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 2,
  decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', decisionReason: 'r', decidedBy: 'u', decidedAt: 't',
  ...over,
});
const m213 = (over: Partial<ScopeColumnMapping> = {}): ScopeColumnMapping => ({
  mappingId: 'm1', importSessionId: 's1', sheetIndex: 0, columnIndex: 5, decision: 'beneficiary',
  beneficiaryOrganizationId: 'org-b', mappedAt: '2026-09-01T10:00:00.123456+00:00', ...over,
});
const draft = (id: string, need: InstitutionMapping['need'], ben = 'org-a'): InstitutionMapping => ({
  id, anchor: { kind: 'cell', rowIndex: 0, columnIndex: 0, mergedRange: null }, need, beneficiaryOrganizationId: ben,
});

describe('C4 region geometry', () => {
  it('a whole E2-C column persists as [0..1,048,575] x [c..c], explicit integers', () => {
    expect(boundsOfNeed({ kind: 'column', columnIndex: 7 })).toEqual({ rowStart: 0, rowEnd: WHOLE, columnStart: 7, columnEnd: 7 });
    expect(boundsOfNeed({ kind: 'range', startRow: 3, endRow: 9, startColumn: 1, endColumn: 4 }))
      .toEqual({ rowStart: 3, rowEnd: 9, columnStart: 1, columnEnd: 4 });
  });

  it('inclusive intersection; touching edges do not intersect', () => {
    const a = { rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 3 };
    expect(boundsIntersect(a, { rowStart: 20, rowEnd: 30, columnStart: 3, columnEnd: 3 })).toBe(true);
    expect(boundsIntersect(a, { rowStart: 21, rowEnd: 30, columnStart: 2, columnEnd: 3 })).toBe(false);
    expect(boundsIntersect(a, { rowStart: 1, rowEnd: 20, columnStart: 4, columnEnd: 5 })).toBe(false);
  });

  it('X1: a column is region-governed when any ACTIVE version of that session and sheet spans it', () => {
    const active = [version({ columnStart: 2, columnEnd: 4 })];
    expect(regionGovernsColumn(active, 's1', 0, 3)).toBe(true);
    expect(regionGovernsColumn(active, 's1', 0, 5)).toBe(false);
    expect(regionGovernsColumn(active, 's1', 1, 3)).toBe(false);
    expect(regionGovernsColumn(active, 's2', 0, 3)).toBe(false);
  });

  it('a loaded scope where an ACTIVE version spans an M213 column is a conflict (fail closed)', () => {
    expect(loadedLayerConflict([version({ columnStart: 4, columnEnd: 6 })], [m213({ columnIndex: 5 })]))
      .toEqual({ columnIndex: 5, versionId: 'v1' });
    expect(loadedLayerConflict([version()], [m213({ columnIndex: 5 })])).toBeNull();
  });

  it('labels a stored rectangle in A1 for display only', () => {
    expect(boundsLabel({ rowStart: 0, rowEnd: WHOLE, columnStart: 2, columnEnd: 2 })).toBe('C:C');
    expect(boundsLabel({ rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 3 })).toBe('C2:D21');
    expect(boundsLabel({ rowStart: 0, rowEnd: WHOLE, columnStart: 26, columnEnd: 27 })).toBe('AA:AB');
  });
});

describe('C4 drafts against persisted truth (obstacles only ever added)', () => {
  it('a draft overlapping an ACTIVE version, or spanning an M213 column, is blocked', () => {
    const drafts = [
      draft('im-1', { kind: 'range', startRow: 10, endRow: 30, startColumn: 2, endColumn: 2 }),
      draft('im-2', { kind: 'column', columnIndex: 5 }),
      draft('im-3', { kind: 'range', startRow: 21, endRow: 40, startColumn: 2, endColumn: 2 }),
    ];
    const out = draftObstacles(drafts, [version()], [m213()], new Set());
    expect(out).toEqual([
      { draftId: 'im-1', reason: 'REGION_OVERLAP', conflict: 'v1' },
      { draftId: 'im-2', reason: 'M213_COLUMN', conflict: '5' },
    ]);
  });

  it('an M213 column the human explicitly chose to convert is no longer an obstacle', () => {
    const out = draftObstacles([draft('im-2', { kind: 'column', columnIndex: 5 })], [], [m213()], new Set([5]));
    expect(out).toEqual([]);
  });

  it('each committed draft becomes exactly one explicit beneficiary add with its own rectangle; no anchor is sent', () => {
    const adds = addsFromDrafts([draft('im-1', { kind: 'column', columnIndex: 3 }, 'org-x')]);
    expect(adds).toEqual([{ op: 'add', rowStart: 0, rowEnd: WHOLE, columnStart: 3, columnEnd: 3, decision: 'beneficiary', beneficiaryOrganizationId: 'org-x' }]);
    expect(JSON.stringify(adds)).not.toContain('anchor');
  });

  it('a conversion carries the M213 fence VERBATIM (mapped_at untouched) and copies no decision into any region', () => {
    const item = conversionOf(m213({ decision: 'non_beneficiary', beneficiaryOrganizationId: null }));
    expect(item).toEqual({
      op: 'convert_column', columnIndex: 5, expectedMappingId: 'm1', previousDecision: 'non_beneficiary',
      previousBeneficiaryOrganizationId: null, previousMappedAt: '2026-09-01T10:00:00.123456+00:00',
    });
    expect(Object.keys(item)).not.toContain('rowStart');
  });

  it('a converted column with no new rectangle over it is reported (nothing is auto-created)', () => {
    const adds = addsFromDrafts([draft('im-1', { kind: 'range', startRow: 1, endRow: 5, startColumn: 5, endColumn: 6 })]);
    expect(conversionsWithoutRegion(new Set([5, 7]), adds)).toEqual([7]);
    expect(conversionsWithoutRegion(new Set([7]), [])).toEqual([7]);
  });
});

describe('C4 G3 and the Simple one-click suppression', () => {
  it('the running parser identity is this build\'s own constants', () => {
    expect(RUNNING_PARSER_IDENTITY).toEqual({
      contractVersion: CN2A_CONTRACT_VERSION, sheetjsVersion: SHEETJS_VERSION, sheetjsTarballSha256: SHEETJS_TARBALL_SHA256,
    });
  });

  it('G3 holds only when contract, SheetJS version and tarball hash all match; runtime is not compared', () => {
    const session = { ...RUNNING_PARSER_IDENTITY, runtime: 'node' };
    expect(renderedParserMatchesSession(RUNNING_PARSER_IDENTITY, session)).toBe(true);
    expect(renderedParserMatchesSession(RUNNING_PARSER_IDENTITY, { ...session, contractVersion: '1.0.0' })).toBe(false);
    expect(renderedParserMatchesSession(RUNNING_PARSER_IDENTITY, { ...session, sheetjsTarballSha256: 'x' })).toBe(false);
    expect(renderedParserMatchesSession(RUNNING_PARSER_IDENTITY, null)).toBe(false);
    expect(renderedParserMatchesSession(null, session)).toBe(false);
  });

  it('one-click is withheld for a column an ACTIVE region spans, a draft intersects, or when regions are unreadable', () => {
    const column = { importSessionId: 's1', sheetIndex: 0, columnIndex: 2 };
    const ready = (versions: BeneficiaryRegionVersion[]) => ({ phase: 'ready' as const, versions });
    expect(oneClickConfirmSuppressed(column, ready([]), null)).toBe(false);
    expect(oneClickConfirmSuppressed(column, ready([version()]), null)).toBe(true);
    expect(oneClickConfirmSuppressed(column, { phase: 'unavailable', code: 'x' }, null)).toBe(true);
    const drafts = { importSessionId: 's1', sheetIndex: 0, needs: [{ rowStart: 3, rowEnd: 4, columnStart: 1, columnEnd: 2 }] };
    expect(oneClickConfirmSuppressed(column, ready([]), drafts)).toBe(true);
    expect(oneClickConfirmSuppressed({ ...column, sheetIndex: 1 }, ready([]), drafts)).toBe(false);
    expect(oneClickConfirmSuppressed({ ...column, columnIndex: 3 }, ready([]), drafts)).toBe(false);
  });
});
