import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const screen = readFileSync(join(SRC, 'features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
const strings = readFileSync(join(SRC, 'shared/i18n/strings.ts'), 'utf8');

describe('InterInstitutionAlertsScreen lifecycle wiring', () => {
  // ALERT-CQRS-BOUNDARY-190 (G4.1): the screen no longer reads through the
  // write-capable hybrid wrapper. Its load is an explicit refresh COMMAND
  // followed by a PURE page query; the lifecycle transition and history
  // wrappers are unchanged.
  it('uses only the lifecycle service as its primary alert source', () => {
    expect(screen).toContain('refreshInterOrgAlertLifecycle');
    expect(screen).toContain('queryLiveInterOrgAlertsPage');
    expect(screen).not.toContain("from './live-inter-institution-alerts.service'");
    expect(screen).toContain('updateInterOrgAlertState');
    expect(screen).toContain('reopenInterOrgAlert');
    expect(screen).toContain('getInterOrgAlertEvents');
  });

  it('renders lifecycle status and status-specific actions', () => {
    expect(screen).toContain('a.lifecycleStatus');
    expect(screen).toContain("a.lifecycleStatus === 'open'");
    expect(screen).toContain("a.lifecycleStatus === 'acknowledged'");
    expect(screen).toContain("a.lifecycleStatus === 'in_progress'");
    expect(screen).toContain("['resolved', 'dismissed']");
    for (const key of ['acknowledge', 'startProcessing', 'resolve', 'dismiss', 'reopen', 'viewHistory']) {
      expect(screen).toContain(`alertLifecycle_action_${key}`);
    }
  });

  it('requires reason only for dismiss, resolve, and reopen targets', () => {
    expect(screen).toMatch(/action\?\.to === 'resolved'.*action\?\.to === 'dismissed'.*action\?\.to === 'open'/);
    expect(screen).toContain('alertLifecycle_modal_reasonRequired');
  });

  it('submits lifecycle actions and refreshes the list', () => {
    expect(screen).toContain('await updateInterOrgAlertState');
    expect(screen).toContain('await reopenInterOrgAlert');
    expect(screen).toContain('result.reload()');
  });

  it('loads and renders history event fields without internal identifiers', () => {
    for (const field of ['eventType', 'actorNameSnapshot', 'actorEmailSnapshot', 'actorRoleSnapshot', 'fromStatus', 'toStatus', 'reason', 'notes', 'createdAt']) {
      expect(screen).toContain(`event.${field}`);
    }
    expect(screen).not.toMatch(/event\.(id|alert_state_id|actor_id)/);
  });

  it('renders the source and target institution flow from the lifecycle payload', () => {
    expect(screen).toContain('a.sourceOrganizationName');
    expect(screen).toContain('a.targetOrganizationName');
    expect(screen).toContain('a.sourceDistributionPointName');
    expect(screen).toContain('a.targetDistributionPointName');
    expect(screen).toContain('alertLifecycle_institution_sourceInstitution');
    expect(screen).toContain('alertLifecycle_institution_targetInstitution');
    expect(screen).toContain('alertLifecycle_institution_sourcePoint');
    expect(screen).toContain('alertLifecycle_institution_targetPoint');
    expect(screen).toContain('common_notSpecified');
    expect(screen).toContain('institution-flow');
  });

  it('keeps lifecycle controls and history in responsive premium presentation classes', () => {
    expect(screen).toContain('premium-action-bar');
    expect(screen).toContain('premium-action-button');
    expect(screen).toContain('premium-field');
    expect(screen).toContain('history-timeline');
    expect(screen).toContain('history-event');
  });

  it('contains all bilingual lifecycle labels and friendly errors', () => {
    for (const key of ['status_open', 'status_acknowledged', 'status_in_progress', 'status_resolved', 'status_dismissed', 'error_notAuthenticated', 'error_forbidden', 'error_invalidTransition']) {
      expect(strings).toContain(`alertLifecycle_${key}:`);
    }
  });

  it('does not directly access lifecycle tables or restricted capabilities', () => {
    expect(screen).not.toMatch(/supabase\.from\(['"]inter_org_alert_(states|events)['"]\)/);
    expect(screen).not.toContain('supply_type');
    expect(screen).not.toMatch(/service_role|auth\.admin|xlsx|exceljs|papaparse/i);
    expect(screen).not.toContain('phoenix_apply_availability_movement');
  });
});
