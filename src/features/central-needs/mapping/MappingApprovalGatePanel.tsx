/**
 * E2-D — the Mapping Approval Gate panel.
 *
 * Where the HUMAN reviews the whole declared mapping (E2-B roles + E2-C
 * institution mappings) and explicitly approves it LOCALLY. Presentational: it
 * renders `useMappingApprovalGate` and reports one button press.
 *
 * It says, always and in both languages, that this approval covers the mapping
 * review only and does NOT submit or approve the Annual Needs revision. It
 * never shows a bare "approved": every approved state is "approved locally",
 * next to the SHA-256 fingerprint of the evidence it covers.
 */
import { useEffect, useId, useRef } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { MappingApprovalBlocker, MappingApprovalCheck } from './mappingApprovalGate';
import type { MappingApprovalController } from './useMappingApprovalGate';

interface Props {
  lang: Lang;
  approval: MappingApprovalController;
}

const CHECK_LABEL: Record<MappingApprovalCheck, string> = {
  revision: 'cn2b_approve_check_revision',
  source: 'cn2b_approve_check_source',
  nationalCode: 'cn2b_approve_check_national_code',
  material: 'cn2b_approve_check_material',
  institutions: 'cn2b_approve_check_institutions',
  noConflict: 'cn2b_approve_check_no_conflict',
  noUnsavedEdit: 'cn2b_approve_check_no_unsaved_edit',
};

const BLOCKER_TEXT: Record<MappingApprovalBlocker, string> = {
  INVALID_REVISION_ID: 'cn2b_approve_block_revision',
  NO_TRUSTED_MAPPING_CONTEXT: 'cn2b_approve_block_context',
  INVALID_SHEET_PROFILE: 'cn2b_approve_block_profile',
  NATIONAL_CODE_NOT_MAPPED: 'cn2b_approve_block_national_code',
  MATERIAL_NOT_MAPPED: 'cn2b_approve_block_material',
  ROLE_COLUMNS_NOT_DISTINCT: 'cn2b_approve_block_same_column',
  PROFILE_CONTEXT_MISMATCH: 'cn2b_approve_block_context_mismatch',
  NO_INSTITUTION_MAPPINGS: 'cn2b_approve_block_no_institutions',
  INVALID_INSTITUTION_MAPPING: 'cn2b_approve_block_invalid_mapping',
  BENEFICIARY_NOT_ELIGIBLE: 'cn2b_approve_block_not_eligible',
  INSTITUTION_MAPPING_CONFLICT: 'cn2b_approve_block_conflict',
  UNCOMMITTED_MAPPING_DRAFT: 'cn2b_approve_block_draft',
  RESET_PENDING: 'cn2b_approve_block_reset_pending',
};

export function MappingApprovalGatePanel({ lang, approval }: Props) {
  const idPrefix = useId();
  const confirmationRef = useRef<HTMLDivElement>(null);
  const { validation, checklist, status, canonicalJson, fingerprint, approved, stale } = approval;
  const titleId = `${idPrefix}-title`;
  const checklistId = `${idPrefix}-checklist`;
  const blockersId = `${idPrefix}-blockers`;
  const canApprove = status === 'ready';

  // The approve button is replaced by the confirmation; keep keyboard focus on it.
  const wasApproved = useRef(approved);
  useEffect(() => {
    if (approved && !wasApproved.current) confirmationRef.current?.focus();
    wasApproved.current = approved;
  }, [approved]);

  const stateKey = status === 'blocked' ? 'cn2b_approve_state_blocked'
    : status === 'approved' ? 'cn2b_approve_state_approved'
      : 'cn2b_approve_state_valid';

  return (
    <section
      className="cn2b-approve"
      aria-labelledby={titleId}
      lang={lang}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      data-testid="cn2b-approve-panel"
      data-approval-status={status}
      data-approved={approved ? 'true' : 'false'}
    >
      <p className="cn2b-approve__eyebrow">
        <PhoenixIcon name="lock" size={14} inline aria-hidden="true" /> {t('cn2b_map_eyebrow', lang)}
      </p>
      <h2 className="cn2b-approve__title" id={titleId}>{t('cn2b_approve_title', lang)}</h2>
      <p className="cn2b-approve__disclaimer" data-testid="cn2b-approve-disclaimer">
        <PhoenixIcon name="info" size={14} inline aria-hidden="true" /> {t('cn2b_approve_disclaimer', lang)}
      </p>

      <p className="cn2b-approve__state" role="status" data-testid="cn2b-approve-state" data-state={validation.ready ? 'valid' : 'blocked'}>
        <PhoenixIcon name={validation.ready ? 'check' : 'warning'} size={15} inline aria-hidden="true" /> {t(stateKey, lang)}
      </p>

      <h3 className="cn2b-approve__subtitle" id={checklistId}>{t('cn2b_approve_checklist', lang)}</h3>
      <ul className="cn2b-approve__checklist" aria-labelledby={checklistId} data-testid="cn2b-approve-checklist">
        {checklist.map(({ check, met }) => (
          <li key={check} className="cn2b-approve__check" data-check={check} data-met={met ? 'true' : 'false'}>
            <span className="cn2b-approve__mark" aria-hidden="true">{met ? '✓' : '✗'}</span>
            <span className="cn2b-approve__check-label">{t(CHECK_LABEL[check], lang)}</span>
            <span className="cn2b-approve__check-state">{t(met ? 'cn2b_approve_met' : 'cn2b_approve_not_met', lang)}</span>
          </li>
        ))}
      </ul>

      {validation.blockers.length > 0 && (
        <div className="cn2b-approve__blockers" data-testid="cn2b-approve-blockers">
          <h3 className="cn2b-approve__subtitle" id={blockersId}>{t('cn2b_approve_blockers', lang)}</h3>
          <ul aria-labelledby={blockersId}>
            {validation.blockers.map((b) => <li key={b} data-blocker={b}>{t(BLOCKER_TEXT[b], lang)}</li>)}
          </ul>
        </div>
      )}

      {stale && (
        <p className="cn2b-approve__stale" role="alert" data-testid="cn2b-approve-stale">
          <PhoenixIcon name="warning" size={15} inline aria-hidden="true" /> {t('cn2b_approve_stale', lang)}
        </p>
      )}

      {status === 'fingerprint_unavailable' && (
        <p className="cn2b-approve__stale" role="alert" data-testid="cn2b-approve-fingerprint-unavailable">
          <PhoenixIcon name="warning" size={15} inline aria-hidden="true" /> {t('cn2b_approve_fingerprint_unavailable', lang)}
        </p>
      )}
      {status === 'fingerprinting' && (
        <p className="cn2b-approve__hint" data-testid="cn2b-approve-fingerprinting">{t('cn2b_approve_fingerprinting', lang)}</p>
      )}
      {status === 'ready' && (
        <p className="cn2b-approve__hint" data-testid="cn2b-approve-awaiting">{t('cn2b_approve_awaiting', lang)}</p>
      )}

      {fingerprint !== null && (
        <p className="cn2b-approve__fingerprint" data-testid="cn2b-approve-fingerprint">
          <span className="cn2b-approve__fingerprint-label">{t('cn2b_approve_fingerprint', lang)}</span>{' '}
          <code dir="ltr" translate="no" data-testid="cn2b-approve-fingerprint-value">{fingerprint}</code>
        </p>
      )}

      {approved ? (
        <div className="cn2b-approve__approved" ref={confirmationRef} tabIndex={-1} data-testid="cn2b-approve-approved">
          <p className="cn2b-approve__approved-title">
            <PhoenixIcon name="check" size={15} inline aria-hidden="true" /> {t('cn2b_approve_approved_locally', lang)}
          </p>
          <p className="cn2b-approve__hint">{t('cn2b_approve_nothing_sent', lang)}</p>
        </div>
      ) : (
        <div className="cn2b-approve__actions">
          <PhoenixButton
            type="button"
            variant="primary"
            size="sm"
            disabled={!canApprove}
            aria-describedby={validation.blockers.length > 0 ? blockersId : undefined}
            onClick={approval.approve}
            data-testid="cn2b-approve-action"
          >
            {t('cn2b_approve_action', lang)}
          </PhoenixButton>
        </div>
      )}

      <details className="cn2b-approve__evidence" data-testid="cn2b-approve-evidence">
        <summary>{t('cn2b_approve_evidence', lang)}</summary>
        <pre dir="ltr" translate="no" data-testid="cn2b-approve-evidence-json">{canonicalJson}</pre>
      </details>
    </section>
  );
}
