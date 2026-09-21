/**
 * E2-D — the Mapping Approval Gate.
 *
 * An explicit HUMAN review gate for the Excel-first mapping itself: is the exact
 * mapping the human declared (E2-B: National Code + Material columns; E2-C:
 * institution name cells, Need sources, beneficiaries) internally valid,
 * complete enough for later stages, explicitly reviewed, and represented by
 * deterministic evidence?
 *
 * IT IS NOT the Annual Needs revision's submission or approval, server review
 * readiness, persistence, stock truth, quantity interpretation, allocation, or
 * any inference. Nothing here reads a cell value, calls a service or writes
 * anything; the approval is local, in memory, and bound to one SHA-256
 * fingerprint of the canonical evidence.
 *
 * ONE TRUTH. Validity is decided by E2-B's and E2-C's own functions
 * (`isValidProfile`, `roleColumn`, `sameProfileIdentity`, `isValidContext`,
 * `isValidInstitutionMapping`, `evaluateInstitutionMappings`); this module only
 * names their outcomes as approval blockers. It never re-implements geometry.
 *
 * SELECTION IS NOT READINESS. The cursor/selection inside the trusted sheet is
 * not an input: moving it neither changes the evidence nor revokes approval.
 *
 * FAIL CLOSED. Blockers are returned, never repaired; without Web Crypto there
 * is no fingerprint and therefore no approval.
 */
import {
  evaluateInstitutionMappings,
  isValidContext,
  isValidInstitutionMapping,
  type InstitutionMappingState,
  type MappingSheetContext,
} from './institutionMapping';
import {
  isValidProfile,
  roleColumn,
  sameProfileIdentity,
  type SheetMappingProfile,
  type SheetMappingState,
} from './sheetMappingProfile';

export const MAPPING_APPROVAL_SCHEMA_VERSION = 'e2d-mapping-approval-v1';

/** Every reason the mapping is not ready, in the fixed order they are reported. */
export const MAPPING_APPROVAL_BLOCKERS = [
  'INVALID_REVISION_ID',
  'NO_TRUSTED_MAPPING_CONTEXT',
  'INVALID_SHEET_PROFILE',
  'NATIONAL_CODE_NOT_MAPPED',
  'MATERIAL_NOT_MAPPED',
  'ROLE_COLUMNS_NOT_DISTINCT',
  'PROFILE_CONTEXT_MISMATCH',
  'NO_INSTITUTION_MAPPINGS',
  'INVALID_INSTITUTION_MAPPING',
  'BENEFICIARY_NOT_ELIGIBLE',
  'INSTITUTION_MAPPING_CONFLICT',
  'UNCOMMITTED_MAPPING_DRAFT',
  'RESET_PENDING',
] as const;

export type MappingApprovalBlocker = (typeof MAPPING_APPROVAL_BLOCKERS)[number];

export interface MappingApprovalInput {
  /** The Annual Needs revision the workbook belongs to — identity only, never its status. */
  planRevisionId: string | null | undefined;
  /** E2-B state; only its profile is read. */
  sheet: Pick<SheetMappingState, 'profile'>;
  /** E2-C state; only context, committed entries, draft and reset request are read. */
  institutions: Pick<InstitutionMappingState, 'context' | 'mappings' | 'draft' | 'resetPending'>;
  /** Ids of the active care institutions the screen loaded right now. */
  eligibleBeneficiaryIds: readonly string[];
}

export interface MappingApprovalValidation {
  ready: boolean;
  blockers: MappingApprovalBlocker[];
}

const isRevisionId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.trim() === value;

const draftIsEmpty = (draft: MappingApprovalInput['institutions']['draft']): boolean =>
  !draft || (draft.editingId === null && draft.anchor === null && draft.need === null && draft.beneficiaryOrganizationId === null);

/**
 * Whether the declared mapping may be approved, with every blocker that applies.
 * Pure and deterministic: the same input always yields the same blockers in the
 * same order.
 */
export function validateMappingForApproval(input: MappingApprovalInput): MappingApprovalValidation {
  const found = new Set<MappingApprovalBlocker>();
  if (!isRevisionId(input.planRevisionId)) found.add('INVALID_REVISION_ID');

  const profile: SheetMappingProfile | null = input.sheet?.profile ?? null;
  const context: MappingSheetContext | null = input.institutions?.context ?? null;
  if (!profile || !context || !isValidContext(context)) {
    found.add('NO_TRUSTED_MAPPING_CONTEXT');
  } else {
    const profileValid = isValidProfile(profile);
    if (!profileValid) found.add('INVALID_SHEET_PROFILE');
    const nationalCode = profile.nationalCodeColumn?.columnIndex ?? null;
    const material = profile.materialColumn?.columnIndex ?? null;
    if (nationalCode === null) found.add('NATIONAL_CODE_NOT_MAPPED');
    if (material === null) found.add('MATERIAL_NOT_MAPPED');
    if (nationalCode !== null && nationalCode === material) found.add('ROLE_COLUMNS_NOT_DISTINCT');
    if (!sameProfileIdentity(profile, context)) found.add('PROFILE_CONTEXT_MISMATCH');

    const mappings = input.institutions.mappings ?? [];
    if (mappings.length === 0) found.add('NO_INSTITUTION_MAPPINGS');
    const ids = mappings.map((m) => m?.id);
    if (mappings.some((m) => !isValidInstitutionMapping(context, m)) || new Set(ids).size !== ids.length) {
      found.add('INVALID_INSTITUTION_MAPPING');
    }
    // E2-C's own verdict on every committed entry, named as approval blockers.
    const checks = { context, profile: profileValid ? profile : null, eligibleBeneficiaryIds: input.eligibleBeneficiaryIds ?? [] };
    for (const { problems } of evaluateInstitutionMappings(checks, mappings)) {
      for (const { reason } of problems) {
        if (reason === 'BENEFICIARY_NOT_ELIGIBLE') found.add('BENEFICIARY_NOT_ELIGIBLE');
        else if (reason === 'PROFILE_MISMATCH') found.add(profileValid ? 'PROFILE_CONTEXT_MISMATCH' : 'INVALID_SHEET_PROFILE');
        else if (reason === 'INVALID_MAPPING' || reason === 'INVALID_CONTEXT') found.add('INVALID_INSTITUTION_MAPPING');
        else found.add('INSTITUTION_MAPPING_CONFLICT');
      }
    }
  }
  if (!draftIsEmpty(input.institutions?.draft)) found.add('UNCOMMITTED_MAPPING_DRAFT');
  if (input.institutions?.resetPending) found.add('RESET_PENDING');

  const blockers = MAPPING_APPROVAL_BLOCKERS.filter((b) => found.has(b));
  return { ready: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Checklist (what the human reads)
// ---------------------------------------------------------------------------

export const MAPPING_APPROVAL_CHECKS = [
  'revision',
  'source',
  'nationalCode',
  'material',
  'institutions',
  'noConflict',
  'noUnsavedEdit',
] as const;

export type MappingApprovalCheck = (typeof MAPPING_APPROVAL_CHECKS)[number];

const CHECK_BLOCKERS: Record<MappingApprovalCheck, readonly MappingApprovalBlocker[]> = {
  revision: ['INVALID_REVISION_ID'],
  source: ['NO_TRUSTED_MAPPING_CONTEXT', 'PROFILE_CONTEXT_MISMATCH'],
  nationalCode: ['NO_TRUSTED_MAPPING_CONTEXT', 'INVALID_SHEET_PROFILE', 'NATIONAL_CODE_NOT_MAPPED', 'ROLE_COLUMNS_NOT_DISTINCT'],
  material: ['NO_TRUSTED_MAPPING_CONTEXT', 'INVALID_SHEET_PROFILE', 'MATERIAL_NOT_MAPPED', 'ROLE_COLUMNS_NOT_DISTINCT'],
  institutions: ['NO_TRUSTED_MAPPING_CONTEXT', 'NO_INSTITUTION_MAPPINGS', 'INVALID_INSTITUTION_MAPPING', 'BENEFICIARY_NOT_ELIGIBLE'],
  noConflict: ['NO_TRUSTED_MAPPING_CONTEXT', 'INSTITUTION_MAPPING_CONFLICT'],
  noUnsavedEdit: ['UNCOMMITTED_MAPPING_DRAFT', 'RESET_PENDING'],
};

/** Each checklist line and whether it holds, in display order. */
export function mappingApprovalChecklist(validation: MappingApprovalValidation): Array<{ check: MappingApprovalCheck; met: boolean }> {
  return MAPPING_APPROVAL_CHECKS.map((check) => ({
    check,
    met: !CHECK_BLOCKERS[check].some((b) => validation.blockers.includes(b)),
  }));
}

// ---------------------------------------------------------------------------
// Canonical evidence
// ---------------------------------------------------------------------------

/** The semantic state the approval covers — nothing transient, nothing localized. */
export function buildMappingApprovalEvidence(input: MappingApprovalInput, validation: MappingApprovalValidation) {
  const profile = input.sheet?.profile ?? null;
  const context = input.institutions?.context ?? null;
  const origin = context ?? profile;
  return {
    schemaVersion: MAPPING_APPROVAL_SCHEMA_VERSION,
    planRevisionId: typeof input.planRevisionId === 'string' ? input.planRevisionId : null,
    source: origin
      ? {
        batchId: origin.source.batchId,
        entryId: origin.source.entryId,
        entryOrdinal: origin.source.entryOrdinal,
        entrySha256: origin.source.entrySha256,
        importSessionId: origin.source.importSessionId,
        workbookIndex: origin.source.workbookIndex,
      }
      : null,
    sheet: origin ? { sheetIndex: origin.sheetIndex, sheetName: origin.sheetName } : null,
    sheetMapping: {
      nationalCodeColumn: profile ? roleColumn(profile, 'national_code') : null,
      materialColumn: profile ? roleColumn(profile, 'material') : null,
    },
    institutionMappings: (input.institutions?.mappings ?? []).map((m) => ({
      id: m.id,
      anchor: { ...m.anchor },
      need: { ...m.need },
      beneficiaryOrganizationId: m.beneficiaryOrganizationId,
    })),
    eligibilityBasis: {
      eligibleBeneficiaryIds: [...new Set(input.eligibleBeneficiaryIds ?? [])].sort(),
    },
    validation: { ready: validation.ready, blockers: [...validation.blockers] },
  };
}

export type MappingApprovalEvidence = ReturnType<typeof buildMappingApprovalEvidence>;

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('evidence_not_canonical');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new Error('evidence_not_canonical');
}

/** Compact JSON with every object's keys in sorted order: one semantic state → one string. */
export function canonicalEvidenceJson(evidence: MappingApprovalEvidence): string {
  return JSON.stringify(canonicalValue(evidence));
}

// ---------------------------------------------------------------------------
// SHA-256 fingerprint (Web Crypto only; fail closed)
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const isSha256Hex = (value: unknown): value is string => typeof value === 'string' && SHA256_HEX.test(value);

/** Lower-case hex SHA-256 of the canonical JSON's UTF-8 bytes. Rejects when Web Crypto is unavailable. */
export async function fingerprintCanonicalEvidence(canonicalJson: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') throw new Error('fingerprint_unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!isSha256Hex(hex)) throw new Error('fingerprint_unavailable');
  return hex;
}

// ---------------------------------------------------------------------------
// Local approval (pure transitions)
// ---------------------------------------------------------------------------

export interface LocalApprovalState {
  /** The fingerprint the human approved, or null. */
  approvedFingerprint: string | null;
  /** An earlier approval stopped matching the mapping and must be given again. */
  stale: boolean;
}

export type LocalApprovalAction = { type: 'approve'; fingerprint: string } | { type: 'revoke' };

export const INITIAL_LOCAL_APPROVAL: LocalApprovalState = Object.freeze({ approvedFingerprint: null, stale: false }) as LocalApprovalState;

export function localApprovalReducer(state: LocalApprovalState, action: LocalApprovalAction): LocalApprovalState {
  switch (action.type) {
    case 'approve':
      return isSha256Hex(action.fingerprint) ? { approvedFingerprint: action.fingerprint, stale: false } : state;
    case 'revoke':
      return state.approvedFingerprint === null ? state : { approvedFingerprint: null, stale: true };
    default:
      return state;
  }
}

/** Approved only while ready, fingerprinted, and the fingerprint is exactly the approved one. */
export function isLocallyApproved(
  validation: MappingApprovalValidation,
  currentFingerprint: string | null,
  approval: LocalApprovalState,
): boolean {
  return validation.ready
    && isSha256Hex(currentFingerprint)
    && approval.approvedFingerprint !== null
    && approval.approvedFingerprint === currentFingerprint;
}

export type MappingApprovalStatus = 'blocked' | 'fingerprinting' | 'fingerprint_unavailable' | 'ready' | 'approved';

export function mappingApprovalStatus(
  validation: MappingApprovalValidation,
  fingerprint: { value: string | null; unavailable: boolean },
  approval: LocalApprovalState,
): MappingApprovalStatus {
  if (!validation.ready) return 'blocked';
  if (fingerprint.unavailable) return 'fingerprint_unavailable';
  if (!isSha256Hex(fingerprint.value)) return 'fingerprinting';
  return isLocallyApproved(validation, fingerprint.value, approval) ? 'approved' : 'ready';
}
