/** P3-A0: preparation contract only. These types do not provide persistence or authority. */
import type { CellEvidence, ParserIdentity } from '../import/contract';

export const ANNUAL_CATALOG_CONTRACT_VERSION = '0.1.0' as const;

export interface AnnualCatalogScope {
  ownerOrgId: string;
  planningYear: number;
}

export const SOURCE_IDENTITY_FIELDS = [
  'scientificName', 'nameAr', 'nationalCode', 'currentNationalCode',
  'previousNationalCode', 'barcode', 'dosageForm', 'concentration', 'unit',
] as const;
export type SourceIdentityField = typeof SOURCE_IDENTITY_FIELDS[number];

export const ANNUAL_IDENTITY_FIELDS = [
  'scientificName', 'nameAr', 'nationalCode', 'barcode', 'dosageForm', 'concentration', 'unit',
] as const;
export type AnnualIdentityField = typeof ANNUAL_IDENTITY_FIELDS[number];

/** A reviewed mapping is exact and block-specific, not a guessed adjacent column. */
export interface IdentityColumnBinding {
  column: number;
  /** Multi-row headers may give this field its own exact header coordinate. */
  headerRow?: number;
  expectedHeaderText: string;
}

export interface AnnualSourceBlock {
  blockId: string;
  sheetIndex: number;
  /** All coordinates in this contract are zero-based, inclusive. */
  headerRow: number;
  firstRow: number;
  lastRow: number;
  columns: Partial<Record<SourceIdentityField, IdentityColumnBinding>>;
  /** Review/profile reference is evidence of the mapping, not a legal material match. */
  mappingReference: string;
  classification: { label: string; origin: 'source' | 'proposed'; reference: string } | null;
}

export interface SourceCellWitness {
  field: SourceIdentityField;
  /** Missing coordinates are represented explicitly; no neighbour or merged anchor is inherited. */
  cell: CellEvidence;
  header: CellEvidence;
}

export type SourceIdentityObservation =
  | { state: 'value'; text: string; witness: SourceCellWitness }
  | { state: 'missing'; reason: 'unmapped' | 'missing_cell' | 'blank' | 'empty_text'; witness: SourceCellWitness | null }
  | { state: 'invalid'; reason: 'formula' | 'non_text' | 'text_too_long' | 'control_text'; witness: SourceCellWitness };

export interface AnnualSourceOccurrence {
  /** Deterministic preparation key, never a persisted annual or canonical UUID. */
  occurrenceKey: string;
  scope: AnnualCatalogScope;
  source: {
    sourceId: string;
    filename: string;
    sha256: string;
    parser: ParserIdentity;
    sheetIndex: number;
    sheetName: string;
    row: number;
    blockId: string;
    mappingReference: string;
  };
  classification: AnnualSourceBlock['classification'];
  fields: Record<SourceIdentityField, SourceIdentityObservation>;
}

export type AnnualFieldOrigin = Readonly<
  | { kind: 'source'; occurrenceKey: string; field: SourceIdentityField }
  | { kind: 'canonical'; canonicalItemId: string; decisionReference: string }
  | { kind: 'manual'; decisionReference: string }>;

export interface AnnualFieldAlternative { readonly value: string; readonly origins: readonly AnnualFieldOrigin[] }
export type AnnualFieldState = Readonly<
  | ({ state: 'known' } & AnnualFieldAlternative)
  | { state: 'missing'; reason: string }
  | { state: 'not_applicable'; reason: string; decisionReference: string }
  | { state: 'conflict'; alternatives: readonly AnnualFieldAlternative[] }>;

export interface AnnualCatalogMembership {
  scope: AnnualCatalogScope;
  annualItemId: string;
  /** Pending preparation may be unresolved. Only a lawful existing registration can resolve it. */
  canonicalItemId: string | null;
  status: 'preparing' | 'active' | 'retired';
  currentFieldVersionId: string;
  occurrenceKeys: string[];
}

export interface AnnualFieldVersion {
  readonly scope: Readonly<AnnualCatalogScope>;
  readonly annualItemId: string;
  readonly fieldVersionId: string;
  readonly versionNumber: number;
  /** These fields must be persisted immutably by the future server contract. */
  readonly fields: Readonly<Record<AnnualIdentityField, AnnualFieldState>>;
}

export interface AnnualRegistrationContext {
  scope: AnnualCatalogScope;
  /** Existing legal registration workflow ID; this is not a second review state machine. */
  materialRequestId: string;
  annualItemId: string | null;
}

export interface AnnualCatalogSelection {
  scope: AnnualCatalogScope;
  annualItemId: string;
  fieldVersionId: string;
  canonicalItemId: string;
  /** There is intentionally no quantity, beneficiary, approval, allocation or stock value. */
}

export interface AnnualFieldIssue {
  field: AnnualIdentityField;
  code: 'missing_required' | 'required_not_applicable' | 'conflicting_values' | 'invalid_field_state';
}

export interface AnnualEvidenceReview {
  scope: AnnualCatalogScope;
  occurrenceKeys: string[];
  fields: Record<AnnualIdentityField, AnnualFieldState>;
  /** Source anomalies remain explicit even if a different witness supplies a value. */
  sourceIssues: Array<{ occurrenceKey: string; field: SourceIdentityField; reason: string }>;
  /** Reviewing an explicitly supplied group does NOT decide canonical identity or create membership. */
  canonicalIdentity: 'unresolved';
}
