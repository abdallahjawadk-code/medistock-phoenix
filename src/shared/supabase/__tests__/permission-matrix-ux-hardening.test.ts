/**
 * PERMISSION-MATRIX-UX-HARDENING-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the permission matrix is hidden by default in User Management
 * and only renders once the actor explicitly opens it for a selected user,
 * with self-edit and no-manage-permissions states clearly communicated —
 * while every server-side RPC check remains the real security boundary,
 * completely unaffected by this UI-only change. No live Supabase
 * connection is required — static source checks only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ============================================================================
// 1. Permission matrix hidden by default
// ============================================================================

describe('UserManagementScreen: permission matrix hidden by default', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('selecting a user renders UserPermissionsPanel, not the matrix directly', () => {
    expect(screen).toContain('<UserPermissionsPanel');
    const block = screen.slice(screen.indexOf('{selectedUser && ('), screen.indexOf('{selectedUser && (') + 400);
    expect(block).not.toContain('<PermissionMatrix');
  });

  it('UserPermissionsPanel only renders PermissionMatrix when its own "open" state is true', () => {
    const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));
    expect(panelBlock).toContain("const [open, setOpen] = useState(false);");
    expect(panelBlock).toContain('{open && (');
    expect(panelBlock).toContain('<PermissionMatrix');
  });

  it('the default (closed) state shows a hint that permissions are hidden until explicitly managed', () => {
    const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));
    expect(panelBlock).toContain('um_permissions_hidden_note');
  });

  it('the summary panel shows name, username, role, organization, and status', () => {
    const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));
    expect(panelBlock).toContain('userName(user)');
    expect(panelBlock).toContain('user.username');
    expect(panelBlock).toContain('statusVariant(user.status)');
    expect(panelBlock).toContain('roleLabelKey(user.role)');
    expect(panelBlock).toContain("t('um_organization', lang)");
  });
});

// ============================================================================
// 2. "Manage this user's permissions" button: gated correctly
// ============================================================================

describe('UserManagementScreen: manage-permissions button gating', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));

  it('the button only renders when canManage is true and the selected user is not the current actor', () => {
    expect(panelBlock).toContain('isSelf ? (');
    expect(panelBlock).toContain(': canManage ? (');
    expect(panelBlock).toContain("um_manage_user_permissions");
  });

  it('isSelf is computed by comparing the selected user id to the actor id', () => {
    expect(panelBlock).toContain('const isSelf = user.id === actorId;');
  });

  it('clicking the button opens the panel (sets open=true)', () => {
    expect(panelBlock).toContain('onClick={() => setOpen(true)}');
  });

  it('a "Hide permissions" button closes the panel without requiring a save', () => {
    expect(panelBlock).toContain('um_hide_permissions');
    expect(panelBlock).toContain('onClick={() => setOpen(false)}');
  });
});

// ============================================================================
// 3. Self-edit protection: no button, clear note instead
// ============================================================================

describe('UserManagementScreen: self-edit shows a note instead of the manage button', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));

  it('self-row shows the self-edit session note and never the manage button', () => {
    expect(panelBlock).toContain('um_perm_self_edit_session_note');
    // isSelf branches first in the ternary, before the canManage branch —
    // so the button is unreachable whenever isSelf is true, regardless of canManage.
    const isSelfIdx = panelBlock.indexOf('isSelf ? (');
    const buttonIdx = panelBlock.indexOf('um_manage_user_permissions');
    expect(isSelfIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(isSelfIdx);
  });

  it('i18n: self-edit session note matches the required exact wording', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('um_perm_self_edit_session_note');
    expect(strings).toContain('لا يمكنك تعديل صلاحيات حسابك الحالي من نفس الجلسة.');
    expect(strings).toContain('You cannot edit permissions for your current account from the same session.');
  });
});

// ============================================================================
// 4. Actor without users.manage_permissions: no checkboxes, optional note
// ============================================================================

describe('UserManagementScreen: actor without manage-permissions authority sees no checkboxes', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const panelBlock = screen.slice(screen.indexOf('function UserPermissionsPanel'), screen.indexOf('function InfoLine'));

  it('shows the no-manage-permissions note when canManage is false and not self', () => {
    expect(panelBlock).toContain('um_no_manage_permissions_note');
  });

  it('the matrix (and its checkboxes) is never mounted unless the panel is explicitly opened, which requires canManage to reach the button at all', () => {
    expect(panelBlock).toContain('{open && (');
    // The only way `open` becomes true is the button's onClick, and that
    // button only renders in the `canManage` branch of the ternary.
    const canManageIdx = panelBlock.indexOf(': canManage ? (');
    const setOpenTrueIdx = panelBlock.indexOf('setOpen(true)');
    expect(setOpenTrueIdx).toBeGreaterThan(canManageIdx);
  });

  it('i18n: no-manage-permissions note matches the required exact wording', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('um_no_manage_permissions_note');
    expect(strings).toContain('لا تملك صلاحية إدارة صلاحيات المستخدمين.');
    expect(strings).toContain('You do not have permission to manage user permissions.');
  });
});

// ============================================================================
// 5. Panel load/reload behavior
// ============================================================================

describe('PermissionMatrix: loads from DB when opened, reloads after save', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const matrixBlock = screen.slice(screen.indexOf('function PermissionMatrix'), screen.indexOf('function ContactSection'));

  it('fetches effective permissions via the DB-backed RPC service, not local/static defaults', () => {
    expect(matrixBlock).toContain('getEffectivePermissions(user.id)');
  });

  it('a successful save reloads from the DB (eff.reload())', () => {
    const onSaveBlock = matrixBlock.slice(matrixBlock.indexOf('async function onSave'), matrixBlock.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('eff.reload()');
  });

  it('a successful reset also reloads from the DB', () => {
    const onResetBlock = matrixBlock.slice(matrixBlock.indexOf('async function onReset'));
    expect(onResetBlock).toContain('eff.reload()');
  });

  it('the panel never auto-closes on save or reset — only the explicit Hide button closes it', () => {
    const onSaveBlock = matrixBlock.slice(matrixBlock.indexOf('async function onSave'), matrixBlock.indexOf('async function onReset'));
    expect(onSaveBlock).not.toContain('setOpen');
  });
});

// ============================================================================
// 6. Dangerous permission labels still visible inside the panel
// ============================================================================

describe('PermissionMatrix: dangerous permission warnings remain visible when editing', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const matrixBlock = screen.slice(screen.indexOf('function PermissionMatrix'), screen.indexOf('function ContactSection'));

  it('per-permission dangerous badge is still rendered', () => {
    expect(matrixBlock).toContain('isDangerousPermission(p.key)');
    expect(matrixBlock).toContain("t('um_dangerous', lang)");
  });

  it('a sensitive-permissions banner is shown whenever the actor can actually edit (not read-only)', () => {
    expect(matrixBlock).toContain('um_editing_sensitive_permissions');
    expect(matrixBlock).toContain('{!readOnly && (');
  });

  it('i18n: sensitive-permissions banner matches the required exact wording', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('um_editing_sensitive_permissions');
    expect(strings).toContain('أنت تقوم بتعديل صلاحيات حساسة لهذا المستخدم');
    expect(strings).toContain('You are editing sensitive permissions for this user');
  });
});

// ============================================================================
// 7. Optional search/filter inside the permission panel
// ============================================================================

describe('PermissionMatrix: optional permission search', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const matrixBlock = screen.slice(screen.indexOf('function PermissionMatrix'), screen.indexOf('function ContactSection'));

  it('has a search input filtering permissions by label or key', () => {
    expect(matrixBlock).toContain('permSearch');
    expect(matrixBlock).toContain("t('um_search_permissions', lang)");
  });

  it('i18n: search-permissions placeholder matches the required exact wording', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('um_search_permissions');
    expect(strings).toContain('بحث في الصلاحيات');
    expect(strings).toContain('Search permissions');
  });
});

// ============================================================================
// 8. Security: server-side rules unchanged, UI hiding is not relied upon as security
// ============================================================================

describe('Permission matrix UX hardening: security unchanged', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const migration017 = readPhoenix('supabase/migrations/017_phoenix_permission_rpc_42703_fix.sql');
  const migration018 = readPhoenix('supabase/migrations/018_phoenix_actor_snapshot_record_field_fix.sql');
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('this phase did not touch any permission RPC (010/017) or the actor snapshot trigger fix (018)', () => {
    expect(migration010).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(migration017).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(migration018).toContain('phoenix_populate_actor_snapshot');
  });

  it('the save/reset calls still go through the same RPC service functions — UI visibility changes do not bypass them', () => {
    expect(svc).toContain('export async function assignProfilePermissions');
    expect(svc).toContain('export async function resetProfilePermissions');
    expect(screen).toContain('assignProfilePermissions(user.id, overrides, actorHasManagePermissions)');
  });

  it('no service_role in frontend', () => {
    expect(svc).not.toContain('service_role');
    expect(screen).not.toContain('service_role');
  });

  it('no auth.admin in frontend', () => {
    expect(svc).not.toMatch(/auth\.admin/);
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('hard delete button is rendered, gated to super_admin and never self', () => {
    expect(screen).toContain('deleteTarget');
    expect(screen).toContain('um_delete_user_action');
    expect(screen).toContain('isSuper && !isSelf');
  });

  it('Data Reset still absent', () => {
    expect(screen).not.toMatch(/import.*DataReset/i);
  });

  it('Intake/OCR/Excel/DocIntel remain disabled', () => {
    expect(screen).not.toMatch(/import.*OcrImport/i);
    expect(screen).not.toMatch(/import.*ExcelImport/i);
    expect(screen).not.toMatch(/import.*DocIntel/i);
  });
});
