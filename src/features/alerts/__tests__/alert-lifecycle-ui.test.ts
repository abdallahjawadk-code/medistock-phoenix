import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const screen = readFileSync(join(SRC, 'features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
const strings = readFileSync(join(SRC, 'shared/i18n/strings.ts'), 'utf8');

describe('InterInstitutionAlertsScreen lifecycle wiring', () => {
  it('uses only the lifecycle service as its primary alert source', () => {
    expect(screen).toContain('getLiveInterInstitutionAlertsWithState');
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
