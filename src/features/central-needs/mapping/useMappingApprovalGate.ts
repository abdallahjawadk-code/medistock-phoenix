/**
 * E2-D — React memory for the LOCAL approval of one declared mapping.
 *
 * Validation and canonical evidence are derived synchronously from the E2-B and
 * E2-C state on every render (the selection is not an input). The SHA-256
 * fingerprint is computed with Web Crypto only when the mapping is ready, and a
 * result is used only for the exact canonical JSON it was computed for.
 *
 * Approval happens only through `approve()`, is bound to the current
 * fingerprint, and is revoked — for good, until given again — the moment it no
 * longer matches (any semantic change, a draft, a pending reset, lost context).
 * Nothing is persisted: the state lives as long as the calling component, which
 * the workspace remounts per revision.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  INITIAL_LOCAL_APPROVAL,
  buildMappingApprovalEvidence,
  canonicalEvidenceJson,
  fingerprintCanonicalEvidence,
  isLocallyApproved,
  localApprovalReducer,
  mappingApprovalChecklist,
  mappingApprovalStatus,
  validateMappingForApproval,
  type MappingApprovalInput,
  type MappingApprovalStatus,
  type MappingApprovalValidation,
} from './mappingApprovalGate';

export interface MappingApprovalController {
  validation: MappingApprovalValidation;
  checklist: ReturnType<typeof mappingApprovalChecklist>;
  status: MappingApprovalStatus;
  /** The canonical evidence JSON the fingerprint and the approval cover. */
  canonicalJson: string;
  /** Lower-case hex SHA-256 of `canonicalJson`, or null (not ready, pending, or unavailable). */
  fingerprint: string | null;
  approved: boolean;
  /** An earlier approval no longer matches and must be given again. */
  stale: boolean;
  /** Approve the mapping as it is now. Does nothing unless it is ready and fingerprinted. */
  approve: () => void;
}

type FingerprintState = { forJson: string; value: string | null; unavailable: boolean } | null;

export function useMappingApprovalGate(input: MappingApprovalInput): MappingApprovalController {
  const { planRevisionId, sheet, institutions, eligibleBeneficiaryIds } = input;
  const eligibleKey = JSON.stringify([...new Set(eligibleBeneficiaryIds)].sort());
  const { validation, canonicalJson } = useMemo(() => {
    const request: MappingApprovalInput = {
      planRevisionId,
      sheet: { profile: sheet.profile },
      institutions: {
        context: institutions.context,
        mappings: institutions.mappings,
        draft: institutions.draft,
        resetPending: institutions.resetPending,
      },
      eligibleBeneficiaryIds: JSON.parse(eligibleKey) as string[],
    };
    const checked = validateMappingForApproval(request);
    return { validation: checked, canonicalJson: canonicalEvidenceJson(buildMappingApprovalEvidence(request, checked)) };
  }, [planRevisionId, sheet.profile, institutions.context, institutions.mappings, institutions.draft, institutions.resetPending, eligibleKey]);

  const [computed, setComputed] = useState<FingerprintState>(null);
  useEffect(() => {
    if (!validation.ready) return undefined;
    const run = { active: true };
    fingerprintCanonicalEvidence(canonicalJson).then(
      (value) => { if (run.active) setComputed({ forJson: canonicalJson, value, unavailable: false }); },
      () => { if (run.active) setComputed({ forJson: canonicalJson, value: null, unavailable: true }); },
    );
    return () => { run.active = false; };
  }, [validation.ready, canonicalJson]);

  const current = computed !== null && computed.forJson === canonicalJson ? computed : null;
  const fingerprint = validation.ready && current ? current.value : null;
  const unavailable = validation.ready && current !== null && current.unavailable;

  const [approval, dispatch] = useReducer(localApprovalReducer, INITIAL_LOCAL_APPROVAL);
  const approved = isLocallyApproved(validation, fingerprint, approval);
  // Any render in which an approval exists but no longer matches ends it.
  useEffect(() => {
    if (approval.approvedFingerprint !== null && !approved) dispatch({ type: 'revoke' });
  }, [approval.approvedFingerprint, approved]);

  const approve = useCallback(() => {
    if (validation.ready && fingerprint !== null) dispatch({ type: 'approve', fingerprint });
  }, [validation.ready, fingerprint]);

  return {
    validation,
    checklist: mappingApprovalChecklist(validation),
    status: mappingApprovalStatus(validation, { value: fingerprint, unavailable }, approval),
    canonicalJson,
    fingerprint,
    approved,
    stale: approval.stale && !approved,
    approve,
  };
}
