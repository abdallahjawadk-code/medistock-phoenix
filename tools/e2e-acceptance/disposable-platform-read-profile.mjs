/** Integration profile ONLY. The accepted annual seal excludes every non-root
 * direct reader, including these Supabase platform roles. This profile never
 * establishes hosted compatibility or authorizes a hosted role change. */
import assert from 'node:assert/strict';
import pg from 'pg';

export async function prepareDisposablePlatformReadProfile(databaseUrl, expectedSystemIdentifier) {
  const url = new URL(databaseUrl);
  assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '54322');
  assert.equal(url.username, 'postgres'); assert.equal(url.pathname, '/postgres');
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  // Same disposable cluster's internal administrator owns the platform grants.
  // The generated local password stays in memory; no env or credentials saved.
  url.username = 'supabase_admin';
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const roles = ['supabase_etl_admin', 'supabase_read_only_user'];
  try {
    await admin.connect();
    const { rows: [identity] } = await admin.query(`SELECT current_database() database,current_user actor,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,
      (SELECT system_identifier::text FROM pg_control_system()) system_identifier`);
    assert.equal(identity.database, 'postgres'); assert.equal(identity.actor, 'supabase_admin');
    assert.equal(identity.superuser, true); assert.equal(identity.system_identifier, expectedSystemIdentifier);
    const memberships = await admin.query(`SELECT m.rolname member,g.rolname granted_role,grantor.rolname grantor,
      a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles m ON m.oid=a.member
      JOIN pg_roles g ON g.oid=a.roleid JOIN pg_roles grantor ON grantor.oid=a.grantor
      WHERE m.rolname=ANY($1::text[]) AND g.rolname='pg_read_all_data' ORDER BY m.rolname`, [roles]);
    assert.equal(memberships.rowCount, 2);
    assert(memberships.rows.every(r => r.grantor === 'supabase_admin' && r.admin_option === false
      && r.inherit_option === true && r.set_option === true));
    await admin.query('BEGIN');
    try {
      await admin.query('REVOKE pg_read_all_data FROM supabase_etl_admin,supabase_read_only_user');
      const { rows } = await admin.query(`SELECT rolname,pg_has_role(oid,'pg_read_all_data','MEMBER') member
        FROM pg_roles WHERE rolname=ANY($1::text[])`, [roles]);
      assert.equal(rows.length, 2); assert(rows.every(r => r.member === false));
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    return { name: 'hardened disposable integration profile', removedReadAllMemberships: memberships.rows,
      productionCompatibility: 'HOLD: measured hosted platform grants conflict with unchanged annual seal',
      hostedRolesChanged: false };
  } finally { await admin.end(); }
}
