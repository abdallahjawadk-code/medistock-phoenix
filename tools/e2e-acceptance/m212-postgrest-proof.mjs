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
 * PostgREST resolves these RPCs, hands PostgreSQL the exact decimal on the way
 * in, and hands TypeScript the exact decimal on the way back.
 *
 * CN-2B corrective (M213): the same transport also carries M213's change to
 * this shared RPC contract. A cell whose physical beneficiary column is
 * unresolved is refused as 23514 beneficiary_column_mapping_required; the
 * editor then records explicit BENEFICIARY decisions through
 * phoenix_central_needs_set_beneficiary_columns, and only then does the same
 * designation succeed. Both states are asserted here, so this module is also
 * regression protection for the M213 Finding-1 fix.
 */

/**
 * @param {{ seed: any, record: (name: string, ok: boolean, detail?: string) => void,
 *          dbQuery: (sql: string, params?: unknown[]) => Promise<any>, root: string }} ctx
 */
export async function proveM212NumericTransport({ seed, record, dbQuery, root }) {
// ==========================================================================
// CN-2B CONFORMANCE (M212) — PostgREST EXACT-DECIMAL TRANSPORT PROOF.
//
// Done for real, against the disposable local stack, with a real signed-in
// user's JWT (never the service-role key as the authorization), reading back
// both what the database stored and what supabase-js decoded. No Production
// database is involved, and none is needed.
// ==========================================================================
const cn = seed.centralNeeds;
if (!cn || !cn.columns) {
  record('M212 PostgREST proof: the seed carries the Central Needs fixture', false,
    !cn ? 'seed.centralNeeds is missing — re-run tools/e2e-fixtures/seed.mjs'
      : 'seed.centralNeeds.columns is missing — re-run tools/e2e-fixtures/seed.mjs (M213 physical columns)');
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

    const BIG = '12345678901234567.891';
    const BIG_PLUS = '12345678901234688.0149'; // BIG + 120.1239, exactly
    const RELINK_TOTAL = '12345678901234808.1388'; // BIG_PLUS + 120.1239, exactly
    const rec = (key) => cn.records[key];
    const set = (args) => client.rpc('phoenix_central_needs_set_need_line', args);
    const base = {
      p_plan_revision_id: cn.planRevisionId,
      p_central_item_id: cn.centralItemId,
      p_mapping_reason: 'M212 PostgREST exact-decimal transport proof',
      p_approved_unit: 'box',
      p_unit_conversion_state: 'canonical',
      p_target_warehouse_id: null,
      p_source_unit_text: null,
    };
    const scopeA = { ...base, p_beneficiary_organization_id: cn.beneficiaryOrganization };
    const scopeB = { ...base, p_beneficiary_organization_id: cn.secondBeneficiaryOrganization };
    const linkCount = async (lineId) => Number((await dbQuery(
      `SELECT count(*)::int AS n FROM central_needs_need_line_sources WHERE need_line_id = $1`, [lineId]))
      ?.rows?.[0]?.n);

    // 1. A 4-decimal value, passed as a STRING, must survive byte for byte —
    //    this is the value the rejected numeric(20,3) design would have turned
    //    into 120.124.
    const exactArgs = {
      ...scopeA,
      p_approved_quantity: '120.1239',
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:1::final'), designatedQuantity: '120.1239', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [],
    };
    const scopeLines = async (beneficiary) => Number((await dbQuery(
      `SELECT count(*)::int AS n FROM central_needs_need_lines
        WHERE plan_revision_id = $1 AND beneficiary_organization_id = $2`,
      [cn.planRevisionId, beneficiary]))?.rows?.[0]?.n);
    const mappingRows = async () => (await dbQuery(
      `SELECT column_index, decision, beneficiary_organization_id::text AS beneficiary,
              mapped_by::text AS mapped_by, source_field_name
         FROM central_needs_beneficiary_column_mappings
        WHERE import_session_id = $1 ORDER BY column_index`, [cn.importSessionId]))?.rows ?? [];

    // 1a. M213 NEGATIVE PROOF. Institution A's physical column has no review
    //     decision yet, so the SAME designation is refused before any cell is
    //     consumed — and nothing is written.
    const { data: unresolved, error: unresolvedError } = await set(exactArgs);
    const afterUnresolved = {
      lines: await scopeLines(cn.beneficiaryOrganization), mappings: (await mappingRows()).length,
    };
    record('M213 contract: an unresolved physical beneficiary column refuses designation as 23514 beneficiary_column_mapping_required',
      !unresolved && unresolvedError?.code === '23514'
        && unresolvedError?.message === 'beneficiary_column_mapping_required'
        && afterUnresolved.lines === 0 && afterUnresolved.mappings === 0,
      `${unresolvedError ? `${unresolvedError.code ?? ''} ${unresolvedError.message}` : 'no error raised'} `
        + `lines=${afterUnresolved.lines} mappings=${afterUnresolved.mappings}`);

    //     The decision cannot be manufactured by writing the mapping table
    //     directly, even by the editor who holds central_needs.edit.
    const directMapping = await client.from('central_needs_beneficiary_column_mappings').insert({
      plan_revision_id: cn.planRevisionId, organization_id: cn.owningOrganization,
      import_session_id: cn.importSessionId, sheet_index: cn.columns.institutionA.sheetIndex,
      column_index: cn.columns.institutionA.columnIndex, decision: 'beneficiary',
      beneficiary_organization_id: cn.beneficiaryOrganization, mapping_reason: 'M213 direct write attempt',
    });
    record('M213 contract: a direct INSERT into the column-mapping table is refused (42501) and records no decision',
      directMapping.error?.code === '42501' && (await mappingRows()).length === 0,
      `insert=${directMapping.error?.code ?? 'none'}`);

    // 1b. M213 CANONICAL RESOLUTION. The editor reviews both institution
    //     columns and records explicit BENEFICIARY decisions through the real
    //     RPC, stating the believed-current state (unresolved) and a reason.
    const columnDecision = (column, beneficiary) => ({
      importSessionId: cn.importSessionId,
      sheetIndex: column.sheetIndex,
      columnIndex: column.columnIndex,
      decision: 'beneficiary',
      beneficiaryOrganizationId: beneficiary,
      previousDecision: null,
      previousBeneficiaryOrganizationId: null,
    });
    const { data: confirmed, error: confirmError } = await client.rpc('phoenix_central_needs_set_beneficiary_columns', {
      p_plan_revision_id: cn.planRevisionId,
      p_mappings: [
        columnDecision(cn.columns.institutionA, cn.beneficiaryOrganization),
        columnDecision(cn.columns.institutionB, cn.secondBeneficiaryOrganization),
      ],
      p_mapping_reason: "E2E review: column C is institution A's annual requirement, column D is institution B's",
    });
    const confirmedCols = confirmed?.confirmed ?? [];
    const confirmedFor = (column) => confirmedCols.find((c) => c.columnIndex === column.columnIndex);
    record('M213 contract: the editor records explicit BENEFICIARY decisions for both institution columns through PostgREST',
      !confirmError && confirmed?.ok === true && confirmedCols.length === 2
        && confirmedCols.every((c) => c.decision === 'beneficiary' && c.created === true && c.changed === true)
        && confirmedFor(cn.columns.institutionA)?.beneficiaryOrganizationId === cn.beneficiaryOrganization
        && confirmedFor(cn.columns.institutionB)?.beneficiaryOrganizationId === cn.secondBeneficiaryOrganization,
      confirmError ? `${confirmError.code ?? ''} ${confirmError.message}` : JSON.stringify(confirmedCols));
    const storedMappings = await mappingRows();
    const auditedMappings = Number((await dbQuery(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action = 'central_needs.beneficiary_column.set'
          AND actor_id = $1 AND payload->>'plan_revision_id' = $2`,
      [cn.editor.id, cn.planRevisionId]))?.rows?.[0]?.n);
    record('M213 contract: the decisions persist by physical column, attributed to the editor and audited; the requested column stays unresolved',
      storedMappings.length === 2
        && storedMappings[0].column_index === cn.columns.institutionA.columnIndex
        && storedMappings[0].beneficiary === cn.beneficiaryOrganization
        && storedMappings[1].column_index === cn.columns.institutionB.columnIndex
        && storedMappings[1].beneficiary === cn.secondBeneficiaryOrganization
        && storedMappings.every((r) => r.decision === 'beneficiary' && r.mapped_by === cn.editor.id
          && r.source_field_name === 'final')
        && !storedMappings.some((r) => r.column_index === cn.columns.requested.columnIndex)
        && auditedMappings === 2,
      `rows=${JSON.stringify(storedMappings.map((r) => [r.column_index, r.decision, r.beneficiary]))} audited=${auditedMappings}`);

    // 1c. M213 POSITIVE PROOF — the identical designation now commits.
    const { data: exact, error: exactError } = await set(exactArgs);
    record('M212 PostgREST proof: the RPC resolves through PostgREST and commits',
      !exactError && Boolean(exact?.need_line_id),
      exactError ? `${exactError.code ?? ''} ${exactError.message}` : '');
    record('M213 contract: the designation refused while the column was unresolved succeeds once it is resolved',
      unresolvedError?.message === 'beneficiary_column_mapping_required' && !exactError && Boolean(exact?.need_line_id),
      exactError ? `${exactError.code ?? ''} ${exactError.message}` : `need_line=${exact?.need_line_id}`);

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
    }

    // 2. The float trap itself, on a SECOND scope: a float-shaped total is
    //    REFUSED, which proves the server re-derives the sum rather than
    //    trusting the number it was handed.
    const floatCells = [
      { sourceRecordId: rec('sheet:0:row:2::final'), designatedQuantity: '0.1', appliedOverrideId: null },
      { sourceRecordId: rec('sheet:0:row:3::final'), designatedQuantity: '0.2', appliedOverrideId: null },
    ];
    const { error: driftError } = await set({
      ...scopeB, p_approved_quantity: String(0.1 + 0.2), // '0.30000000000000004'
      p_quantity_sources: floatCells, p_expected_source_record_ids: [],
    });
    record('M212 PostgREST proof: a float-drifted total is refused with the stable domain error',
      driftError?.message === 'need_line_quantity_provenance_mismatch',
      driftError ? `${driftError.code ?? ''} ${driftError.message}` : 'no error raised');

    //    NO PARTIAL WRITE: that refusal came only after both cells validated, so
    //    the transaction had already inserted a line and its links — and every
    //    one of them was rolled back with it.
    const scopeBLines = async () => Number((await dbQuery(
      `SELECT count(*)::int AS n FROM central_needs_need_lines
        WHERE plan_revision_id = $1 AND beneficiary_organization_id = $2`,
      [cn.planRevisionId, cn.secondBeneficiaryOrganization]))?.rows?.[0]?.n);
    const cellLinks = async (ids) => Number((await dbQuery(
      `SELECT count(*)::int AS n FROM central_needs_need_line_sources WHERE source_record_id = ANY($1::uuid[])`,
      [ids]))?.rows?.[0]?.n);
    const floatIds = floatCells.map((c) => c.sourceRecordId);
    const afterDrift = { lines: await scopeBLines(), links: await cellLinks(floatIds) };
    record('M212 PostgREST proof: the refused total left no partial write (no line, no link)',
      afterDrift.lines === 0 && afterDrift.links === 0,
      `lines=${afterDrift.lines} links=${afterDrift.links}`);

    //    ...nor does a call whose FIRST cell is valid and a LATER one is not.
    const { error: mixedError } = await set({
      ...scopeB, p_approved_quantity: '0.3',
      p_quantity_sources: [
        floatCells[0],
        { sourceRecordId: '00000000-0000-0000-0000-00000000e212', designatedQuantity: '0.2', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [],
    });
    const afterMixed = { lines: await scopeBLines(), links: await cellLinks([floatIds[0]]) };
    record('M212 PostgREST proof: a call failing on a later cell writes nothing for the earlier one',
      mixedError?.message === 'source_record_not_found' && afterMixed.lines === 0 && afterMixed.links === 0,
      mixedError ? `${mixedError.code ?? ''} ${mixedError.message} lines=${afterMixed.lines} links=${afterMixed.links}`
        : 'no error raised');

    //    ...and the same cells, as exact strings, sum to exactly 0.3.
    const { data: sum, error: sumError } = await set({
      ...scopeB, p_approved_quantity: '0.3',
      p_quantity_sources: floatCells, p_expected_source_record_ids: [],
    });
    record('M212 PostgREST proof: two exact decimals sum to exactly 0.3 server-side',
      !sumError && Boolean(sum?.need_line_id),
      sumError ? `${sumError.code ?? ''} ${sumError.message}` : '');

    // 3. INCREMENTAL ADD through the real transport (uuid[] expected lineage):
    //    a later cell is added to scope A, and the earlier link survives.
    const { data: added, error: addError } = await set({
      ...scopeA, p_approved_quantity: BIG_PLUS,
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:4::final'), designatedQuantity: BIG, appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [rec('sheet:0:row:1::final')],
    });
    record('M212 PostgREST proof: an incremental add extends the line and keeps the earlier link',
      !addError && added?.created === false && added?.need_line_id === exact?.need_line_id
        && (exact?.need_line_id ? (await linkCount(exact.need_line_id)) === 2 : false),
      addError ? `${addError.code ?? ''} ${addError.message}` : `created=${added?.created} links=${added?.source_link_count}`);

    // 3b. DIRECT WRITES are refused on the same authenticated path — even for
    //     the editor who holds central_needs.edit, only the RPCs can write — and
    //     they change nothing.
    const noLine = '00000000-0000-0000-0000-000000000000';
    const directInsert = await client.from('central_needs_need_lines').insert({
      plan_revision_id: cn.planRevisionId, organization_id: cn.owningOrganization,
      beneficiary_organization_id: cn.beneficiaryOrganization, central_item_id: cn.centralItemId,
      approved_quantity: '1', approved_unit: 'box', mapping_reason: 'M212 direct write attempt',
    });
    const directUpdate = await client.from('central_needs_need_lines')
      .update({ approved_quantity: '1' }).eq('id', exact?.need_line_id ?? noLine);
    const directDelete = await client.from('central_needs_need_line_sources')
      .delete().eq('need_line_id', exact?.need_line_id ?? noLine);
    const lineAState = exact?.need_line_id ? (await dbQuery(
      `SELECT n.approved_quantity::text AS q,
              (SELECT count(*)::int FROM central_needs_need_line_sources ls WHERE ls.need_line_id = n.id) AS links
         FROM central_needs_need_lines n WHERE n.id = $1`, [exact.need_line_id]))?.rows?.[0] : null;
    record('M212 PostgREST proof: direct INSERT, UPDATE and DELETE are refused (42501) and change nothing',
      directInsert.error?.code === '42501' && directUpdate.error?.code === '42501'
        && directDelete.error?.code === '42501'
        && lineAState?.q === BIG_PLUS && Number(lineAState?.links) === 2,
      `insert=${directInsert.error?.code} update=${directUpdate.error?.code} delete=${directDelete.error?.code} `
        + `approved=${lineAState?.q} links=${lineAState?.links}`);

    // 4. A SESSION-LIMITED (stale) save is refused and erases nothing.
    const { error: staleError } = await set({
      ...scopeA, p_approved_quantity: '900',
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:1::requested'), designatedQuantity: '900', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [],
    });
    record('M212 PostgREST proof: a stale, session-limited save is refused and erases no provenance',
      staleError?.message === 'need_line_lineage_stale'
        && (exact?.need_line_id ? (await linkCount(exact.need_line_id)) === 2 : false),
      staleError ? `${staleError.code ?? ''} ${staleError.message}` : 'no error raised');

    // 5. One cell cannot feed a second line — and the refusal is the domain
    //    error, never PostgreSQL's raw duplicate-key text.
    //
    // 5a. (M213) Across beneficiaries the confirmed column mapping refuses it
    //     first: institution A's cell can never feed institution B's line, and
    //     neither line changes.
    const { error: crossError } = await set({
      ...scopeB, p_approved_quantity: '0.4',
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:1::final'), designatedQuantity: '0.1', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: floatCells.map((c) => c.sourceRecordId),
    });
    const crossLinks = {
      a: exact?.need_line_id ? await linkCount(exact.need_line_id) : -1,
      b: sum?.need_line_id ? await linkCount(sum.need_line_id) : -1,
    };
    record("M213 contract: institution A's cell is refused for institution B as 23514 beneficiary_column_mapping_conflict",
      crossError?.code === '23514' && crossError?.message === 'beneficiary_column_mapping_conflict'
        && crossLinks.a === 2 && crossLinks.b === 2,
      `${crossError ? `${crossError.code ?? ''} ${crossError.message}` : 'no error raised'} links A=${crossLinks.a} B=${crossLinks.b}`);

    // 5b. Within its own beneficiary, re-designating an already-linked cell —
    //     with the line's lineage stated correctly and a consistent total — is
    //     refused as source_record_already_linked.
    const { error: dupError } = await set({
      ...scopeA, p_approved_quantity: RELINK_TOTAL,
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:1::final'), designatedQuantity: '120.1239', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [rec('sheet:0:row:1::final'), rec('sheet:0:row:4::final')],
    });
    record('M212 PostgREST proof: a double-consumed cell is refused as source_record_already_linked, not a raw 23505',
      dupError?.message === 'source_record_already_linked' && dupError?.code !== '23505'
        && !/duplicate|_record_key/.test(`${dupError?.message} ${dupError?.details ?? ''}`)
        && (exact?.need_line_id ? (await linkCount(exact.need_line_id)) === 2 : false),
      dupError ? `${dupError.code ?? ''} ${dupError.message}` : 'no error raised');

    // 6. The EXACT READ: what supabase-js decodes for TypeScript.
    const { data: lines, error: readError } = await client.rpc('phoenix_central_needs_list_need_lines', {
      p_plan_revision_id: cn.planRevisionId,
    });
    const lineA = (lines ?? []).find((l) => l.id === exact?.need_line_id);
    const lineB = (lines ?? []).find((l) => l.id === sum?.need_line_id);
    const quantitiesOf = (l) => (l?.sources ?? []).map((s) => s.designated_quantity).sort();
    record(`M212 PostgREST proof: ${BIG_PLUS} and ${BIG} reach TypeScript as the exact strings`,
      !readError && typeof lineA?.approved_quantity === 'string' && lineA.approved_quantity === BIG_PLUS
        && JSON.stringify(quantitiesOf(lineA)) === JSON.stringify(['120.1239', BIG].sort())
        && (lineA?.sources ?? []).every((s) => typeof s.designated_quantity === 'string'),
      readError ? `${readError.code ?? ''} ${readError.message}`
        : `approved=${JSON.stringify(lineA?.approved_quantity)} sources=${JSON.stringify(quantitiesOf(lineA))}`);
    record('M212 PostgREST proof: 0.3, 0.1 and 0.2 reach TypeScript as the exact strings',
      lineB?.approved_quantity === '0.3' && JSON.stringify(quantitiesOf(lineB)) === JSON.stringify(['0.1', '0.2']),
      `approved=${JSON.stringify(lineB?.approved_quantity)} sources=${JSON.stringify(quantitiesOf(lineB))}`);

    // 7. Authorization is live on this path: the apikey is not the authority,
    //    the user's JWT is. An outlet officer is outside the Central Needs role
    //    class, so the canonical guard refuses it by that exact reason, and RLS
    //    hands it no row through the read.
    const officer = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: officerSignIn } = await officer.auth.signInWithPassword({
      email: seed.users.outletOfficerA.email, password: seed.password,
    });
    const { error: deniedError } = await officer.rpc('phoenix_central_needs_set_need_line', {
      ...scopeA, p_approved_quantity: '1',
      p_quantity_sources: [
        { sourceRecordId: rec('sheet:0:row:1::requested'), designatedQuantity: '1', appliedOverrideId: null },
      ],
      p_expected_source_record_ids: [],
    });
    record('M212 PostgREST proof: an unauthorized signed-in user is refused as forbidden_central_needs_role (42501)',
      !officerSignIn && deniedError?.message === 'forbidden_central_needs_role' && deniedError?.code === '42501',
      deniedError ? `${deniedError.code ?? ''} ${deniedError.message}` : 'no error raised');
    const { data: officerLines, error: officerReadError } = await officer.rpc('phoenix_central_needs_list_need_lines', {
      p_plan_revision_id: cn.planRevisionId,
    });
    record('M212 PostgREST proof: the exact read grants nothing — the officer sees no line',
      !officerReadError && Array.isArray(officerLines) && officerLines.length === 0,
      officerReadError ? `${officerReadError.code ?? ''} ${officerReadError.message}` : `rows=${officerLines?.length}`);

    // 7b. WRONG ORGANIZATION: the same Central-Needs-eligible editor, holding
    //     central_needs.edit, is refused on a revision owned by ANOTHER
    //     organization. Authorization is on the owning organization
    //     (phoenix_status_center_authorized matches it exactly), not merely on
    //     holding the key. The foreign revision is seeded here through the
    //     local-only superuser connection.
    let foreignRevision = null;
    try {
      const plan = (await dbQuery(
        `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1, 2098) RETURNING id`,
        [cn.beneficiaryOrganization]))?.rows?.[0]?.id;
      foreignRevision = plan ? (await dbQuery(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
         VALUES ($1, $2, 1, 'draft') RETURNING id`, [plan, cn.beneficiaryOrganization]))?.rows?.[0]?.id ?? null : null;
    } catch (e) {
      foreignRevision = null;
    }
    const { error: foreignError } = foreignRevision
      ? await set({
        ...scopeA, p_plan_revision_id: foreignRevision, p_approved_quantity: '1',
        p_quantity_sources: [
          { sourceRecordId: rec('sheet:0:row:1::requested'), designatedQuantity: '1', appliedOverrideId: null },
        ],
        p_expected_source_record_ids: [],
      })
      : { error: null };
    record('M212 PostgREST proof: the editor is refused on another organization\'s revision as forbidden_central_needs (42501)',
      Boolean(foreignRevision) && foreignError?.message === 'forbidden_central_needs' && foreignError?.code === '42501',
      foreignRevision
        ? (foreignError ? `${foreignError.code ?? ''} ${foreignError.message}` : 'no error raised')
        : 'foreign-organization revision fixture could not be created');

    // 8. The explicit correction path through the real transport.
    if (sum?.need_line_id) {
      const { data: deleted, error: deleteError } = await client.rpc('phoenix_central_needs_delete_need_line', {
        p_need_line_id: sum.need_line_id,
        p_reason: 'M212 PostgREST proof: explicit correction',
        p_expected_source_record_ids: floatCells.map((c) => c.sourceRecordId),
      });
      const remaining = await dbQuery(
        `SELECT count(*)::int AS n FROM central_needs_need_lines WHERE id = $1`, [sum.need_line_id]);
      const evidence = await dbQuery(
        `SELECT count(*)::int AS n FROM central_needs_source_records WHERE id = ANY($1::uuid[])`,
        [floatCells.map((c) => c.sourceRecordId)]);
      record('M212 PostgREST proof: a reasoned delete removes the line and keeps the evidence',
        !deleteError && deleted?.deleted_source_count === 2
          && Number(remaining?.rows?.[0]?.n) === 0 && Number(evidence?.rows?.[0]?.n) === 2,
        deleteError ? `${deleteError.code ?? ''} ${deleteError.message}` : `deleted=${deleted?.deleted_source_count}`);
    }
  }
}

}
