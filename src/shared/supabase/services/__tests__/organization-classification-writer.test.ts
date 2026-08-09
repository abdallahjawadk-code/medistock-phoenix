/**
 * STAGE-E-E7-2 — ORGANIZATION CLASSIFICATION WRITER CONTRACT.
 *
 * Behavioral tests over the REAL `createOrganization()` implementation,
 * capturing the exact row it sends to PostgREST. Deliberately NOT a
 * source-scan: the regression these guard against was invisible to the only
 * test that previously covered this flow
 * (features/institutions/__tests__/clean-db-first-organization.test.ts), which
 * string-matches InstitutionScreen.tsx and never executes the writer — so the
 * writer could omit a column the database requires and still look tested.
 *
 * THE REGRESSION, precisely: `createOrganization()` sent neither
 * `organization_kind` nor `institution_class`. Migration 164 added
 * institution_class, Migration 170 made it NOT NULL, and Migration 171
 * replaced that with a conditional CHECK that still requires a non-NULL class
 * for the default `care_institution` kind. Every call through this path
 * therefore failed at the database against a post-170 schema.
 *
 * The companion dynamic test
 * (supabase/migrations/__tests__/171-organization-classification-writer.dynamic.test.ts)
 * proves the SAME payloads against a real PostgreSQL rig, so this file's
 * captured shapes are known to be the shapes the database actually accepts —
 * neither test is sufficient alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

const captured: { table: string; row: Row }[] = [];

/**
 * Minimal insert-capturing PostgREST fake, in the same "behaviorally accurate
 * fake" spirit as custody-corrections-org-scope.test.ts. It records the row
 * actually sent and echoes it back through .select().single(), so the mapper's
 * own output is exercised too rather than stubbed.
 */
vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    from(table: string) {
      return {
        insert(row: Row) {
          captured.push({ table, row });
          return {
            select() {
              return {
                single: async () => ({
                  data: {
                    id: 'org-1',
                    name: row.name,
                    name_ar: row.name_ar,
                    code: row.code,
                    status: 'active',
                    city: row.city,
                    contact_email: row.contact_email,
                    organization_kind: row.organization_kind,
                    institution_class: row.institution_class,
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  },
}));

const { createOrganization } = await import('../organizations.service');

const BASE = { name: 'Babil General', name_ar: 'بابل العام', code: 'babil-main' };

beforeEach(() => { captured.length = 0; });

describe('createOrganization writes an explicit classification (Migrations 164/170/171)', () => {
  it('a care institution sends BOTH organization_kind and a real institution_class', async () => {
    await createOrganization({ ...BASE, organizationKind: 'care_institution', institutionClass: 'hospital' });

    expect(captured).toHaveLength(1);
    const row = captured[0].row;
    expect(captured[0].table).toBe('organizations');
    expect(row.organization_kind).toBe('care_institution');
    expect(row.institution_class).toBe('hospital');
  });

  it.each(['hospital', 'specialized_center', 'health_sector'] as const)(
    'passes institution_class %s through verbatim — no coercion, no sentinel',
    async (cls) => {
      await createOrganization({ ...BASE, organizationKind: 'care_institution', institutionClass: cls });
      expect(captured[0].row.institution_class).toBe(cls);
      expect(captured[0].row.organization_kind).toBe('care_institution');
    },
  );

  it('a pharmacy department authority sends institution_class explicitly NULL', async () => {
    await createOrganization({ ...BASE, organizationKind: 'pharmacy_department_authority' });

    const row = captured[0].row;
    expect(row.organization_kind).toBe('pharmacy_department_authority');
    // Explicit null — NOT undefined, which PostgREST would omit from the row
    // and which would then fall back to the column DEFAULT.
    expect(row.institution_class).toBeNull();
    expect(Object.keys(row)).toContain('institution_class');
  });

  it('NEVER relies on the organization_kind column DEFAULT — the key is always present', async () => {
    await createOrganization({ ...BASE, organizationKind: 'care_institution', institutionClass: 'hospital' });
    expect(Object.keys(captured[0].row)).toContain('organization_kind');
    expect(captured[0].row.organization_kind).toBeDefined();
  });

  it('rejects a care institution with no class BEFORE any database round trip', async () => {
    await expect(createOrganization(
      // Deliberately bypasses the compile-time union to prove the runtime
      // guard, since a stale caller or untyped JS could still reach here.
      { ...BASE, organizationKind: 'care_institution' } as never,
    )).rejects.toThrow('INSTITUTION_CLASS_REQUIRED');
    expect(captured).toHaveLength(0);
  });

  it('rejects a care institution with an unrecognised class before the round trip', async () => {
    await expect(createOrganization(
      { ...BASE, organizationKind: 'care_institution', institutionClass: 'health_centre' } as never,
    )).rejects.toThrow('INSTITUTION_CLASS_REQUIRED');
    expect(captured).toHaveLength(0);
  });

  it('rejects an authority that carries an institution_class before the round trip', async () => {
    await expect(createOrganization(
      { ...BASE, organizationKind: 'pharmacy_department_authority', institutionClass: 'hospital' } as never,
    )).rejects.toThrow('AUTHORITY_MUST_NOT_HAVE_INSTITUTION_CLASS');
    expect(captured).toHaveLength(0);
  });

  it('rejects an absent or unknown organization_kind rather than defaulting one', async () => {
    await expect(createOrganization({ ...BASE } as never))
      .rejects.toThrow('ORGANIZATION_KIND_REQUIRED');
    await expect(createOrganization({ ...BASE, organizationKind: 'clinic' } as never))
      .rejects.toThrow('ORGANIZATION_KIND_REQUIRED');
    expect(captured).toHaveLength(0);
  });

  it('returns the mapped row, carrying the classification back to the caller', async () => {
    const created = await createOrganization({
      ...BASE, organizationKind: 'care_institution', institutionClass: 'health_sector',
    });
    expect(created.organizationKind).toBe('care_institution');
    expect(created.institutionClass).toBe('health_sector');

    const authority = await createOrganization({
      ...BASE, organizationKind: 'pharmacy_department_authority',
    });
    expect(authority.organizationKind).toBe('pharmacy_department_authority');
    expect(authority.institutionClass).toBeNull();
  });
});
