import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveCentralNeedsStageProgress,
  recommendedCentralNeedsStage,
  summarizeSessionBlockers,
} from '../CentralNeedsWorkspaceState';

const base = {
  planRevisionId: 'rev-1',
  status: 'draft' as const,
};

describe('UX-3R Package B stage progress', () => {
  it('never paints later stages complete when there is no authoritative import', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, ready: false, blockers: [{ blocker: 'no_finalized_import', detail: null }] },
    });
    expect(progress.source).toBe('needs-action');
    expect(progress.review).toBe('waiting');
    expect(progress.beneficiaries).toBe('waiting');
    expect(progress['need-lines']).toBe('waiting');
    expect(recommendedCentralNeedsStage(true, progress)).toBe('source');
  });

  it('fails closed when the server introduces an unknown blocker', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, ready: false, blockers: [{ blocker: 'future_server_blocker', detail: 'x' }] },
    });
    // v1.0.2 §6.3 rule 2 — "every other stage that would otherwise be complete
    // becomes ؟ غير معروفة". No blocker here is mapped, so all four stages
    // would otherwise have been complete and all four must fail closed. A
    // dependency `waiting` would CONCEAL the unknown behind a benign state.
    expect(progress.source).toBe('unknown');
    expect(progress.review).toBe('unknown');
    expect(progress.beneficiaries).toBe('unknown');
    expect(progress['need-lines']).toBe('unknown');
    expect(progress.readiness).toBe('not-ready');
    expect(recommendedCentralNeedsStage(true, progress)).toBe('readiness');
  });

  it('keeps a known blocker actionable even when an unknown blocker is also present', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: {
        ...base,
        ready: false,
        blockers: [
          { blocker: 'no_finalized_import', detail: null },
          { blocker: 'future_server_blocker', detail: 'x' },
        ],
      },
    });
    expect(progress.source).toBe('needs-action');
    expect(progress.review).toBe('waiting');
    expect(progress.beneficiaries).toBe('waiting');
    expect(progress['need-lines']).toBe('waiting');
    expect(recommendedCentralNeedsStage(true, progress)).toBe('source');
  });

  it('turns a would-be-complete earlier stage unknown while a later known blocker stays actionable', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: {
        ...base,
        ready: false,
        blockers: [
          { blocker: 'target_entity_without_disposition', detail: 'session=s1 target_entity=r1' },
          { blocker: 'future_server_blocker', detail: 'x' },
        ],
      },
    });
    // §6.3 rule 2 — Source would otherwise be ✓, so the unknown claims it.
    // Review keeps its own mapped blocker, and the stages behind Review keep
    // the dependency state the mapped chain already gave them.
    expect(progress.source).toBe('unknown');
    expect(progress.review).toBe('needs-action');
    expect(progress.beneficiaries).toBe('waiting');
    expect(progress['need-lines']).toBe('waiting');
    expect(recommendedCentralNeedsStage(true, progress)).toBe('review');
  });

  it('never lets a dependency waiting state conceal an unknown blocker', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, ready: false, blockers: [{ blocker: 'unmapped_future_code', detail: null }] },
    });
    // The regression this guards: driving the dependency chain from the UNKNOWN
    // state itself repainted stages 3–5 as `○ تنتظر` — a state that reads as
    // "nothing to see here" while the server is reporting a blocker this build
    // cannot interpret.
    expect(Object.values(progress).filter((state) => state === 'waiting')).toHaveLength(0);
    for (const stage of ['source', 'review', 'beneficiaries', 'need-lines'] as const) {
      expect(progress[stage], `${stage} must fail closed under an unknown blocker`).toBe('unknown');
    }
  });

  it('keeps the dependency chain intact when every blocker is mapped', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: {
        ...base,
        ready: false,
        blockers: [{ blocker: 'beneficiary_column_review_required', detail: 'session=s1 sheet=0 column=5' }],
      },
    });
    // Rules 3–5 with no unknown in play: everything before the blocked stage is
    // genuinely complete, everything after it waits on a real prerequisite.
    expect(progress.source).toBe('complete');
    expect(progress.review).toBe('complete');
    expect(progress.beneficiaries).toBe('needs-action');
    expect(progress['need-lines']).toBe('waiting');
    expect(recommendedCentralNeedsStage(true, progress)).toBe('beneficiaries');
  });

  it('uses the Stage 6 not-ready vocabulary for a blocked draft', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, ready: false, blockers: [{ blocker: 'target_entity_without_disposition', detail: 'session=s1 target_entity=r1' }] },
    });
    expect(progress.readiness).toBe('not-ready');
  });

  it('separates submitted/approved readiness from stage navigation state', () => {
    const submitted = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'submitted',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, status: 'submitted', ready: true, blockers: [] },
    });
    expect(submitted.readiness).toBe('submitted');

    const approved = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'approved',
      revisionDataReady: true,
      refreshing: false,
      readiness: { ...base, status: 'approved', ready: true, blockers: [] },
    });
    expect(approved.readiness).toBe('approved');
  });

  it('suppresses stale completion while a revision readback is in flight', () => {
    const progress = deriveCentralNeedsStageProgress({
      hasRevision: true,
      revisionStatus: 'draft',
      revisionDataReady: true,
      refreshing: true,
      readiness: { ...base, ready: true, blockers: [] },
    });
    expect(progress.source).toBe('refreshing');
    expect(progress.review).toBe('refreshing');
    expect(progress.readiness).toBe('refreshing');
  });

  it('attributes only server-emitted session identifiers and reports the rest', () => {
    const summary = summarizeSessionBlockers({
      ...base,
      ready: false,
      blockers: [
        { blocker: 'target_entity_without_disposition', detail: 'session=s1 target_entity=r1' },
        { blocker: 'beneficiary_column_review_required', detail: 'session=s1 sheet=0 column=5' },
        { blocker: 'mapped_target_entity_without_need_line', detail: 'session=s2 target_entity=r2' },
        { blocker: 'target_entity_without_disposition', detail: 'target_entity=missing-session' },
        { blocker: 'need_line_unit_conversion_required', detail: 'need_line=n1' },
      ],
    });
    expect(summary.bySession.get('s1')).toBe(2);
    expect(summary.bySession.get('s2')).toBe(1);
    expect(summary.unattributed).toBe(1);
  });
});

describe('UX-3R Package B shell contract', () => {
  const root = join(__dirname, '..', '..', '..', '..');
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

  it('keeps stage choice separate from progress and hides inactive mounted wrappers', () => {
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const nav = read('src/features/central-needs/CentralNeedsWorkflowNav.tsx');
    // §7.2 - the wrappers stay MOUNTED and hidden, and nothing is painted
    // at all until the initial stage selection is decided, so Stage 1 is never
    // shown and then replaced.
    expect(screen).toContain("hidden={!initialStageResolved || stage.id !== activeStage}");
    expect(screen).toContain('className="cn2b-workspace-loading cn2b-hint"');
    expect(nav).toContain("aria-current={isActive ? 'step' : undefined}");
    expect(nav).toContain('data-progress={progress}');
    expect(nav).not.toContain('scrollIntoView');
  });

  it('names the workspace loading state with the revision noun, never the review noun (v1.0.2 §17)', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const line = strings.split('\n').find((entry) => /^\s*cn2b_workspace_loading:/.test(entry));
    expect(line, 'cn2b_workspace_loading must exist').toBeDefined();
    // §17: revision = الإصدار. "Do not use «المراجعة» as the revision noun."
    expect(line).toContain('الإصدار');
    expect(line).not.toContain('المراجعة');
    // Every §7.2 loading surface Package B added uses it: the guidance strip and
    // the workspace placeholder in the screen, and the mobile stage toggle.
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const nav = read('src/features/central-needs/CentralNeedsWorkflowNav.tsx');
    expect(screen.match(/t\('cn2b_workspace_loading', lang\)/g) ?? []).toHaveLength(2);
    expect(nav).toContain("t('cn2b_workspace_loading', lang)");
  });

  it('guards the shared Work Session without inventing autosave', () => {
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    expect(screen).toContain("t('cn2b_work_session_change_confirm', lang)");
    expect(screen).toContain('reviewActivity.dirty || needLineActivity.dirty');
    expect(screen).toContain('reviewActivity.busy');
    expect(screen).toContain('needLineActivity.busy');
    expect(screen).toContain("searchBatchEntries(id, '', 500).catch(() => [])");
    expect(screen.toLowerCase()).not.toContain('autosave');
  });

  it('resets only the correct child-local draft state at revision/session boundaries', () => {
    const review = read('src/features/central-needs/CentralNeedsDispositionTable.tsx');
    const beneficiary = read('src/features/central-needs/CentralNeedsBeneficiaryColumnPanel.tsx');
    const needLines = read('src/features/central-needs/CentralNeedsNeedLinePanel.tsx');
    expect(review).toContain('}, [importSessionId]);');
    expect(beneficiary).toContain('}, [planRevisionId]);');
    expect(beneficiary).not.toContain('workSessionId');
    expect(needLines).toContain('}, [planRevisionId, workSessionId]);');
  });

  it('keeps frozen business-service surfaces out of Package B', () => {
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const helper = read('src/features/central-needs/CentralNeedsWorkspaceState.ts');
    expect(screen).not.toContain("from '@/shared/supabase/client'");
    expect(helper).not.toContain('supabase');
    expect(helper).not.toContain('myPermissions');
  });
});
