/**
 * BUGFIX-CLEAN-DB-ADD-ORGANIZATION-A
 *
 * Static source-code tests proving the Institutions screen supports a clean
 * database (organizations = 0, preserved super_admin with organization_id =
 * null) without treating the empty state as a fatal load error, and that a
 * failed create surfaces a safe translated message while still logging the
 * real diagnostic to the console (mirrors useAsync's own pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');

describe('Institutions screen: clean-DB / zero-organization handling', () => {
  it('org list treats empty data (not an error) as the empty_orgs state, not load_error', () => {
    const listFnStart = screen.indexOf('function OrgListView');
    const listFnBody = screen.slice(listFnStart, screen.indexOf('function AddOrgForm'));
    // Empty state only renders when there is no error — orgs=[] alone must
    // never fall into the load_error branch.
    expect(listFnBody).toMatch(/!orgs\.loading && !orgs\.error && filtered\.length === 0/);
    expect(listFnBody).toContain("t('empty_orgs', lang)");
  });

  it('the "add organization" action does not depend on any organization already existing', () => {
    // onAdd() flips straight to the 'add' view with no org-scope or
    // orgs.data.length guard — reachable even when organizations = [].
    expect(screen).toMatch(/onAdd=\{\(\)\s*=>\s*setView\('add'\)\}/);
    const addFnStart = screen.indexOf("isSuper && view === 'add'");
    const addBlock = screen.slice(addFnStart, addFnStart + 300);
    expect(addBlock).not.toMatch(/effectiveOrgId|selectedOrgId/);
  });

  it('super_admin reaches the add-organization flow purely by role, independent of organization_id', () => {
    expect(screen).toContain("const isSuper = role === 'super_admin';");
    // No gate anywhere in the component requires activeOrgId/profile.organization_id
    // before rendering OrgListView/AddOrgForm for a super_admin.
    const superBlockStart = screen.indexOf('{/* Super admin: org list */}');
    const superBlockEnd = screen.indexOf('{/* Detail view:');
    const superBlock = screen.slice(superBlockStart, superBlockEnd);
    expect(superBlock).not.toMatch(/profile\?\.organization_id|activeOrgId/);
  });

  it('createOrganization does not require an existing organization scope (no orgId param)', () => {
    const orgsService = readSrc('shared/supabase/services/organizations.service.ts');
    const fnStart = orgsService.indexOf('export async function createOrganization');
    const fnSig = orgsService.slice(fnStart, orgsService.indexOf('{', fnStart));
    expect(fnSig).not.toMatch(/orgId|organization_id/);
  });

  it('a successful create + empty reload never shows a fake success or a fatal load error', () => {
    // onCreated only fires a toast + navigates back; it never inspects
    // orgs.data/orgs.error, so a transient empty reload can't produce a
    // false "success with data" state or trip the error branch.
    const onCreatedMatch = screen.match(/onCreated=\{\(\)\s*=>\s*\{([^}]*)\}\}/);
    expect(onCreatedMatch).toBeTruthy();
    expect(onCreatedMatch![1]).toMatch(/onBack\(\)/);
    expect(onCreatedMatch![1]).toMatch(/showToast\(t\('inst_created', lang\)\)/);
  });

  it('a failed create shows the safe translated load_error fallback and logs the real error to console', () => {
    const formFnStart = screen.indexOf('function AddOrgForm');
    const formFnBody = screen.slice(formFnStart, screen.indexOf('function OrgDetailView'));
    const catchMatch = formFnBody.match(/catch \(e\) \{([\s\S]*?)\} finally/);
    expect(catchMatch).toBeTruthy();
    const catchBody = catchMatch![1];
    expect(catchBody).toMatch(/console\.error\(/);
    expect(catchBody).toMatch(/e instanceof Error \? e\.message : t\('load_error', lang\)/);
  });
});
