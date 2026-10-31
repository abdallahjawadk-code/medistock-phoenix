/** P3-A1 v1 transport contract. Validation is defensive; the database owns authority. */
import {
  ANNUAL_IDENTITY_FIELDS, SOURCE_IDENTITY_FIELDS,
  type AnnualCatalogMembership, type AnnualCatalogScope, type AnnualFieldVersion,
  type AnnualIdentityField, type AnnualSourceOccurrence,
} from './annual-catalog.contract';
import { assertAnnualScope, assessAnnualFields } from './annual-catalog.model';
import { CN2A_CONTRACT_VERSION, DEFAULT_PARSER_LIMITS } from '../import/contract';
import { NEED_LINE_UNITS } from '../central-needs.service';
import type { MaterialDescriptor, MaterialRequestStatus } from '../manual/material-registration.service';

export interface AnnualCatalogServerContract {
  version: 1;
  scope: 'owner_year';
  canonicalSnapshots: true;
  sourceAttestation: 'client_attested';
  quantityBinding: false;
}

export interface AnnualCatalogYear {
  planningYear: number;
  status: 'active' | 'archived';
  createdAt: string;
}

export interface AnnualCatalogYearResult {
  scope: AnnualCatalogScope;
  year: AnnualCatalogYear;
  idempotentReplay: boolean;
}

export interface AnnualCatalogYearsPage {
  ownerOrgId: string;
  years: AnnualCatalogYear[];
  nextAfterYear: number | null;
}

export interface AnnualCanonicalSnapshot {
  canonicalItemId: string;
  scientificName: string | null;
  nameAr: string | null;
  nationalCode: string | null;
  barcode: string | null;
  dosageForm: string | null;
  concentration: string | null;
  unit: string | null;
  status: string;
}

export interface AnnualCanonicalPreview {
  scope: AnnualCatalogScope;
  canonicalItemId: string;
  canonicalSnapshot: AnnualCanonicalSnapshot;
  /** Opaque server token: never hash or recreate a canonical snapshot in the client. */
  canonicalFingerprint: string;
  eligible: boolean;
  missingRequired: AnnualIdentityField[];
}

export interface AnnualCatalogItemResult {
  scope: AnnualCatalogScope;
  membership: AnnualCatalogMembership;
  fieldVersion: AnnualFieldVersion;
  canonicalFingerprint: string;
  canonicalDrift: boolean;
  selectable: boolean;
  selectionBlockers: string[];
  sourceOccurrenceCount: number;
  sourceAttestation: 'client_attested';
}

export interface AnnualCatalogWriteResult extends AnnualCatalogItemResult { idempotentReplay: boolean }
export interface AnnualMaterialCompletionResult extends AnnualCatalogWriteResult { requestId: string }

export interface AnnualCatalogCursor extends AnnualCatalogScope {
  query: string;
  rank: 0 | 1;
  annualItemId: string;
}

export interface AnnualCatalogPage {
  scope: AnnualCatalogScope;
  items: AnnualCatalogItemResult[];
  nextCursor: AnnualCatalogCursor | null;
}

export interface AnnualCatalogOccurrencesPage {
  scope: AnnualCatalogScope;
  annualItemId: string;
  occurrences: AnnualSourceOccurrence[];
  nextAfterOccurrenceId: string | null;
  attestation: 'client_attested';
}

export interface AnnualMaterialRequestResult {
  scope: AnnualCatalogScope;
  requestId: string;
  status: MaterialRequestStatus;
  version: number;
  idempotentReplay: boolean;
}

export type AnnualMaterialDescriptor = Omit<MaterialDescriptor, 'nationalCode'> & { nationalCode: string | null };

export interface AddAnnualCatalogItemInput {
  scope: AnnualCatalogScope;
  canonicalItemId: string;
  expectedCanonicalFingerprint: string;
  occurrences: readonly AnnualSourceOccurrence[];
  reason: string;
  idempotencyKey: string;
}

export interface RefreshAnnualCatalogItemInput {
  scope: AnnualCatalogScope;
  annualItemId: string;
  expectedFieldVersionId: string;
  expectedCanonicalFingerprint: string;
  occurrences: readonly AnnualSourceOccurrence[];
  reason: string;
  idempotencyKey: string;
}

export interface CompleteAnnualMaterialRequestInput {
  scope: AnnualCatalogScope;
  requestId: string;
  expectedRequestVersion: number;
  expectedCanonicalFingerprint: string;
  reason: string;
  idempotencyKey: string;
}

type Boundary = 'input' | 'response';
type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const UNITS: readonly string[] = NEED_LINE_UNITS;
const REQUIRED_FIELDS = ['scientificName', 'nationalCode', 'unit'] as const;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ANY_CONTROL_TEXT = /[\u0000-\u001F\u007F]/;

export class AnnualCatalogContractError extends Error {
  readonly code: 'annual_catalog_invalid_input' | 'annual_catalog_invalid_response';
  /** A malformed acknowledgement does not prove that its write rolled back. */
  outcomeUnknown = false;
  constructor(boundary: Boundary, readonly path: string) {
    const code = boundary === 'input' ? 'annual_catalog_invalid_input' : 'annual_catalog_invalid_response';
    super(`${code}: ${path}`);
    this.name = 'AnnualCatalogContractError';
    this.code = code;
  }
}

function check(ok: boolean, boundary: Boundary, path: string): asserts ok {
  if (!ok) throw new AnnualCatalogContractError(boundary, path);
}

export function catalogObject(value: unknown, keys: readonly string[], path: string, boundary: Boundary = 'response', optional: readonly string[] = []): JsonObject {
  check(!!value && typeof value === 'object' && !Array.isArray(value), boundary, path);
  const row = value as JsonObject;
  check(keys.every((key) => Object.prototype.hasOwnProperty.call(row, key))
    && Object.keys(row).every((key) => keys.includes(key) || optional.includes(key)), boundary, `${path}.keys`);
  return row;
}

export function catalogText(value: unknown, path: string, boundary: Boundary = 'input', max = 4000, nonempty = true): string {
  check(typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0), boundary, path);
  return value;
}

export function catalogUuid(value: unknown, path: string, boundary: Boundary = 'input'): string {
  check(typeof value === 'string' && UUID.test(value), boundary, path);
  return value.toLowerCase();
}

export function catalogInteger(value: unknown, min: number, max: number, path: string, boundary: Boundary = 'input'): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, boundary, path);
  return value;
}

export function catalogBoolean(value: unknown, path: string, boundary: Boundary = 'response'): boolean {
  check(typeof value === 'boolean', boundary, path);
  return value;
}

export function catalogFingerprint(value: unknown, path: string, boundary: Boundary = 'input'): string {
  check(typeof value === 'string' && SHA256.test(value), boundary, path);
  return value;
}

export function catalogScope(value: unknown, expected?: AnnualCatalogScope, boundary: Boundary = 'input'): AnnualCatalogScope {
  const row = catalogObject(value, ['ownerOrgId', 'planningYear'], 'scope', boundary);
  const scope = { ownerOrgId: catalogUuid(row.ownerOrgId, 'scope.ownerOrgId', boundary),
    planningYear: catalogInteger(row.planningYear, 2000, 2100, 'scope.planningYear', boundary) };
  // Keep the shared A0 boundary, with the server UUID restriction added above.
  assertAnnualScope(scope);
  check(!expected || (scope.ownerOrgId === expected.ownerOrgId && scope.planningYear === expected.planningYear), boundary, 'scope.mismatch');
  return scope;
}

export function catalogQuery(value: unknown, boundary: Boundary = 'input'): string {
  check(typeof value === 'string', boundary, 'query');
  const query = value.trim();
  check(query.length <= 200 && !ANY_CONTROL_TEXT.test(query), boundary, 'query');
  return query;
}

export function catalogIdempotencyKey(value: unknown): string {
  const key = catalogText(value, 'idempotencyKey', 'input', 128);
  check(key.length >= 8 && !CONTROL_TEXT.test(key), 'input', 'idempotencyKey');
  return key;
}

export function catalogReason(value: unknown): string {
  const reason = catalogText(value, 'reason', 'input', 2000);
  check(!CONTROL_TEXT.test(reason), 'input', 'reason');
  return reason;
}

export function validateAnnualCatalogServerContract(value: unknown): AnnualCatalogServerContract {
  const row = catalogObject(value, ['version', 'scope', 'canonicalSnapshots', 'sourceAttestation', 'quantityBinding'], 'contract');
  check(row.version === 1 && row.scope === 'owner_year' && row.canonicalSnapshots === true
    && row.sourceAttestation === 'client_attested' && row.quantityBinding === false, 'response', 'contract.version');
  return row as unknown as AnnualCatalogServerContract;
}

export function validateCatalogYear(value: unknown): AnnualCatalogYear {
  const row = catalogObject(value, ['planningYear', 'status', 'createdAt'], 'year');
  catalogInteger(row.planningYear, 2000, 2100, 'year.planningYear', 'response');
  check(row.status === 'active' || row.status === 'archived', 'response', 'year.status');
  const time = catalogText(row.createdAt, 'year.createdAt', 'response', 64);
  check(/^\d{4}-\d{2}-\d{2}T/.test(time) && Number.isFinite(Date.parse(time)), 'response', 'year.createdAt');
  return row as unknown as AnnualCatalogYear;
}

export function validateCatalogCursor(value: unknown, scope: AnnualCatalogScope, query: string, boundary: Boundary = 'input'): AnnualCatalogCursor {
  const row = catalogObject(value, ['ownerOrgId', 'planningYear', 'query', 'rank', 'annualItemId'], 'cursor', boundary);
  const validatedScope = catalogScope({ ownerOrgId: row.ownerOrgId, planningYear: row.planningYear }, scope, boundary);
  check(row.query === query && catalogQuery(row.query, boundary) === row.query, boundary, 'cursor.query');
  const rank = catalogInteger(row.rank, 0, 1, 'cursor.rank', boundary) as 0 | 1;
  return { ...validatedScope, query, rank, annualItemId: catalogUuid(row.annualItemId, 'cursor.annualItemId', boundary) };
}

export function validateCanonicalPreview(value: unknown, scope: AnnualCatalogScope, canonicalItemId: string): AnnualCanonicalPreview {
  const row = catalogObject(value, ['scope', 'canonicalItemId', 'canonicalSnapshot', 'canonicalFingerprint', 'eligible', 'missingRequired'], 'preview');
  catalogScope(row.scope, scope, 'response');
  check(catalogUuid(row.canonicalItemId, 'preview.canonicalItemId', 'response') === canonicalItemId, 'response', 'preview.canonicalItemId');
  const snapshot = catalogObject(row.canonicalSnapshot, ['canonicalItemId', ...ANNUAL_IDENTITY_FIELDS, 'status'], 'canonicalSnapshot');
  check(catalogUuid(snapshot.canonicalItemId, 'canonicalSnapshot.canonicalItemId', 'response') === canonicalItemId, 'response', 'canonicalSnapshot.canonicalItemId');
  for (const key of ANNUAL_IDENTITY_FIELDS) if (snapshot[key] !== null) catalogText(snapshot[key], `canonicalSnapshot.${key}`, 'response', 4000, false);
  check(['active', 'inactive', 'discontinued'].includes(String(snapshot.status)), 'response', 'canonicalSnapshot.status');
  catalogFingerprint(row.canonicalFingerprint, 'preview.canonicalFingerprint', 'response');
  catalogBoolean(row.eligible, 'preview.eligible');
  check(Array.isArray(row.missingRequired) && row.missingRequired.length <= 3
    && row.missingRequired.every((key) => REQUIRED_FIELDS.includes(key))
    && new Set(row.missingRequired).size === row.missingRequired.length, 'response', 'preview.missingRequired');
  const missing = REQUIRED_FIELDS.filter((key) => typeof snapshot[key] !== 'string' || String(snapshot[key]).trim().length === 0
    || (key === 'unit' && !UNITS.includes(String(snapshot.unit))));
  const reportedMissing = row.missingRequired;
  check(missing.length === reportedMissing.length && missing.every((key) => reportedMissing.includes(key)),
    'response', 'preview.missingRequired');
  if (row.eligible) check(snapshot.status === 'active' && row.missingRequired.length === 0
    && REQUIRED_FIELDS.every((key) => typeof snapshot[key] === 'string' && String(snapshot[key]).trim().length > 0)
    && UNITS.includes(String(snapshot.unit)), 'response', 'preview.eligible');
  return row as unknown as AnnualCanonicalPreview;
}

/** P3-B callers opt into annual corrections explicitly; A1's strict snapshot boundary stays the default. */
export function validateAnnualCatalogFields(value: unknown, canonicalId: string, allowAnnualEdits = false): AnnualFieldVersion['fields'] {
  const fields = catalogObject(value, ANNUAL_IDENTITY_FIELDS, 'fieldVersion.fields');
  for (const key of ANNUAL_IDENTITY_FIELDS) {
    const state = fields[key] as JsonObject | null;
    check(!!state && typeof state === 'object', 'response', `fields.${key}`);
    if (state.state === 'missing') {
      catalogObject(state, ['state', 'reason'], `fields.${key}`);
      check(state.reason === 'canonical_missing' || (allowAnnualEdits && state.reason === 'annual_correction_missing'),
        'response', `fields.${key}.reason`);
    } else {
      catalogObject(state, ['state', 'value', 'origins'], `fields.${key}`);
      check(state.state === 'known', 'response', `fields.${key}.state`);
      catalogText(state.value, `fields.${key}.value`, 'response');
      check(Array.isArray(state.origins) && state.origins.length === 1, 'response', `fields.${key}.origins`);
      const candidate = state.origins[0] as JsonObject | null;
      if (allowAnnualEdits && candidate?.kind === 'manual') {
        const origin = catalogObject(candidate, ['kind', 'decisionReference'], `fields.${key}.origin`);
        catalogUuid(origin.decisionReference, `fields.${key}.decisionReference`, 'response');
      } else {
        const origin = catalogObject(candidate, ['kind', 'canonicalItemId', 'decisionReference'], `fields.${key}.origin`);
        check(origin.kind === 'canonical' && catalogUuid(origin.canonicalItemId, `fields.${key}.canonicalItemId`, 'response') === canonicalId,
          'response', `fields.${key}.origin`);
        catalogText(origin.decisionReference, `fields.${key}.decisionReference`, 'response', 2000);
      }
      if (key === 'unit') check(UNITS.includes(String(state.value)), 'response', 'fields.unit.value');
    }
  }
  return fields as unknown as AnnualFieldVersion['fields'];
}

/** Old-version reads validate associations but may legitimately differ from the current head. */
export function validateAnnualCatalogItem(value: unknown, scope: AnnualCatalogScope, expected: {
  annualItemId?: string; canonicalItemId?: string; fieldVersionId?: string; current?: boolean; write?: boolean; requestId?: string;
  allowAnnualEdits?: boolean;
} = {}): AnnualCatalogItemResult | AnnualCatalogWriteResult | AnnualMaterialCompletionResult {
  const keys = ['scope', 'membership', 'fieldVersion', 'canonicalFingerprint', 'canonicalDrift', 'selectable',
    'selectionBlockers', 'sourceOccurrenceCount', 'sourceAttestation'];
  if (expected.write) keys.push('idempotentReplay');
  if (expected.requestId) keys.push('requestId');
  const row = catalogObject(value, keys, 'item');
  catalogScope(row.scope, scope, 'response');
  const member = catalogObject(row.membership, ['scope', 'annualItemId', 'canonicalItemId', 'status', 'currentFieldVersionId', 'occurrenceKeys'], 'membership');
  catalogScope(member.scope, scope, 'response');
  const annualId = catalogUuid(member.annualItemId, 'membership.annualItemId', 'response');
  const canonicalId = catalogUuid(member.canonicalItemId, 'membership.canonicalItemId', 'response');
  const headId = catalogUuid(member.currentFieldVersionId, 'membership.currentFieldVersionId', 'response');
  check(!expected.annualItemId || expected.annualItemId === annualId, 'response', 'membership.annualItemId');
  check(!expected.canonicalItemId || expected.canonicalItemId === canonicalId, 'response', 'membership.canonicalItemId');
  check(['active', 'preparing', 'retired'].includes(String(member.status)), 'response', 'membership.status');
  check(Array.isArray(member.occurrenceKeys) && member.occurrenceKeys.length <= 500, 'response', 'membership.occurrenceKeys');
  const occurrenceIds = member.occurrenceKeys.map((id) => catalogUuid(id, 'membership.occurrenceKeys', 'response'));
  check(new Set(occurrenceIds).size === occurrenceIds.length, 'response', 'membership.occurrenceKeys.duplicate');
  const version = catalogObject(row.fieldVersion, ['scope', 'annualItemId', 'fieldVersionId', 'versionNumber', 'fields'], 'fieldVersion');
  catalogScope(version.scope, scope, 'response');
  check(catalogUuid(version.annualItemId, 'fieldVersion.annualItemId', 'response') === annualId, 'response', 'fieldVersion.annualItemId');
  const versionId = catalogUuid(version.fieldVersionId, 'fieldVersion.fieldVersionId', 'response');
  check(!expected.fieldVersionId || versionId === expected.fieldVersionId, 'response', 'fieldVersion.fieldVersionId');
  check(!expected.current || headId === versionId, 'response', 'fieldVersion.current');
  catalogInteger(version.versionNumber, 1, 2_147_483_647, 'fieldVersion.versionNumber', 'response');
  const fields = validateAnnualCatalogFields(version.fields, canonicalId, expected.allowAnnualEdits);
  catalogFingerprint(row.canonicalFingerprint, 'item.canonicalFingerprint', 'response');
  catalogBoolean(row.canonicalDrift, 'item.canonicalDrift');
  catalogBoolean(row.selectable, 'item.selectable');
  check(Array.isArray(row.selectionBlockers) && row.selectionBlockers.length <= 50, 'response', 'item.selectionBlockers');
  row.selectionBlockers.forEach((blocker) => catalogText(blocker, 'item.selectionBlockers', 'response', 200));
  const count = catalogInteger(row.sourceOccurrenceCount, 0, 500, 'item.sourceOccurrenceCount', 'response');
  check(count === occurrenceIds.length, 'response', 'item.sourceOccurrenceCount');
  check(row.sourceAttestation === 'client_attested', 'response', 'item.sourceAttestation');
  if (row.selectable) check(member.status === 'active' && row.canonicalDrift === false && headId === versionId
    && row.selectionBlockers.length === 0 && assessAnnualFields(fields as unknown as AnnualFieldVersion['fields']).length === 0,
  'response', 'item.selectable');
  if (expected.write) {
    catalogBoolean(row.idempotentReplay, 'item.idempotentReplay');
    if (row.idempotentReplay) check(row.selectable === false && row.selectionBlockers.includes('receipt_replay_requires_refresh'),
      'response', 'item.replayRequiresRefresh');
  }
  if (expected.requestId) check(catalogUuid(row.requestId, 'item.requestId', 'response') === expected.requestId, 'response', 'item.requestId');
  return row as unknown as AnnualCatalogItemResult;
}

function cellAddress(row: number, col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
}

function validateWitnessCell(value: unknown, path: string, boundary: Boundary): JsonObject {
  const cell = catalogObject(value, ['coordinate', 'presence', 'rawValue', 'isFormula', 'hasComment'], path, boundary,
    ['valueType', 'errorCode', 'formattedText', 'formula']);
  const coord = catalogObject(cell.coordinate, ['row', 'col', 'a1'], `${path}.coordinate`, boundary);
  const row = catalogInteger(coord.row, 0, DEFAULT_PARSER_LIMITS.maxRows - 1, `${path}.row`, boundary);
  const col = catalogInteger(coord.col, 0, DEFAULT_PARSER_LIMITS.maxCols - 1, `${path}.col`, boundary);
  check(coord.a1 === cellAddress(row, col), boundary, `${path}.a1`);
  check(['value', 'missing', 'blank'].includes(String(cell.presence)), boundary, `${path}.presence`);
  check(cell.rawValue === null || typeof cell.rawValue === 'string' || typeof cell.rawValue === 'boolean'
    || (typeof cell.rawValue === 'number' && Number.isFinite(cell.rawValue)), boundary, `${path}.rawValue`);
  if (cell.valueType !== undefined) check(['number', 'string', 'boolean', 'date', 'error'].includes(String(cell.valueType)), boundary, `${path}.valueType`);
  for (const key of ['errorCode', 'formattedText', 'formula']) if (cell[key] !== undefined) catalogText(cell[key], `${path}.${key}`, boundary, 16_000, false);
  if (typeof cell.rawValue === 'string') catalogText(cell.rawValue, `${path}.rawValue`, boundary, 16_000, false);
  catalogBoolean(cell.isFormula, `${path}.isFormula`, boundary);
  catalogBoolean(cell.hasComment, `${path}.hasComment`, boundary);
  check(cell.isFormula === (cell.formula !== undefined), boundary, `${path}.formula`);
  if (cell.presence !== 'value') {
    check(cell.rawValue === null && cell.valueType === undefined, boundary, `${path}.presence`);
  } else {
    const typeMatches = cell.valueType === 'number' || cell.valueType === 'date' ? typeof cell.rawValue === 'number'
      : cell.valueType === 'string' || cell.valueType === 'error' ? typeof cell.rawValue === 'string'
        : cell.valueType === 'boolean' && typeof cell.rawValue === 'boolean';
    check(typeMatches, boundary, `${path}.valueType`);
  }
  return cell;
}

export function validateAnnualOccurrences(value: unknown, scope: AnnualCatalogScope, boundary: Boundary = 'input', max = 100): AnnualSourceOccurrence[] {
  check(Array.isArray(value) && value.length <= max, boundary, 'occurrences');
  const keys = new Set<string>();
  for (const entry of value) {
    const row = catalogObject(entry, ['occurrenceKey', 'scope', 'source', 'classification', 'fields'], 'occurrence', boundary);
    const key = boundary === 'response' ? catalogUuid(row.occurrenceKey, 'occurrence.occurrenceKey', boundary)
      : catalogText(row.occurrenceKey, 'occurrence.occurrenceKey', boundary);
    check(!keys.has(key), boundary, 'occurrences.duplicate'); keys.add(key);
    catalogScope(row.scope, scope, boundary);
    const source = catalogObject(row.source, ['sourceId', 'filename', 'sha256', 'parser', 'sheetIndex', 'sheetName', 'row', 'blockId', 'mappingReference'], 'occurrence.source', boundary);
    for (const field of ['sourceId', 'filename', 'sheetName', 'blockId', 'mappingReference']) catalogText(source[field], `source.${field}`, boundary);
    if (boundary === 'response') catalogUuid(source.sourceId, 'source.sourceId', boundary);
    catalogFingerprint(source.sha256, 'source.sha256', boundary);
    catalogInteger(source.sheetIndex, 0, DEFAULT_PARSER_LIMITS.maxSheets - 1, 'source.sheetIndex', boundary);
    const sourceRow = catalogInteger(source.row, 0, DEFAULT_PARSER_LIMITS.maxRows - 1, 'source.row', boundary);
    const parser = catalogObject(source.parser, ['contractVersion', 'sheetjsVersion', 'sheetjsTarballSha256', 'runtime'], 'source.parser', boundary);
    check(parser.contractVersion === CN2A_CONTRACT_VERSION && ['node', 'browser_worker'].includes(String(parser.runtime)), boundary, 'source.parser.contract');
    catalogText(parser.sheetjsVersion, 'source.parser.sheetjsVersion', boundary, 100);
    catalogFingerprint(parser.sheetjsTarballSha256, 'source.parser.sheetjsTarballSha256', boundary);
    if (row.classification !== null) {
      const classification = catalogObject(row.classification, ['label', 'origin', 'reference'], 'classification', boundary);
      catalogText(classification.label, 'classification.label', boundary);
      catalogText(classification.reference, 'classification.reference', boundary);
      check(classification.origin === 'source' || classification.origin === 'proposed', boundary, 'classification.origin');
    }
    const fields = catalogObject(row.fields, SOURCE_IDENTITY_FIELDS, 'occurrence.fields', boundary);
    for (const field of SOURCE_IDENTITY_FIELDS) {
      const observation = fields[field] as JsonObject | null;
      check(!!observation && typeof observation === 'object', boundary, `observation.${field}`);
      catalogObject(observation, observation.state === 'value' ? ['state', 'text', 'witness'] : ['state', 'reason', 'witness'], `observation.${field}`, boundary);
      check(['value', 'missing', 'invalid'].includes(String(observation.state)), boundary, `observation.${field}.state`);
      if (observation.state === 'missing') check(['unmapped', 'missing_cell', 'blank', 'empty_text'].includes(String(observation.reason)), boundary, `observation.${field}.reason`);
      if (observation.state === 'invalid') check(['formula', 'non_text', 'text_too_long', 'control_text'].includes(String(observation.reason)), boundary, `observation.${field}.reason`);
      if (observation.witness === null) {
        check(observation.state === 'missing' && observation.reason === 'unmapped', boundary, `observation.${field}.witness`);
        continue;
      }
      const witness = catalogObject(observation.witness, ['field', 'cell', 'header'], `witness.${field}`, boundary);
      check(witness.field === field, boundary, `witness.${field}.field`);
      const cell = validateWitnessCell(witness.cell, `witness.${field}.cell`, boundary);
      const header = validateWitnessCell(witness.header, `witness.${field}.header`, boundary);
      const coordinate = cell.coordinate as JsonObject; const headerCoordinate = header.coordinate as JsonObject;
      check(coordinate.row === sourceRow && coordinate.col === headerCoordinate.col
        && (headerCoordinate.row as number) < sourceRow, boundary, `witness.${field}.coordinates`);
      check(header.presence === 'value' && header.valueType === 'string' && !header.isFormula
        && typeof header.rawValue === 'string' && header.rawValue.trim().length > 0
        && header.rawValue.length <= 4000, boundary, `witness.${field}.header`);
      if (observation.state === 'value') {
        const text = catalogText(observation.text, `observation.${field}.text`, boundary);
        check(cell.presence === 'value' && cell.valueType === 'string' && !cell.isFormula
          && cell.rawValue === text && !CONTROL_TEXT.test(text), boundary, `observation.${field}.value`);
      } else {
        // Validate the A0 observation without converting, completing or merging its raw value.
        const reason = cell.presence === 'missing' ? 'missing_cell' : cell.presence === 'blank' ? 'blank'
          : cell.isFormula ? 'formula' : cell.valueType !== 'string' ? 'non_text'
            : String(cell.rawValue).length > 4000 ? 'text_too_long' : CONTROL_TEXT.test(String(cell.rawValue)) ? 'control_text'
              : String(cell.rawValue).trim().length === 0 ? 'empty_text' : null;
        const state = ['missing_cell', 'blank', 'empty_text'].includes(reason ?? '') ? 'missing' : 'invalid';
        check(reason !== null && observation.reason === reason && observation.state === state, boundary, `observation.${field}.reason`);
      }
    }
  }
  // Detach validated plain JSON from mutable caller state before an asynchronous RPC.
  return JSON.parse(JSON.stringify(value)) as AnnualSourceOccurrence[];
}

export function validateAnnualMaterialDescriptor(value: unknown): AnnualMaterialDescriptor {
  const row = catalogObject(value, ['scientificName', 'nameAr', 'tradeName', 'strength', 'dosageForm', 'unit', 'barcode', 'nationalCode', 'note'], 'descriptor', 'input');
  const scientificName = catalogText(row.scientificName, 'descriptor.scientificName', 'input', 300);
  check(!CONTROL_TEXT.test(scientificName), 'input', 'descriptor.scientificName');
  check(UNITS.includes(String(row.unit)), 'input', 'descriptor.unit');
  for (const field of ['nameAr', 'tradeName', 'strength', 'dosageForm', 'barcode', 'nationalCode', 'note']) {
    if (row[field] === null) continue;
    const max = field === 'note' ? 2000 : ['barcode', 'nationalCode'].includes(field) ? 64 : ['strength', 'dosageForm'].includes(field) ? 200 : 300;
    const text = catalogText(row[field], `descriptor.${field}`, 'input', max);
    check(!CONTROL_TEXT.test(text), 'input', `descriptor.${field}`);
    if (field === 'nationalCode') check(text === text.trim() && !ANY_CONTROL_TEXT.test(text), 'input', 'descriptor.nationalCode');
  }
  return { ...row } as unknown as AnnualMaterialDescriptor;
}

export function validateAnnualMaterialRequest(value: unknown, scope: AnnualCatalogScope): AnnualMaterialRequestResult {
  const row = catalogObject(value, ['scope', 'requestId', 'status', 'version', 'idempotentReplay'], 'request');
  catalogScope(row.scope, scope, 'response');
  catalogUuid(row.requestId, 'request.requestId', 'response');
  check(['draft', 'submitted', 'under_review', 'needs_info', 'resolved_existing', 'approved_new', 'rejected', 'cancelled'].includes(String(row.status)), 'response', 'request.status');
  catalogInteger(row.version, 1, 2_147_483_647, 'request.version', 'response');
  catalogBoolean(row.idempotentReplay, 'request.idempotentReplay');
  return row as unknown as AnnualMaterialRequestResult;
}
