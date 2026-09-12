#!/usr/bin/env node
/**
 * CN-2B CONFORMANCE (M212) — PostgREST EXACT-DECIMAL TRANSPORT PROOF.
 *
 * Extracted as its own module so the SAME code can be exercised two ways:
 * inside tools/e2e-acceptance/run.mjs (which CI's required authenticated
 * acceptance job runs) and directly against a disposable local Supabase stack
 * when only the transport needs proving. Local only — the caller's dbQuery and
 * the seed file are already guarded against any non-local address.
 *
 * Why this phase exists: the approved quantity is an UNCONSTRAINED PostgreSQL
 * numeric carried as a STRING through TypeScript, so no JavaScript float ever
 * sits in the middle. SQL tests prove the column; a mocked client proves the
 * component; neither can prove the TRANSPORT — that supabase-js -> Kong ->
 * PostgREST resolves this RPC and hands PostgreSQL the exact decimal.
 */

/**
 * @param {{ seed: any, record: (name: string, ok: boolean, detail?: string) => void,
 *          dbQuery: (sql: string, params?: unknown[]) => Promise<any>, root: string }} ctx
 */
export async function proveM212NumericTransport({ seed, record, dbQuery, root }) {
// ==========================================================================
// CN-2B CONFORMANCE (M212) — PostgREST EXACT-DECIMAL TRANSPORT PROOF.
//
// The need line's approved quantity is an UNCONSTRAINED PostgreSQL `numeric`,
// carried as a STRING through TypeScript so no JavaScript float ever sits in
// the middle. Everything above that claim was provable with SQL or with a
// mocked client; the one thing neither can prove is the TRANSPORT: that
// supabase-js -> Kong -> PostgREST actually resolves this RPC and hands
// PostgreSQL the exact decimal it was given.
//
// So this phase does it for real, against the disposable local stack, with a
// real signed-in user's JWT (never the service-role key as the authorization),
// and then reads back what the database actually stored. No Production
// database is involved, and none is needed.
// ==========================================================================
const cn = seed.centralNeeds;
if (!cn) {
  record('M212 PostgREST proof: the seed carries the Central Needs fixture', false,
    'seed.centralNeeds is missing — re-run tools/e2e-fixtures/seed.mjs');
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const apiUrl = seed.supabaseUrl ?? process.env.SUPABASE_URL;
  let anonKey = process.env.SUPABASE_ANON_KEY ?? null;
  if (!anonKey) {
    // `supabase status` is the same source the workflow itself reads the key
    // from, so this needs no new workflow wiring and no stored secret.
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('supabase', ['status', '-o', 'json'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      anonKey = JSON.parse(out).ANON_KEY ?? null;
    } catch (e) {
      anonKey = null;
    }
  }
  const localApi = typeof apiUrl === 'string' && /127\.0\.0\.1|localhost/.test(apiUrl);
  record('M212 PostgREST proof: a LOCAL API origin and anon key are available',
    Boolean(localApi && anonKey), localApi ? '' : `apiUrl=${apiUrl}`);

  if (localApi && anonKey) {
    // The anon key is the client's apikey — exactly what the browser app uses.
    const client = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error: signInError } = await client.auth.signInWithPassword({
      email: cn.editor.email, password: seed.password,
    });
    record('M212 PostgREST proof: the Central Needs editor signs in through real Auth',
      Boolean(session?.session?.access_token) && !signInError,
      signInError ? signInError.message : '');

    const call = (args) => client.rpc('phoenix_central_needs_set_need_line', args);
    const base = {
      p_plan_revision_id: cn.planRevisionId,
      p_beneficiary_organization_id: cn.beneficiaryOrganization,
      p_central_item_id: cn.centralItemId,
      p_mapping_reason: 'M212 PostgREST exact-decimal transport proof',
      p_approved_unit: 'box',
      p_unit_conversion_state: 'canonical',
      p_target_warehouse_id: null,
      p_source_unit_text: null,
    };

    // 1. A 4-decimal value, passed as a STRING, must survive byte for byte —
    //    this is the value the rejected numeric(20,3) design would have turned
    //    into 120.124.
    const exactRecord = cn.records['sheet:0:row:1::final'];
    const { data: exact, error: exactError } = await call({
      ...base,
      p_approved_quantity: '120.1239',
      p_quantity_sources: [
        { sourceRecordId: exactRecord, designatedQuantity: '120.1239', appliedOverrideId: null },
      ],
    });
    record('M212 PostgREST proof: the RPC resolves through PostgREST and commits',
      !exactError && Boolean(exact?.need_line_id),
      exactError ? `${exactError.code ?? ''} ${exactError.message}` : '');

    if (exact?.need_line_id) {
      const stored = await dbQuery(
        `SELECT approved_quantity::text AS q, scale(approved_quantity) AS s
           FROM central_needs_need_lines WHERE id = $1`, [exact.need_line_id]);
      const row = stored?.rows?.[0];
      record('M212 PostgREST proof: PostgreSQL stored the exact decimal, unrounded',
        row?.q === '120.1239' && Number(row?.s) === 4, `stored=${row?.q} scale=${row?.s}`);
      record('M212 PostgREST proof: it is NOT the value a declared scale would have produced',
        row?.q !== '120.124', `stored=${row?.q}`);
      record('M212 PostgREST proof: the RPC returns the quantity as an exact string',
        exact.approved_quantity === '120.1239', `returned=${exact.approved_quantity}`);
      const link = await dbQuery(
        `SELECT designated_quantity::text AS q FROM central_needs_need_line_sources
          WHERE need_line_id = $1`, [exact.need_line_id]);
      record('M212 PostgREST proof: the designated contribution is stored just as exactly',
        link?.rows?.[0]?.q === '120.1239', `stored=${link?.rows?.[0]?.q}`);
    }

    // 2. The float trap itself: 0.1 + 0.2 is 0.30000000000000004 in IEEE-754.
    //    Sent as strings and summed by PostgreSQL, the line must be exactly 0.3.
    const { data: sum, error: sumError } = await call({
      ...base,
      p_approved_quantity: '0.3',
      p_quantity_sources: [
        { sourceRecordId: cn.records['sheet:0:row:2::final'], designatedQuantity: '0.1', appliedOverrideId: null },
        { sourceRecordId: cn.records['sheet:0:row:3::final'], designatedQuantity: '0.2', appliedOverrideId: null },
      ],
    });
    record('M212 PostgREST proof: two exact decimals sum to exactly 0.3 server-side',
      !sumError && Boolean(sum?.need_line_id),
      sumError ? `${sumError.code ?? ''} ${sumError.message}` : '');
    if (sum?.need_line_id) {
      const stored = await dbQuery(
        `SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE id = $1`,
        [sum.need_line_id]);
      record('M212 PostgREST proof: the stored sum is 0.3, not 0.30000000000000004',
        stored?.rows?.[0]?.q === '0.3', `stored=${stored?.rows?.[0]?.q}`);
    }

    // 3. A float-shaped total is REFUSED, which is what proves the server
    //    re-derives the sum rather than trusting the number it was handed.
    const { error: driftError } = await call({
      ...base,
      p_approved_quantity: String(0.1 + 0.2), // '0.30000000000000004'
      p_quantity_sources: [
        { sourceRecordId: cn.records['sheet:0:row:2::final'], designatedQuantity: '0.1', appliedOverrideId: null },
        { sourceRecordId: cn.records['sheet:0:row:3::final'], designatedQuantity: '0.2', appliedOverrideId: null },
      ],
    });
    record('M212 PostgREST proof: a float-drifted total is refused, not silently accepted',
      /need_line_quantity_provenance_mismatch/.test(driftError?.message ?? ''),
      driftError?.message ?? 'no error raised');

    // 4. Authorization is live on this path: the apikey is not the authority,
    //    the user's JWT is. An outlet officer holds no central_needs.edit.
    const officer = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: officerSignIn } = await officer.auth.signInWithPassword({
      email: seed.users.outletOfficerA.email, password: seed.password,
    });
    const { error: deniedError } = await officer.rpc('phoenix_central_needs_set_need_line', {
      ...base,
      p_approved_quantity: '1',
      p_quantity_sources: [
        { sourceRecordId: exactRecord, designatedQuantity: '1', appliedOverrideId: null },
      ],
    });
    record('M212 PostgREST proof: an unauthorized signed-in user is refused on the same path',
      !officerSignIn && Boolean(deniedError),
      deniedError ? `${deniedError.code ?? ''} ${deniedError.message}` : 'no error raised');
  }
}

}
