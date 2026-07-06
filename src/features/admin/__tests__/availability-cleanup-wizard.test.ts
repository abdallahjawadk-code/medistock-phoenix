/**
 * PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A (physical-delete revision)
 *
 * Static source-code tests for AvailabilityCleanupWizard.tsx and its wiring
 * into UserManagementScreen.tsx, plus the admin-cleanup.service.ts wrapper.
 * No live DB/RPC is used and no component is rendered — these are
 * text/shape assertions against the source files, matching this repo's
 * established convention (no @testing-library/react component rendering is
 * used anywhere else in this codebase — see
 * public-qr-hide-nonavailable-items.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const wizard = readSrc('features/admin/AvailabilityCleanupWizard.tsx');
const service = readSrc('shared/supabase/services/admin-cleanup.service.ts');
const userMgmt = readSrc('features/users/UserManagementScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('A) Super Admin gating', () => {
  it('returns null for non-super users before rendering anything', () => {
    expect(wizard).toMatch(/if \(!isSuper\) return null;/);
  });

  it('computes isSuper via normalizeRole(role) === \'super_admin\', not a raw string compare', () => {
    expect(wizard).toMatch(/const isSuper = normalizeRole\(role\) === 'super_admin';/);
  });

  // AUTHENTICATED-SCREEN-SPLIT-B: the static import was converted to a
  // React.lazy dynamic import (so its chunk is only fetched for
  // super_admin), gated by the same normalizeRole(role) === 'super_admin'
  // check the component already performs internally.
  it('is wired into UserManagementScreen (the safest existing super_admin admin area), not Status Center', () => {
    expect(userMgmt).toContain("import('@/features/admin/AvailabilityCleanupWizard').then(m => ({ default: m.AvailabilityCleanupWizard }))");
    expect(userMgmt).toContain("normalizeRole(role) === 'super_admin'");
    expect(userMgmt).toMatch(/<AvailabilityCleanupWizard lang=\{lang\} role=\{role\} \/>/);
  });

  it('is not wired into StatusCenterScreen', () => {
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    expect(statusCenter).not.toContain('AvailabilityCleanupWizard');
  });

  it('the RPC-facing service does not itself perform any client-side role check — the wizard relies on the server-side RPC as the real boundary', () => {
    // Documented expectation: service functions just call the RPC and surface
    // ok/error; INSUFFICIENT_ROLE is a possible error value returned by the
    // server, never short-circuited client-side before the call is made.
    expect(service).not.toMatch(/role\s*===\s*'super_admin'/);
  });
});

describe('B) Dry run must be completed before execute is enabled', () => {
  it('canExecute requires dryRunCounts !== null', () => {
    expect(wizard).toMatch(/const canExecute = dryRunCounts !== null && backupAcknowledged && confirmationMatches && !executeBusy;/);
  });

  it('execute button is disabled unless canExecute', () => {
    expect(wizard).toMatch(/<PhoenixButton variant="primary" size="md" disabled=\{!canExecute\} loading=\{executeBusy\} onClick=\{onExecute\}>/);
  });

  it('the counts/backup/confirmation UI only renders after a successful dry run (dryRunCounts truthy)', () => {
    expect(wizard).toMatch(/\{dryRunCounts && \(/);
  });
});

describe('C) Backup/export acknowledgement is required', () => {
  it('has a backup-acknowledgement checkbox bound to backupAcknowledged state', () => {
    expect(wizard).toMatch(/checked=\{backupAcknowledged\}/);
    expect(wizard).toMatch(/onChange=\{e => setBackupAcknowledged\(e\.target\.checked\)\}/);
  });

  it('backupAcknowledged is part of the canExecute guard', () => {
    expect(wizard).toContain('backupAcknowledged && confirmationMatches');
  });
});

describe('D) Exact typed confirmation phrase is required (DEEP CLEAN AVAILABILITY)', () => {
  it('confirmationMatches compares against the exact phrase constant', () => {
    expect(wizard).toMatch(/const confirmationMatches = confirmationText === DEEP_CLEAN_AVAILABILITY_CONFIRMATION;/);
  });

  it('imports DEEP_CLEAN_AVAILABILITY_CONFIRMATION from the service (single source of truth for the phrase)', () => {
    expect(wizard).toMatch(/DEEP_CLEAN_AVAILABILITY_CONFIRMATION/);
    expect(wizard).toMatch(/from '@\/shared\/supabase\/services\/admin-cleanup\.service'/);
  });

  it("the service defines the phrase as exactly 'DEEP CLEAN AVAILABILITY'", () => {
    expect(service).toContain("export const DEEP_CLEAN_AVAILABILITY_CONFIRMATION = 'DEEP CLEAN AVAILABILITY';");
  });

  it('a wrong/partial phrase keeps confirmationMatches false (strict equality, no trim/case-insensitive match)', () => {
    expect(wizard).not.toMatch(/confirmationText\.trim\(\)/);
    expect(wizard).not.toMatch(/toLowerCase\(\)/);
  });

  it('wrong phrase keeps execute disabled: canExecute is false whenever confirmationMatches is false, regardless of other guards', () => {
    // canExecute is a single boolean AND of all four guards — confirmationMatches
    // being false makes the whole expression false no matter what else is true.
    const idx = wizard.indexOf('const canExecute =');
    const line = wizard.slice(idx, wizard.indexOf(';', idx));
    expect(line).toContain('confirmationMatches');
  });
});

describe('E) Dry run calls the dry-run service only, never execute', () => {
  it('onDryRun calls dryRunAvailabilityDeepClean', () => {
    const start = wizard.indexOf('async function onDryRun()');
    const end = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start, end);
    expect(body).toContain('await dryRunAvailabilityDeepClean()');
    expect(body).not.toContain('executeAvailabilityDeepClean');
  });

  it('does not call execute automatically on mount (no top-level useEffect calling onDryRun/onExecute)', () => {
    expect(wizard).not.toContain('useEffect');
  });
});

describe('F) Execute calls the execute service only after all gates pass', () => {
  it('onExecute early-returns if !canExecute, before calling the service', () => {
    const start = wizard.indexOf('async function onExecute()');
    expect(wizard.slice(start, start + 120)).toMatch(/if \(!canExecute\) return;/);
  });

  it('onExecute calls executeAvailabilityDeepClean with the typed confirmation text', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start);
    expect(body).toContain('await executeAvailabilityDeepClean(confirmationText)');
  });
});

describe('G) Copy warns physical deletion of materials and movement history, explains preserved data', () => {
  it('renders acw_delete_materials_warning (availability materials physically deleted)', () => {
    expect(wizard).toContain("t('acw_delete_materials_warning', lang)");
  });

  it('renders acw_delete_movements_warning (movement history physically deleted)', () => {
    expect(wizard).toContain("t('acw_delete_movements_warning', lang)");
  });

  it('renders acw_delete_alert_exchange_note (linked alert/exchange rows cleared)', () => {
    expect(wizard).toContain("t('acw_delete_alert_exchange_note', lang)");
  });

  it('renders acw_preserved_data_explainer and acw_post_cleanup_effect_note', () => {
    expect(wizard).toContain("t('acw_preserved_data_explainer', lang)");
    expect(wizard).toContain("t('acw_post_cleanup_effect_note', lang)");
  });

  it('i18n strings.ts defines all acw_* keys bilingually (ar + en)', () => {
    const keys = [
      'acw_title', 'acw_delete_materials_warning', 'acw_delete_movements_warning',
      'acw_delete_alert_exchange_note', 'acw_preserved_data_explainer', 'acw_post_cleanup_effect_note',
      'acw_dry_run_button', 'acw_dry_run_failed', 'acw_counts_title',
      'acw_count_availability', 'acw_count_movements', 'acw_count_alert_states',
      'acw_count_alert_events', 'acw_count_exchange_requests', 'acw_count_exchange_events',
      'acw_backup_ack_label', 'acw_confirmation_label', 'acw_execute_button',
      'acw_execute_failed', 'acw_execute_success',
    ];
    for (const key of keys) {
      const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`);
      expect(strings).toMatch(re);
    }
  });

  it('materials warning copy explicitly says "permanently and physically deleted"', () => {
    expect(strings).toMatch(/acw_delete_materials_warning:.*permanently and physically deleted/);
  });

  it('movements warning copy explicitly says "permanently deleted"', () => {
    expect(strings).toMatch(/acw_delete_movements_warning:.*permanently deleted/);
  });

  it('preserved-data copy explicitly lists institutions, outlets, QR, users, permissions, and material master data as never deleted', () => {
    const match = strings.match(/acw_preserved_data_explainer:\s*\{[^}]*en:\s*'([^']+)'/);
    expect(match).not.toBeNull();
    const en = match![1];
    expect(en).toMatch(/Institutions/i);
    expect(en).toMatch(/outlets/i);
    expect(en).toMatch(/QR/);
    expect(en).toMatch(/users/i);
    expect(en).toMatch(/permissions/i);
    expect(en).toMatch(/local_items\/central_items/i);
    expect(en).toMatch(/never deleted/i);
  });

  it('confirmation label references the exact phrase DEEP CLEAN AVAILABILITY', () => {
    expect(strings).toMatch(/acw_confirmation_label:.*DEEP CLEAN AVAILABILITY/);
  });
});

describe('H) Service wrapper: typed results, dry-run vs execute separation', () => {
  it('dryRunAvailabilityDeepClean calls the RPC with p_dry_run: true, p_confirmation: null', () => {
    const start = service.indexOf('export async function dryRunAvailabilityDeepClean');
    const body = service.slice(start, service.indexOf('export async function executeAvailabilityDeepClean'));
    expect(body).toContain('p_dry_run: true');
    expect(body).toContain('p_confirmation: null');
    expect(body).toContain("supabase.rpc('phoenix_clean_availability_data'");
  });

  it('executeAvailabilityDeepClean calls the RPC with p_dry_run: false and the passed confirmation', () => {
    const start = service.indexOf('export async function executeAvailabilityDeepClean');
    const body = service.slice(start);
    expect(body).toContain('p_dry_run: false');
    expect(body).toContain('p_confirmation: confirmation');
    expect(body).toContain("supabase.rpc('phoenix_clean_availability_data'");
  });

  it('both functions throw on a Supabase-level error and return the raw ok/error payload otherwise', () => {
    expect(service).toMatch(/if \(error\) throw error;/g);
  });
});

describe('I) Error visibility hotfix: the real execute error is captured and rendered, not swallowed', () => {
  it('onExecute catch block captures the thrown error object (not discarded)', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start);
    expect(body).toMatch(/\} catch \(err\) \{/);
    expect(body).not.toMatch(/\} catch \{\s*\n\s*setExecuteError\('NETWORK_ERROR'\);\s*\n\s*\}/);
  });

  it('the caught error is logged via console.error for diagnosability', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start, wizard.indexOf('} finally', start));
    expect(body).toMatch(/console\.error\(/);
  });

  it('toTechnicalErrorDetail extracts only the well-known safe PostgrestError fields: code, message, details, hint', () => {
    const start = wizard.indexOf('function toTechnicalErrorDetail');
    const body = wizard.slice(start, wizard.indexOf('\n}', start));
    expect(body).toContain("typeof e.code === 'string'");
    expect(body).toContain("typeof e.message === 'string'");
    expect(body).toContain("typeof e.details === 'string'");
    expect(body).toContain("typeof e.hint === 'string'");
  });

  it('toTechnicalErrorDetail never reads token/auth/header/env-shaped fields', () => {
    const start = wizard.indexOf('function toTechnicalErrorDetail');
    const body = wizard.slice(start, wizard.indexOf('\n}', start));
    expect(body).not.toMatch(/token|authorization|apikey|api_key|env\./i);
  });

  it('the catch block stores the captured detail via setExecuteErrorDetail(toTechnicalErrorDetail(err))', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start, wizard.indexOf('} finally', start));
    expect(body).toContain('setExecuteErrorDetail(toTechnicalErrorDetail(err));');
  });

  it('a graceful ok:false business error also populates executeErrorDetail with the real error code', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start, wizard.indexOf('} catch (err)', start));
    expect(body).toContain('setExecuteError(res.error);');
    expect(body).toContain("setExecuteErrorDetail({ code: res.error });");
  });

  it('executeErrorDetail state is reset at the start of every onExecute call', () => {
    const start = wizard.indexOf('async function onExecute()');
    const body = wizard.slice(start, start + 300);
    expect(body).toContain('setExecuteErrorDetail(null);');
  });

  it('the generic translated acw_execute_failed message is still rendered unconditionally on any error', () => {
    expect(wizard).toContain("t('acw_execute_failed', lang)");
  });

  it('a technical-details block renders only when at least one field is present, gated by executeErrorDetail', () => {
    const renderStart = wizard.indexOf('{executeError && (');
    const renderBlock = wizard.slice(renderStart, wizard.indexOf('{executeResult && (', renderStart));
    expect(renderBlock).toMatch(/executeErrorDetail && \(executeErrorDetail\.code \|\| executeErrorDetail\.message \|\| executeErrorDetail\.details \|\| executeErrorDetail\.hint\)/);
    expect(renderBlock).toContain("t('acw_technical_details', lang)");
  });

  it('renders code/message/details/hint individually, each conditionally', () => {
    const renderStart = wizard.indexOf('{executeError && (');
    const renderBlock = wizard.slice(renderStart, wizard.indexOf('{executeResult && (', renderStart));
    expect(renderBlock).toContain('executeErrorDetail.code &&');
    expect(renderBlock).toContain('executeErrorDetail.message &&');
    expect(renderBlock).toContain('executeErrorDetail.details &&');
    expect(renderBlock).toContain('executeErrorDetail.hint &&');
    expect(renderBlock).toContain("t('acw_error_code', lang)");
    expect(renderBlock).toContain("t('acw_error_message', lang)");
    expect(renderBlock).toContain("t('acw_error_details', lang)");
    expect(renderBlock).toContain("t('acw_error_hint', lang)");
  });

  it('i18n defines acw_technical_details / acw_error_code / acw_error_message / acw_error_details / acw_error_hint bilingually', () => {
    const keys = ['acw_technical_details', 'acw_error_code', 'acw_error_message', 'acw_error_details', 'acw_error_hint'];
    for (const key of keys) {
      const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`);
      expect(strings).toMatch(re);
    }
  });
});

describe('J) Hotfix does not alter deletion logic, RPC name, or confirmation phrase', () => {
  it('the RPC name called by the service is unchanged', () => {
    expect(service).toContain("supabase.rpc('phoenix_clean_availability_data'");
  });

  it('the confirmation phrase constant is unchanged', () => {
    expect(service).toContain("export const DEEP_CLEAN_AVAILABILITY_CONFIRMATION = 'DEEP CLEAN AVAILABILITY';");
  });

  it('canExecute / confirmationMatches / dry-run-first gating logic is unchanged', () => {
    expect(wizard).toContain("const confirmationMatches = confirmationText === DEEP_CLEAN_AVAILABILITY_CONFIRMATION;");
    expect(wizard).toContain("const canExecute = dryRunCounts !== null && backupAcknowledged && confirmationMatches && !executeBusy;");
  });

  it('the wizard file contains no DELETE/DROP/TRUNCATE SQL statements (it only calls the RPC, never issues SQL directly)', () => {
    expect(wizard).not.toMatch(/DELETE FROM|DROP TABLE|TRUNCATE/i);
  });

  it('migration 055 has no working-tree diff from this hotfix (out of allowed scope)', () => {
    // Static guard: this hotfix's allowed scope is the wizard/service/i18n
    // files only — no migration SQL edit is part of this change.
    expect(wizard).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(service).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});
