/**
 * C6 — REAL-CORPUS END-TO-END CERTIFICATION: the canonical Stage 2 lifecycle.
 *
 * The certified Annual Needs archive (PHOENIX_C6_CORPUS_ZIP, identity checked
 * by SHA-256 and byte size in tests/helpers/c6-certification.ts) is carried
 * through the canonical Central Needs path on a disposable pg-rig built with
 * the full migration chain (through M218), and nothing is written by any other
 * means on the positive path:
 *
 *   L1  open the annual draft (open_plan_revision);
 *   L2  the whole archive enters through the REAL trusted endpoints —
 *       upload-ticket, signed staging upload, finalize-import — which run the
 *       browser-Worker preview parity check, the PostgreSQL canonical digest,
 *       57 entry sessions, 57 authoritative Node replays and ONE trusted batch;
 *       the persisted evidence is then compared, cell for cell, with the
 *       production Node replay of the same bytes;
 *   L3  a byte-identical finalize retry is an idempotent replay (zero writes),
 *       and a preview that disagrees with the authoritative replay is refused
 *       before any write;
 *   L4  before any human decision, readiness is REVISION-WIDE (every target
 *       entity of all 57 sessions) and submit fails closed;
 *   L5  human record disposition of every target entity;
 *   L6  beneficiary decisions at BOTH grains on real cells: M213 columns on one
 *       workbook, M216 regions on another (where an explicit blank cell sits
 *       beside a numeric zero);
 *   L7  need lines whose every quantity is linked to an exact persisted source
 *       record (session, entry, sheet, coordinate, verbatim value);
 *   L8  an unresolved unit (conversion_required) fails closed and is resolved
 *       only through the governed delete-and-recreate;
 *   L9  submit (M218 writes one submission_gate audit per canonical submit,
 *       counted in L11), the M217 approval gate, approval;
 *   L10 a governed correction revision: the archive re-imported, one quantity
 *       corrected through a recorded field override, submitted, approved — the
 *       predecessor superseded atomically;
 *   L11 history and audit: the lifecycle read model, the audit trail, and the
 *       superseded revision still intact, readable and immutable.
 *
 * WHAT IS PINNED. Two workbooks are identified by their entry SHA-256 and a
 * handful of 0-based cell coordinates only; every value, sheet name and path is
 * read from the replay at run time and never copied into this file. Nothing a
 * reviewer would decide is inferred: material, beneficiary and unit elections
 * are explicit, scripted human decisions, and every row outside the certified
 * sample is dispositioned not_applicable with a stated reason.
 *
 * PRIVILEGED SQL appears only as read-only inspection (asAdmin SELECT) and as
 * explicitly labelled ATTACK probes whose refusal is asserted. No fixture state
 * is written around a canonical RPC.
 *
 * Gated on PHOENIX_RIG_PG (disposable PostgreSQL only) AND
 * PHOENIX_C6_CORPUS_ZIP; skipped — and to be reported NOT_RUN — without either.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', async () => (await import('./helpers/c6-certification')).supabaseJsMirror());

import { buildRig, rigAvailable } from '../tools/pg-rig/rig.mjs';
import {
  C6_CORPUS, corpusConfigured, importThroughEndpoints, installC6Supabase, loadCertifiedCorpus, refusal,
  sha256Hex, storedObject, storedObjectKeys, tokenFor, uninstallC6Supabase, workerPreviewJson,
} from './helpers/c6-certification';
import { parseArchiveBytes } from '../src/features/central-needs/import/archive-core';
import { browserInflate } from '../src/features/central-needs/import/browser-inflate';
import { replayArchive } from '../src/features/central-needs/import/node-replay';
import type { ArchiveParseResult, FileParseResult, SourceValueRecordDraft } from '../src/features/central-needs/import/contract';
import uploadTicket from '../api/_cn2b-core/upload-ticket';
import finalizeImport from '../api/_cn2b-core/finalize-import';

const run = rigAvailable() && corpusConfigured() ? describe : describe.skip;

// ---- fixtures (stable ids, prefix c6) --------------------------------------
const ORG = '00000000-0000-0000-0000-0000000c6001';         // plan owner
const BENE = {
  A: '00000000-0000-0000-0000-0000000c6011', B: '00000000-0000-0000-0000-0000000c6012',
  C: '00000000-0000-0000-0000-0000000c6013', D: '00000000-0000-0000-0000-0000000c6014',
  E: '00000000-0000-0000-0000-0000000c6015',
} as const;
const U_EDIT = '00000000-0000-0000-0000-0000000c6101';      // view / import / edit
const U_APPROVE = '00000000-0000-0000-0000-0000000c6102';   // view / approve
const U_VIEW = '00000000-0000-0000-0000-0000000c6103';      // view only
const ITEM = {
  1: '00000000-0000-0000-0000-0000000c6201', 2: '00000000-0000-0000-0000-0000000c6202',
  3: '00000000-0000-0000-0000-0000000c6203',
} as const;
const PLAN_YEAR = 2026;

// ---- the certified sample: entry SHA-256 + 0-based coordinates only ---------
/** Multi-institution rows with numeric zeros and a MISSING cell; decided by M213 columns. */
const W13 = {
  ordinal: 13,
  entrySha256: '358e29e491089d591f6e9954cf910acb633539c1749b0b7ccab963dac2f26b28',
  sheet: 0,
  rows: { 1: ITEM[1], 4: ITEM[2] } as Record<number, string>,
  beneficiaryColumns: { 7: BENE.A, 8: BENE.B, 10: BENE.C, 18: BENE.D, 36: BENE.E } as Record<number, string>,
  nonBeneficiaryColumns: [0, 1, 3, 42],
  /** Row 1 has no cell at all in beneficiary column 8. */
  missingCell: { row: 1, col: 8 },
  unitColumn: 3,
};
/** A row with an EXPLICIT blank cell beside a numeric zero; decided by M216 regions. */
const W20 = {
  ordinal: 20,
  entrySha256: '1783024a696375272452dbbcf385e2f644e872fe8af99f026d52e2b1bf5cee49',
  sheet: 0,
  row: 10,
  item: ITEM[3],
  blankCell: { row: 10, col: 7 },
  zeroCell: { row: 10, col: 11 },
  beneficiaryColumns: { 10: BENE.A, 11: BENE.B, 12: BENE.C } as Record<number, string>,
  nonBeneficiaryColumns: { start: 0, end: 9 },
};

// ---- replay-derived facts (measured at run time) ----------------------------
const EXPECTED = { entries: 57, excluded: 14, records: 113950, targetEntities: 7512 } as const;

run('C6 — real-corpus canonical Stage 2 lifecycle (disposable rig) — dynamic', { timeout: 900_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let corpus: Uint8Array;
  let nodeReplay: ArchiveParseResult;
  let previewJson: string;
  const T: Record<string, string> = {};

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]), { role, commit: true });
  const rows = (userId: string | null, sql: string, params: unknown[] = []) =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role: 'authenticated' });
  const admin = <R = any>(sql: string, params: unknown[] = []): Promise<R[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  const readiness = (rev: string) => call(U_VIEW, 'SELECT public.phoenix_central_needs_review_readiness($1) AS result', [rev]);
  const submit = (rev: string, user = U_EDIT) => call(user, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [rev]);
  const approve = (rev: string, user = U_APPROVE) => call(user, 'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [rev]);
  const dispose = (session: string, entity: string, decision: 'mapped' | 'not_applicable', item: string | null, reason: string | null) =>
    call(U_EDIT, 'SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result', [session, entity, decision, item, reason]);
  const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';
  const setLine = (rev: string, o: { bene: string; item: string; qty: string; sources: unknown[]; expected?: string[];
    unit?: string | null; state?: string; sourceUnitText?: string | null }, user = U_EDIT) =>
    call(user, SET_LINE, [rev, o.bene, o.item, o.qty, 'designated by the C6 reviewer from the linked source cells',
      JSON.stringify(o.sources), o.expected ?? [], o.unit === undefined ? 'other' : o.unit, o.state ?? 'canonical', null,
      o.sourceUnitText ?? null]);
  const footprint = async (rev: string) => (await admin(`
    SELECT (SELECT count(*) FROM central_needs_import_sessions WHERE plan_revision_id = $1)::int AS sessions,
           (SELECT count(*) FROM central_needs_source_files WHERE plan_revision_id = $1)::int AS files,
           (SELECT count(*) FROM central_needs_source_records r JOIN central_needs_import_sessions s ON s.id = r.import_session_id
             WHERE s.plan_revision_id = $1)::int AS records,
           (SELECT count(*) FROM central_needs_import_batches WHERE plan_revision_id = $1)::int AS batches,
           (SELECT count(*) FROM central_needs_import_batch_entries WHERE plan_revision_id = $1)::int AS batch_entries,
           (SELECT count(*) FROM central_needs_record_mappings m JOIN central_needs_import_sessions s ON s.id = m.import_session_id
             WHERE s.plan_revision_id = $1)::int AS dispositions,
           (SELECT count(*) FROM central_needs_need_lines WHERE plan_revision_id = $1)::int AS lines,
           (SELECT count(*) FROM audit_logs)::int AS audits`, [rev]))[0];

  /** entry ordinal (1-based) → import session id, from the trusted batch manifest. */
  const sessionsByOrdinal = async (rev: string) => new Map((await admin(
    `SELECT e.entry_ordinal, e.import_session_id, e.entry_sha256, e.archive_entry_path
       FROM central_needs_import_batch_entries e WHERE e.plan_revision_id = $1 ORDER BY e.entry_ordinal`, [rev]))
    .map((r: any) => [r.entry_ordinal as number, r]));

  /** The persisted source record at an exact coordinate, or undefined when the cell produced none. */
  const recordAt = async (session: string, sheet: number, row: number, col: number) => (await admin(
    `SELECT id, target_entity, field_name, source_values, source_provenance FROM central_needs_source_records
      WHERE import_session_id = $1 AND (source_provenance->>'sheetIndex')::int = $2
        AND (source_provenance->'coordinate'->>'row')::int = $3 AND (source_provenance->'coordinate'->>'col')::int = $4`,
    [session, sheet, row, col]))[0];

  const nodeEntry = (ordinal: number): FileParseResult => nodeReplay.entries[ordinal - 1];
  const replayRecordAt = (ordinal: number, sheet: number, row: number, col: number): SourceValueRecordDraft | undefined =>
    nodeEntry(ordinal).sourceRecords.find((r) => r.sourceProvenance.sheetIndex === sheet
      && r.sourceProvenance.coordinate.row === row && r.sourceProvenance.coordinate.col === col);

  beforeAll(async () => {
    corpus = loadCertifiedCorpus();
    nodeReplay = await replayArchive(corpus, C6_CORPUS.archiveName);
    // The browser Worker's own parse (runtime 'browser_worker', DecompressionStream inflate),
    // carried across postMessage and JSON exactly as the page uploads it.
    previewJson = workerPreviewJson(await parseArchiveBytes(corpus, C6_CORPUS.archiveName,
      { runtime: 'browser_worker', inflate: browserInflate }));

    rig = await buildRig();
    installC6Supabase(rig);
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG}','C6-OWNER','مالك','c6-owner','pharmacy_department_authority',NULL),
        ('${BENE.A}','C6-BENE-A','أ','c6-bene-a','care_institution','hospital'),
        ('${BENE.B}','C6-BENE-B','ب','c6-bene-b','care_institution','hospital'),
        ('${BENE.C}','C6-BENE-C','ج','c6-bene-c','care_institution','hospital'),
        ('${BENE.D}','C6-BENE-D','د','c6-bene-d','care_institution','hospital'),
        ('${BENE.E}','C6-BENE-E','هـ','c6-bene-e','care_institution','hospital')`);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES
        ('${ITEM[1]}','C6 item 1','مادة 1','box'),('${ITEM[2]}','C6 item 2','مادة 2','other'),('${ITEM[3]}','C6 item 3','مادة 3','other')`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT}','c6-edit@rig'),('${U_APPROVE}','c6-approve@rig'),('${U_VIEW}','c6-view@rig')`);
      for (const u of [U_EDIT, U_APPROVE, U_VIEW]) {
        await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id=$1 WHERE id=$2`, [ORG, u]);
      }
      const grants: Array<[string, string[]]> = [[U_EDIT, ['view', 'import', 'edit']], [U_APPROVE, ['view', 'approve']], [U_VIEW, ['view']]];
      for (const [u, keys] of grants) {
        for (const k of keys) {
          await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
                           ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
    });
    T.edit = tokenFor(U_EDIT);
    T.approve = tokenFor(U_APPROVE);
  }, 900_000);

  afterAll(async () => {
    uninstallC6Supabase();
    await rig?.end();
  });

  const ctx: Record<string, any> = {};

  // ==========================================================================
  // L1–L2 — the draft, and the whole archive through the canonical endpoints
  // ==========================================================================
  it('L1: the annual draft is opened canonically (revision 1, draft)', async () => {
    const opened = await call(U_EDIT, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result', [ORG, PLAN_YEAR, false]);
    expect(opened).toMatchObject({ ok: true, idempotent_replay: false, revision_number: 1, status: 'draft' });
    ctx.r1 = opened.plan_revision_id as string;
    ctx.planId = opened.plan_id as string;
  });

  it('L2: the certified archive enters through upload-ticket → signed staging → finalize-import (57 entries, 14 excluded, one batch)', async () => {
    const before = await footprint(ctx.r1);
    const started = Date.now();
    const { ticket, finalize } = await importThroughEndpoints({
      uploadTicket, finalizeImport, token: T.edit, planRevisionId: ctx.r1, containerKind: 'zip', source: corpus, previewJson,
    });
    ctx.importMs = Date.now() - started;
    expect(ticket.status).toBe(200);
    expect(finalize!.status, JSON.stringify(finalize!.body)).toBe(200);
    expect(finalize!.body).toMatchObject({
      ok: true, idempotentReplay: false, containerKind: 'zip', containerSha256: C6_CORPUS.sha256,
      acceptedEntryCount: EXPECTED.entries, excludedEntryCount: EXPECTED.excluded,
    });
    ctx.r1Batch = finalize!.body.batchId as string;
    ctx.r1Sessions = finalize!.body.importSessionIds as string[];
    expect(new Set(ctx.r1Sessions).size).toBe(EXPECTED.entries);

    const after = await footprint(ctx.r1);
    expect(after).toMatchObject({ sessions: 57, files: 57, records: EXPECTED.records, batches: 1, batch_entries: 57, dispositions: 0, lines: 0 });
    // 57 session starts + 57 authoritative replays + 1 batch registration.
    expect(after.audits - before.audits).toBe(57 + 57 + 1);

    const [batch] = await admin(`SELECT * FROM central_needs_import_batches WHERE id = $1`, [ctx.r1Batch]);
    expect(batch).toMatchObject({
      plan_revision_id: ctx.r1, container_kind: 'zip', container_filename: C6_CORPUS.archiveName,
      container_sha256: C6_CORPUS.sha256, accepted_entry_count: 57, excluded_entry_count: 14,
    });
    expect(Number(batch.container_byte_size)).toBe(C6_CORPUS.byteSize);
    expect(batch.parser_identity).toEqual(nodeReplay.identity);
    expect(batch.reconciliation).toEqual(JSON.parse(JSON.stringify(nodeReplay.reconciliation)));

    // The trusted manifest is the replay's entry list, in order, by content hash.
    const manifest = await sessionsByOrdinal(ctx.r1);
    expect([...manifest.keys()]).toEqual(Array.from({ length: 57 }, (_, i) => i + 1));
    for (const [ordinal, m] of manifest) {
      const e = nodeEntry(ordinal);
      expect(m.entry_sha256, `entry ${ordinal}`).toBe(e.input.sha256);
      expect(m.archive_entry_path, `entry ${ordinal}`).toBe(e.input.archiveEntryPath);
      expect(m.import_session_id).toBe(ctx.r1Sessions[ordinal - 1]);
    }
    const sessions = await admin(`SELECT id, status, preview_digest, authoritative_digest, parser_identity, entry_path
                                    FROM central_needs_import_sessions WHERE plan_revision_id = $1`, [ctx.r1]);
    for (const s of sessions) {
      expect(s.status).toBe('completed');
      expect(s.authoritative_digest).toBe(s.preview_digest);
      expect(s.parser_identity).toMatchObject({ contractVersion: nodeReplay.identity.contractVersion, runtime: 'node' });
    }

    // Permanent evidence: one create-only, content-addressed object; staging removed.
    const permanentKey = `permanent/${ORG}/${ctx.r1}/${C6_CORPUS.sha256}`;
    expect(storedObjectKeys()).toEqual([permanentKey]);
    expect(sha256Hex(storedObject(permanentKey)!)).toBe(C6_CORPUS.sha256);
  });

  it('L2: the persisted evidence is the production Node replay, cell for cell (blank never persisted, zero persisted as zero)', async () => {
    const manifest = await sessionsByOrdinal(ctx.r1);
    let compared = 0;
    for (const [ordinal, m] of manifest) {
      const expectedRecords = nodeEntry(ordinal).sourceRecords;
      const persisted = await admin(
        `SELECT record_ordinal, target_entity, field_name, source_values, source_provenance - 'extractedAt' AS provenance
           FROM central_needs_source_records WHERE import_session_id = $1 ORDER BY record_ordinal`, [m.import_session_id]);
      expect(persisted.length, `entry ${ordinal}`).toBe(expectedRecords.length);
      for (let i = 0; i < persisted.length; i += 1) {
        const r = JSON.parse(JSON.stringify(expectedRecords[i]));
        delete r.sourceProvenance.extractedAt;
        // jsonb normalizes key ORDER only; every key and value must survive exactly.
        const want = sortKeys({ ordinal: i + 1, targetEntity: r.targetEntity.trim(), fieldName: r.fieldName.trim(),
          sourceValues: r.sourceValues, provenance: r.sourceProvenance });
        const got = sortKeys({ ordinal: persisted[i].record_ordinal, targetEntity: persisted[i].target_entity,
          fieldName: persisted[i].field_name, sourceValues: persisted[i].source_values, provenance: persisted[i].provenance });
        if (JSON.stringify(got) !== JSON.stringify(want)) expect({ entry: ordinal, got }).toEqual({ entry: ordinal, got: want });
        compared += 1;
      }
    }
    expect(compared).toBe(EXPECTED.records);

    // blank ≠ zero, at rest: every numeric-zero cell the replay emitted is a persisted number 0;
    // no persisted number is null; no invalid evidence exists.
    const [classes] = await admin(`
      SELECT count(*) FILTER (WHERE r.source_values->>'valueType' = 'number' AND (r.source_values->'value') = '0'::jsonb)::int AS zero_numbers,
             count(*) FILTER (WHERE r.source_values->>'valueType' = 'number' AND jsonb_typeof(r.source_values->'value') <> 'number')::int AS non_numeric_numbers,
             count(*) FILTER (WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence')::int AS invalid
        FROM central_needs_source_records r JOIN central_needs_import_sessions s ON s.id = r.import_session_id
       WHERE s.plan_revision_id = $1`, [ctx.r1]);
    const replayZeros = nodeReplay.entries.reduce((n, e) => n + e.sourceRecords
      .filter((r) => (r.sourceValues as any).valueType === 'number' && (r.sourceValues as any).value === 0).length, 0);
    expect(classes).toEqual({ zero_numbers: replayZeros, non_numeric_numbers: 0, invalid: 0 });

    // The pinned sample cells, exactly as the replay describes them.
    const s13 = manifest.get(W13.ordinal)!.import_session_id as string;
    const s20 = manifest.get(W20.ordinal)!.import_session_id as string;
    expect(manifest.get(W13.ordinal)!.entry_sha256).toBe(W13.entrySha256);
    expect(manifest.get(W20.ordinal)!.entry_sha256).toBe(W20.entrySha256);
    ctx.s13 = s13;
    ctx.s20 = s20;
    // An explicit blank cell: present in the workbook evidence as 'blank', absent from the records.
    const blank = nodeEntry(W20.ordinal).workbook!.sheets[W20.sheet].cells
      .find((c) => c.coordinate.row === W20.blankCell.row && c.coordinate.col === W20.blankCell.col);
    expect(blank).toMatchObject({ presence: 'blank', rawValue: null });
    expect(await recordAt(s20, W20.sheet, W20.blankCell.row, W20.blankCell.col)).toBeUndefined();
    // A missing cell: no evidence at all, no record.
    expect(nodeEntry(W13.ordinal).workbook!.sheets[W13.sheet].cells
      .find((c) => c.coordinate.row === W13.missingCell.row && c.coordinate.col === W13.missingCell.col)).toBeUndefined();
    expect(await recordAt(s13, W13.sheet, W13.missingCell.row, W13.missingCell.col)).toBeUndefined();
    // A numeric zero: a record holding the number 0.
    const zero = await recordAt(s20, W20.sheet, W20.zeroCell.row, W20.zeroCell.col);
    expect(zero.source_values).toEqual({ value: 0, valueType: 'number', isFormula: false, formula: null });
  });

  // ==========================================================================
  // L3 — replay safety
  // ==========================================================================
  it('L3: a byte-identical finalize retry is an idempotent replay — same batch, same sessions, zero writes', async () => {
    const before = await footprint(ctx.r1);
    const { finalize } = await importThroughEndpoints({
      uploadTicket, finalizeImport, token: T.edit, planRevisionId: ctx.r1, containerKind: 'zip', source: corpus, previewJson,
    });
    expect(finalize!.status).toBe(200);
    expect(finalize!.body).toMatchObject({ ok: true, idempotentReplay: true, batchId: ctx.r1Batch, acceptedEntryCount: 57 });
    expect(finalize!.body.importSessionIds).toEqual(ctx.r1Sessions);
    expect(await footprint(ctx.r1)).toEqual(before);
    expect(storedObjectKeys()).toEqual([`permanent/${ORG}/${ctx.r1}/${C6_CORPUS.sha256}`]);
  });

  it('L3: a preview that disagrees with the authoritative replay in ONE real cell is refused before any write', async () => {
    const tampered = JSON.parse(previewJson) as ArchiveParseResult;
    const entry = tampered.entries[W13.ordinal - 1];
    const cell = entry.workbook!.sheets[W13.sheet].cells.find((c) => c.coordinate.row === 1 && c.coordinate.col === 7)!;
    const rec = entry.sourceRecords.find((r) => r.sourceProvenance.coordinate.row === 1 && r.sourceProvenance.coordinate.col === 7)!;
    expect(typeof cell.rawValue).toBe('number');
    cell.rawValue = (cell.rawValue as number) + 1;
    (rec.sourceValues as any).value = cell.rawValue;
    const before = await footprint(ctx.r1);
    const { finalize } = await importThroughEndpoints({
      uploadTicket, finalizeImport, token: T.edit, planRevisionId: ctx.r1, containerKind: 'zip', source: corpus,
      previewJson: JSON.stringify(tampered),
    });
    expect(finalize!.status).toBe(422);
    expect(finalize!.body).toMatchObject({ ok: false, error: 'browser_node_parity_mismatch', difference: { kind: 'value' } });
    expect(finalize!.body.difference.path).toMatch(new RegExp(`^entries\\[${W13.ordinal - 1}\\]\\.`));
    expect(await footprint(ctx.r1)).toEqual(before);
  });

  it('L3: different evidence replayed into a COMPLETED real session is refused (service_role, the trusted path itself)', async () => {
    const records = JSON.parse(JSON.stringify(nodeEntry(W13.ordinal).sourceRecords));
    const i = records.findIndex((r: any) => r.sourceProvenance.coordinate.row === 1 && r.sourceProvenance.coordinate.col === 7);
    records[i].sourceValues.value += 1;
    const before = await footprint(ctx.r1);
    expect(await refusal(call(null, 'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result',
      [ctx.s13, W13.entrySha256, JSON.stringify(records), JSON.stringify(nodeEntry(W13.ordinal).identity)], 'service_role')))
      .toMatchObject({ code: '23514', message: 'import_session_already_finalized_with_different_evidence' });
    // …while the exact evidence is an idempotent no-op.
    expect(await call(null, 'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result',
      [ctx.s13, W13.entrySha256, JSON.stringify(nodeEntry(W13.ordinal).sourceRecords), JSON.stringify(nodeEntry(W13.ordinal).identity)], 'service_role'))
      .toMatchObject({ ok: true, idempotent_replay: true, records_inserted: 0 });
    expect(await footprint(ctx.r1)).toEqual(before);
  });

  // ==========================================================================
  // L4 — readiness is revision-wide before (and while) humans decide
  // ==========================================================================
  it('L4: before any decision every target entity of all 57 sessions blocks, and submit fails closed', async () => {
    const r = await readiness(ctx.r1);
    expect(r).toMatchObject({ ok: true, plan_revision_id: ctx.r1, status: 'draft', ready: false });
    const kinds = countBy(r.blockers.map((b: any) => b.blocker));
    expect(kinds).toEqual({ target_entity_without_disposition: EXPECTED.targetEntities });
    const sessionsBlocking = new Set(r.blockers.map((b: any) => /^session=([0-9a-f-]{36}) /.exec(b.detail)![1]));
    expect(sessionsBlocking.size).toBe(57);
    const refused = await refusal(submit(ctx.r1));
    expect(refused).toMatchObject({ code: '23514', message: 'plan_revision_has_undecided_target_entity' });
    expect(refused.detail).toMatch(/^session=[0-9a-f-]{36} target_entity=sheet:\d+:row:\d+$/);
  });

  it('L4 (Simple Mode, server side): completing the ACTIVE session alone leaves the revision-wide readiness blocked by the other 56 sessions', async () => {
    // Simple Mode's material queue is the first completed session by started_at
    // (listImportSessions → CentralNeedsScreen), read through listSourceRecords(session).
    const [active] = await rows(U_VIEW, `SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1 AND status = 'completed'
                                          ORDER BY started_at ASC LIMIT 1`, [ctx.r1]);
    const activeEntities = (await rows(U_VIEW, `SELECT DISTINCT target_entity FROM central_needs_source_records WHERE import_session_id = $1`, [active.id]))
      .map((x: any) => x.target_entity as string);
    expect(activeEntities.length).toBeGreaterThan(0);
    expect(activeEntities.length).toBeLessThan(EXPECTED.targetEntities);
    ctx.activeSession = active.id;
    for (const e of activeEntities) {
      const item = sampleItemFor(active.id, e);
      await dispose(active.id, e, item ? 'mapped' : 'not_applicable', item, item ? null : 'outside the C6 certified sample');
    }
    const r = await readiness(ctx.r1);
    expect(r.ready).toBe(false);
    const undecided = r.blockers.filter((b: any) => b.blocker === 'target_entity_without_disposition');
    expect(undecided.length).toBe(EXPECTED.targetEntities - activeEntities.length);
    expect(undecided.some((b: any) => b.detail.startsWith(`session=${active.id} `))).toBe(false);
    expect(new Set(undecided.map((b: any) => b.detail.slice(8, 44))).size).toBe(56);
  });

  // ==========================================================================
  // L5 — human record disposition of every target entity
  // ==========================================================================
  /** The certified sample's material election, or null for "not a need line in this sample". */
  function sampleItemFor(session: string, entity: string): string | null {
    if (session === ctx.s13) {
      const m = /^sheet:(\d+):row:(\d+)$/.exec(entity)!;
      return Number(m[1]) === W13.sheet ? (W13.rows[Number(m[2])] ?? null) : null;
    }
    if (session === ctx.s20) return entity === `sheet:${W20.sheet}:row:${W20.row}` ? W20.item : null;
    return null;
  }

  it('L5: every one of the 7,512 target entities receives an explicit human disposition (3 mapped, the rest not_applicable with a reason)', async () => {
    const pending = await admin(`
      SELECT DISTINCT r.import_session_id, r.target_entity
        FROM central_needs_source_records r JOIN central_needs_import_sessions s ON s.id = r.import_session_id
       WHERE s.plan_revision_id = $1
         AND NOT EXISTS (SELECT 1 FROM central_needs_record_mappings m
                          WHERE m.import_session_id = r.import_session_id AND m.target_entity = r.target_entity)
       ORDER BY 1, 2`, [ctx.r1]);
    const started = Date.now();
    let mapped = 0;
    for (const p of pending) {
      const item = sampleItemFor(p.import_session_id, p.target_entity);
      if (item) mapped += 1;
      const out = await dispose(p.import_session_id, p.target_entity, item ? 'mapped' : 'not_applicable', item,
        item ? null : 'outside the C6 certified sample');
      expect(out.ok).toBe(true);
    }
    ctx.dispositionMs = Date.now() - started;
    expect(mapped).toBe(3);
    const f = await footprint(ctx.r1);
    expect(f.dispositions).toBe(EXPECTED.targetEntities);
    const decided = await admin(`SELECT m.decision, count(*)::int AS n FROM central_needs_record_mappings m
                                   JOIN central_needs_import_sessions s ON s.id = m.import_session_id
                                  WHERE s.plan_revision_id = $1 GROUP BY 1 ORDER BY 1`, [ctx.r1]);
    expect(decided).toEqual([{ decision: 'mapped', n: 3 }, { decision: 'not_applicable', n: EXPECTED.targetEntities - 3 }]);
  });

  // ==========================================================================
  // L6 — beneficiary decisions at both grains, on real cells
  // ==========================================================================
  /** 0-based columns carrying a numeric review candidate on the sample's mapped rows (the DB classifier decides). */
  const candidateColumns = async (session: string) => (await admin(`
    SELECT DISTINCT (r.source_provenance->'coordinate'->>'col')::int AS col
      FROM central_needs_source_records r
      JOIN central_needs_record_mappings m ON m.import_session_id = r.import_session_id AND m.target_entity = r.target_entity AND m.decision = 'mapped'
     WHERE r.import_session_id = $1
       AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number','canonical_integer_text','ambiguous_numeric_text')
     ORDER BY 1`, [session])).map((r: any) => r.col as number);

  it('L6: with materials decided but no beneficiary decided, every numeric column of the mapped rows blocks review and a need line is refused', async () => {
    expect(await candidateColumns(ctx.s13)).toEqual([...W13.nonBeneficiaryColumns, ...Object.keys(W13.beneficiaryColumns).map(Number)].sort((a, b) => a - b));
    expect(await candidateColumns(ctx.s20)).toEqual([1, 2, 10, 11, 12]);
    const r = await readiness(ctx.r1);
    const kinds = countBy(r.blockers.map((b: any) => b.blocker));
    expect(kinds).toEqual({ mapped_target_entity_without_need_line: 3, beneficiary_column_review_required: 9 + 5 });
    const refused = await refusal(submit(ctx.r1));
    expect(refused).toMatchObject({ code: '23514', message: 'plan_revision_not_ready_for_review' });
    expect(refused.detail).toMatch(/^blocker=(mapped_target_entity_without_need_line|beneficiary_column_review_required) /);
    const h2 = await recordAt(ctx.s13, W13.sheet, 1, 7);
    expect(await refusal(setLine(ctx.r1, { bene: BENE.A, item: ITEM[1], qty: String(h2.source_values.value),
      sources: [{ sourceRecordId: h2.id, designatedQuantity: String(h2.source_values.value), appliedOverrideId: null }] })))
      .toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_required' });
  });

  const decideColumns = (rev: string, session: string) => call(U_EDIT,
    'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result', [rev, JSON.stringify([
      ...W13.nonBeneficiaryColumns.map((columnIndex) => ({ importSessionId: session, sheetIndex: W13.sheet, columnIndex, decision: 'non_beneficiary' })),
      ...Object.entries(W13.beneficiaryColumns).map(([col, bene]) => ({
        importSessionId: session, sheetIndex: W13.sheet, columnIndex: Number(col), decision: 'beneficiary', beneficiaryOrganizationId: bene })),
    ]), 'C6 reviewer: institution columns confirmed from the workbook header row']);

  it('L6: M213 column decisions on workbook 13 — a column with no evidence is refused; the confirmed columns now owe every numeric cell (zeros included, the missing cell not)', async () => {
    expect(nodeEntry(W13.ordinal).sourceRecords.some((r) => r.sourceProvenance.coordinate.col === 9)).toBe(false);
    expect(await refusal(call(U_EDIT, 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result',
      [ctx.r1, JSON.stringify([{ importSessionId: ctx.s13, sheetIndex: 0, columnIndex: 9, beneficiaryOrganizationId: BENE.A }]), 'no such column'])))
      .toMatchObject({ code: '23503', message: 'beneficiary_column_no_matching_evidence' });
    const out = await decideColumns(ctx.r1, ctx.s13);
    expect(out.ok).toBe(true);
    expect(out.confirmed).toHaveLength(9);

    const owed = (await readiness(ctx.r1)).blockers.filter((b: any) => b.blocker === 'beneficiary_column_cell_without_need_line')
      .map((b: any) => /target_entity=sheet:0:row:(\d+) source_record=/.exec(b.detail)![1] + ':' + /column=(\d+)/.exec(b.detail)![1]).sort();
    const expectedOwed: string[] = [];
    for (const row of Object.keys(W13.rows).map(Number)) {
      for (const col of Object.keys(W13.beneficiaryColumns).map(Number)) {
        const rec = replayRecordAt(W13.ordinal, W13.sheet, row, col);
        if (rec) expectedOwed.push(`${row}:${col}`);
      }
    }
    expect(owed).toEqual(expectedOwed.sort());
    expect(owed).not.toContain(`${W13.missingCell.row}:${W13.missingCell.col}`);
    expect(owed).toContain('1:18'); // S2 is a numeric zero — owed like any other number
  });

  const regionChanges = () => [
    { op: 'add', rowStart: W20.row, rowEnd: W20.row, columnStart: W20.nonBeneficiaryColumns.start, columnEnd: W20.nonBeneficiaryColumns.end,
      decision: 'non_beneficiary', beneficiaryOrganizationId: null },
    ...Object.entries(W20.beneficiaryColumns).map(([col, bene]) => ({
      op: 'add', rowStart: W20.row, rowEnd: W20.row, columnStart: Number(col), columnEnd: Number(col), decision: 'beneficiary', beneficiaryOrganizationId: bene })),
  ];
  const setRegions = (rev: string, session: string, changes: unknown[], expected: string[] = []) => call(U_EDIT,
    'SELECT public.phoenix_central_needs_set_beneficiary_regions($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7::jsonb,$8) AS result',
    [rev, session, W20.sheet, JSON.stringify(nodeEntry(W20.ordinal).identity), nodeEntry(W20.ordinal).workbook!.sheets[W20.sheet].name,
      expected, JSON.stringify(changes), 'C6 reviewer: institution regions declared on the stored workbook']);

  it('L6: M216 region decisions on workbook 20 — a region over the EXPLICIT BLANK alone has no evidence and is refused; the zero cell is owed', async () => {
    expect(await refusal(setRegions(ctx.r1, ctx.s20, [{ op: 'add', rowStart: W20.blankCell.row, rowEnd: W20.blankCell.row,
      columnStart: W20.blankCell.col, columnEnd: W20.blankCell.col, decision: 'beneficiary', beneficiaryOrganizationId: BENE.C }])))
      .toMatchObject({ code: '23503', message: 'beneficiary_region_no_matching_evidence' });
    const out = await setRegions(ctx.r1, ctx.s20, regionChanges());
    expect(out.ok).toBe(true);
    expect(out.active_versions).toHaveLength(4);
    const r = await readiness(ctx.r1);
    const owed = r.blockers.filter((b: any) => b.blocker === 'beneficiary_region_cell_without_need_line')
      .map((b: any) => Number(/ column=(\d+) /.exec(b.detail)![1])).sort((a: number, b: number) => a - b);
    expect(owed).toEqual([10, 11, 12]);
    expect(countBy(r.blockers.map((b: any) => b.blocker))).toEqual({
      mapped_target_entity_without_need_line: 3, beneficiary_column_cell_without_need_line: 9, beneficiary_region_cell_without_need_line: 3 });
  });

  // ==========================================================================
  // L7 — need lines with exact source provenance
  // ==========================================================================
  /** Every (beneficiary, item) → the exact source cells the sample links, from the persisted records. */
  const sampleLines = async (s13: string, s20: string) => {
    const lines: Array<{ bene: string; item: string; unitCell: { row: number; col: number } | null; cells: Array<{ session: string; ordinal: number; row: number; col: number; rec: any }> }> = [];
    for (const [row, item] of Object.entries(W13.rows)) {
      for (const [col, bene] of Object.entries(W13.beneficiaryColumns)) {
        const rec = await recordAt(s13, W13.sheet, Number(row), Number(col));
        if (!rec) continue;
        lines.push({ bene, item, unitCell: { row: Number(row), col: W13.unitColumn }, cells: [{ session: s13, ordinal: W13.ordinal, row: Number(row), col: Number(col), rec }] });
      }
    }
    for (const [col, bene] of Object.entries(W20.beneficiaryColumns)) {
      const rec = await recordAt(s20, W20.sheet, W20.row, Number(col));
      lines.push({ bene, item: W20.item, unitCell: null, cells: [{ session: s20, ordinal: W20.ordinal, row: W20.row, col: Number(col), rec }] });
    }
    return lines;
  };
  const unitTextOf = async (session: string, cell: { row: number; col: number } | null) =>
    cell ? ((await recordAt(session, W13.sheet, cell.row, cell.col))?.source_values.value as string) ?? null : null;
  const CONVERSION_PENDING = { bene: BENE.E, item: ITEM[2] };

  it('L7: blank is not zero at the line level — no approved quantity, or an empty designation, is refused; a real row outside the mapped sample cannot be linked', async () => {
    const s2 = await recordAt(ctx.s13, W13.sheet, 1, 18);
    expect(s2.source_values.value).toBe(0);
    expect(await refusal(call(U_EDIT, SET_LINE, [ctx.r1, BENE.D, ITEM[1], null, 'x',
      JSON.stringify([{ sourceRecordId: s2.id, designatedQuantity: '0', appliedOverrideId: null }]), [], 'box', 'canonical', null, null])))
      .toMatchObject({ code: '23514', message: 'approved_quantity_required' });
    expect(await refusal(setLine(ctx.r1, { bene: BENE.D, item: ITEM[1], qty: '0',
      sources: [{ sourceRecordId: s2.id, designatedQuantity: '', appliedOverrideId: null }] })))
      .toMatchObject({ code: '23514', message: 'designated_quantity_not_canonical' });
    const h3 = await recordAt(ctx.s13, W13.sheet, 2, 7); // row 2 was dispositioned not_applicable
    expect(await refusal(setLine(ctx.r1, { bene: BENE.A, item: ITEM[1], qty: String(h3.source_values.value),
      sources: [{ sourceRecordId: h3.id, designatedQuantity: String(h3.source_values.value), appliedOverrideId: null }] })))
      .toMatchObject({ code: '23514', message: 'source_link_requires_mapped_disposition' });
    const h2 = await recordAt(ctx.s13, W13.sheet, 1, 7); // column 7 is BENE.A's, not BENE.B's
    expect(await refusal(setLine(ctx.r1, { bene: BENE.B, item: ITEM[1], qty: String(h2.source_values.value),
      sources: [{ sourceRecordId: h2.id, designatedQuantity: String(h2.source_values.value), appliedOverrideId: null }] })))
      .toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_conflict' });
    expect((await footprint(ctx.r1)).lines).toBe(0);
  });

  it('L7: twelve need lines, each quantity linked to exactly its persisted real cell — zeros as "0", source unit text verbatim, one line left conversion_required', async () => {
    const lines = await sampleLines(ctx.s13, ctx.s20);
    expect(lines).toHaveLength(12);
    for (const l of lines) {
      const value = l.cells[0].rec.source_values.value;
      expect(typeof value).toBe('number');
      const pending = l.bene === CONVERSION_PENDING.bene && l.item === CONVERSION_PENDING.item;
      const out = await setLine(ctx.r1, {
        bene: l.bene, item: l.item, qty: String(value),
        sources: l.cells.map((c) => ({ sourceRecordId: c.rec.id, designatedQuantity: String(c.rec.source_values.value), appliedOverrideId: null })),
        unit: pending ? null : (l.item === ITEM[1] ? 'box' : 'other'), state: pending ? 'conversion_required' : 'canonical',
        sourceUnitText: await unitTextOf(ctx.s13, l.unitCell),
      });
      expect(out).toMatchObject({ ok: true, created: true, source_link_count: 1, approved_quantity: String(value) });
    }

    // The exact read model (SECURITY INVOKER, as a view-only reviewer).
    const listed = await rows(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1)', [ctx.r1]);
    expect(listed).toHaveLength(12);
    for (const l of lines) {
      const line = listed.find((x: any) => x.beneficiary_organization_id === l.bene && x.central_item_id === l.item)!;
      const c = l.cells[0];
      expect(line.approved_quantity).toBe(String(c.rec.source_values.value));
      expect(line.sources).toEqual([expect.objectContaining({
        source_record_id: c.rec.id, designated_quantity: String(c.rec.source_values.value), import_session_id: c.session,
        target_entity: `sheet:${c.rec.source_provenance.sheetIndex}:row:${c.row}`, field_name: c.rec.field_name })]);
      // …and the linked record IS the replay's cell: same file hash, entry path, sheet, coordinate and value.
      const want = replayRecordAt(c.ordinal, c.rec.source_provenance.sheetIndex, c.row, c.col)!;
      expect(c.rec.source_provenance).toMatchObject({
        fileFingerprintSha256: nodeEntry(c.ordinal).input.sha256, archiveEntryPath: nodeEntry(c.ordinal).input.archiveEntryPath,
        sheetIndex: want.sourceProvenance.sheetIndex, sheetName: want.sourceProvenance.sheetName, coordinate: want.sourceProvenance.coordinate });
      expect(c.rec.source_values.value).toBe((want.sourceValues as any).value);
      if (l.unitCell) expect(line.source_unit_text).toBe((replayRecordAt(c.ordinal, W13.sheet, l.unitCell.row, l.unitCell.col)!.sourceValues as any).value);
      else expect(line.source_unit_text).toBeNull();
    }
    const zeros = listed.filter((x: any) => x.approved_quantity === '0');
    expect(zeros.length).toBe(lines.filter((l) => l.cells[0].rec.source_values.value === 0).length);
    expect(zeros.length).toBeGreaterThanOrEqual(3);
    ctx.r1Lines = listed;
  });

  // ==========================================================================
  // L8 — an unresolved unit fails closed; resolution is governed
  // ==========================================================================
  it('L8: conversion_required blocks review and submit; its attributes cannot be silently rewritten; delete-with-reason and recreate resolves it', async () => {
    const pending = ctx.r1Lines.find((x: any) => x.beneficiary_organization_id === CONVERSION_PENDING.bene && x.central_item_id === CONVERSION_PENDING.item);
    // The source unit is the workbook's own text, read from the persisted record (never copied into this file).
    const unitText = await unitTextOf(ctx.s13, { row: 4, col: W13.unitColumn });
    expect(typeof unitText).toBe('string');
    expect(pending).toMatchObject({ unit_conversion_state: 'conversion_required', approved_unit: null, source_unit_text: unitText });
    const r = await readiness(ctx.r1);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual([{ blocker: 'need_line_unit_conversion_required', detail: `need_line=${pending.id} item=${CONVERSION_PENDING.item}` }]);
    expect(await refusal(submit(ctx.r1))).toEqual({ code: '23514', message: 'plan_revision_not_ready_for_review',
      detail: `blocker=need_line_unit_conversion_required need_line=${pending.id} item=${CONVERSION_PENDING.item}` });
    const src = pending.sources.map((s: any) => s.source_record_id);
    expect(await refusal(setLine(ctx.r1, { bene: CONVERSION_PENDING.bene, item: CONVERSION_PENDING.item, qty: pending.approved_quantity,
      sources: pending.sources.map((s: any) => ({ sourceRecordId: s.source_record_id, designatedQuantity: s.designated_quantity, appliedOverrideId: null })),
      expected: src, unit: 'other', state: 'canonical', sourceUnitText: unitText })))
      .toMatchObject({ code: '23514', message: 'need_line_attributes_conflict' });
    const deleted = await call(U_EDIT, 'SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result',
      [pending.id, 'C6 reviewer: unit elected after review (source unit text kept as evidence; approved unit other; no scaling)', src]);
    expect(deleted).toMatchObject({ ok: true, need_line_id: pending.id, deleted_source_count: 1 });
    const recreated = await setLine(ctx.r1, { bene: CONVERSION_PENDING.bene, item: CONVERSION_PENDING.item, qty: pending.approved_quantity,
      sources: pending.sources.map((s: any) => ({ sourceRecordId: s.source_record_id, designatedQuantity: s.designated_quantity, appliedOverrideId: null })),
      unit: 'other', state: 'canonical', sourceUnitText: unitText });
    expect(recreated).toMatchObject({ ok: true, created: true, approved_quantity: pending.approved_quantity });
    expect(await readiness(ctx.r1)).toMatchObject({ ready: true, blockers: [] });
  });

  // ==========================================================================
  // L9 — submit, the approval gate, approval
  // ==========================================================================
  it('L9: only an editor submits; the submitted revision is frozen; only an approver approves; a direct approval is refused (root: the M217 gate; service_role: privilege)', async () => {
    expect(await refusal(submit(ctx.r1, U_VIEW))).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    expect(await refusal(submit(ctx.r1, U_APPROVE))).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    expect(await submit(ctx.r1)).toMatchObject({ ok: true, plan_revision_id: ctx.r1, status: 'submitted' });

    expect(await refusal(submit(ctx.r1))).toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    expect(await refusal(dispose(ctx.s13, 'sheet:0:row:2', 'mapped', ITEM[1], null))).toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    const { ticket } = await importThroughEndpoints({ uploadTicket, finalizeImport, token: T.edit, planRevisionId: ctx.r1,
      containerKind: 'zip', source: corpus, previewJson });
    expect(ticket).toMatchObject({ status: 409, body: { error: 'plan_revision_not_editable' } });

    expect(await refusal(approve(ctx.r1, U_EDIT))).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    expect(await refusal(approve(ctx.r1, U_VIEW))).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    // ATTACK: privileged direct approvals of the real submitted revision. The root
    // of trust reaches the M217 gate; service_role, which holds no Central Needs
    // table write privilege since M218-FINAL, is refused by privilege before it.
    for (const [who, run, expected] of [
      ['superuser', () => admin(`UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [ctx.r1, U_APPROVE]),
        { code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${ctx.r1}` }],
      ['service_role', () => call(null, `UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING id`, [ctx.r1, U_APPROVE], 'service_role'),
        { code: '42501', message: 'permission denied for table central_needs_plan_revisions' }],
    ] as const) {
      expect(await refusal(run()), who).toEqual(expected);
    }

    const before = await footprint(ctx.r1);
    const approved = await approve(ctx.r1);
    expect(approved).toMatchObject({ ok: true, idempotent_replay: false, plan_revision_id: ctx.r1, status: 'approved', revision_number: 1, superseded_revision_id: null });
    expect((await footprint(ctx.r1)).audits - before.audits).toBe(2); // approval_gate + approve
    const [gate] = await admin(`SELECT actor_id, payload FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1`, [ctx.r1]);
    const [appr] = await admin(`SELECT actor_id, payload FROM audit_logs WHERE action = 'central_needs.plan_revision.approve' AND entity_id = $1`, [ctx.r1]);
    expect(gate).toMatchObject({ actor_id: U_APPROVE, payload: { contract: 'c5-v1' } });
    expect(appr.payload).toMatchObject({ approval_gate_txid: gate.payload.txid });
    expect(await approve(ctx.r1)).toEqual({ ok: true, idempotent_replay: true, plan_revision_id: ctx.r1, status: 'approved' });
    ctx.r1LinesApproved = await rows(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1) ORDER BY id', [ctx.r1]);
    expect(ctx.r1LinesApproved).toHaveLength(12);
  });

  // ==========================================================================
  // L10 — the governed correction revision
  // ==========================================================================
  it('L10: a new annual draft is refused; a correction must name the latest revision; the approved revision stays effective meanwhile', async () => {
    expect(await refusal(call(U_EDIT, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result', [ORG, PLAN_YEAR, false])))
      .toMatchObject({ code: '23514', message: 'plan_revision_already_closed' });
    const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';
    expect(await refusal(call(U_EDIT, OPEN_CORRECTION, [ORG, PLAN_YEAR, U_EDIT, 'hospital return revised'])))
      .toMatchObject({ code: '23514', message: 'central_needs_correction_plan_mismatch' });
    expect(await refusal(call(U_EDIT, OPEN_CORRECTION, [ORG, PLAN_YEAR, ctx.r1, '  ​ '])))
      .toMatchObject({ code: '23514', message: 'correction_reason_required' });
    const opened = await call(U_EDIT, OPEN_CORRECTION, [ORG, PLAN_YEAR, ctx.r1, 'C6 governed correction: one hospital return revised']);
    expect(opened).toMatchObject({ ok: true, revision_number: 2, status: 'draft', opened_after_revision_id: ctx.r1, effective_approved_revision_id: ctx.r1 });
    ctx.r2 = opened.plan_revision_id as string;
    // A second correction still naming revision 1 is now stale — and writes nothing.
    const before = await footprint(ctx.r2);
    const stale = await refusal(call(U_EDIT, OPEN_CORRECTION, [ORG, PLAN_YEAR, ctx.r1, 'a concurrent second correction']));
    expect(stale).toMatchObject({ code: '23514', message: 'central_needs_revision_stale' });
    expect(stale.detail).toMatch(new RegExp(`^expected_latest=${ctx.r1} \\(revision 1\\) actual_latest=${ctx.r2} \\(revision 2, draft\\)$`));
    expect(await footprint(ctx.r2)).toEqual(before);
    const life = await call(U_VIEW, 'SELECT public.phoenix_central_needs_revision_lifecycle($1,$2) AS result', [ORG, PLAN_YEAR]);
    expect(life.effective_revision_id).toBe(ctx.r1);
  });

  it('L10: the correction re-imports the certified archive, is decided again, and corrects ONE quantity through a recorded override', async () => {
    const { finalize } = await importThroughEndpoints({ uploadTicket, finalizeImport, token: T.edit, planRevisionId: ctx.r2,
      containerKind: 'zip', source: corpus, previewJson });
    expect(finalize!.status).toBe(200);
    expect(finalize!.body).toMatchObject({ ok: true, idempotentReplay: false, acceptedEntryCount: 57, excludedEntryCount: 14 });
    expect(finalize!.body.batchId).not.toBe(ctx.r1Batch);
    // (L3's refused upload left its staging pair behind for the bucket's staging lifecycle — never permanent evidence.)
    expect(storedObjectKeys().filter((k) => k.startsWith('permanent/')))
      .toEqual([`permanent/${ORG}/${ctx.r1}/${C6_CORPUS.sha256}`, `permanent/${ORG}/${ctx.r2}/${C6_CORPUS.sha256}`].sort());
    const manifest = await sessionsByOrdinal(ctx.r2);
    const s13 = manifest.get(W13.ordinal)!.import_session_id as string;
    const s20 = manifest.get(W20.ordinal)!.import_session_id as string;
    ctx.r2s13 = s13;
    const pending = await admin(`SELECT DISTINCT r.import_session_id, r.target_entity FROM central_needs_source_records r
                                   JOIN central_needs_import_sessions s ON s.id = r.import_session_id WHERE s.plan_revision_id = $1 ORDER BY 1, 2`, [ctx.r2]);
    expect(pending).toHaveLength(EXPECTED.targetEntities);
    const saved = { s13: ctx.s13, s20: ctx.s20 };
    ctx.s13 = s13; ctx.s20 = s20; // sampleItemFor reads the revision's own sample sessions
    for (const p of pending) {
      const item = sampleItemFor(p.import_session_id, p.target_entity);
      await dispose(p.import_session_id, p.target_entity, item ? 'mapped' : 'not_applicable', item, item ? null : 'outside the C6 certified sample');
    }
    expect((await decideColumns(ctx.r2, s13)).ok).toBe(true);
    expect((await setRegions(ctx.r2, s20, regionChanges())).ok).toBe(true);

    // The correction: H2 (workbook 13, row 1, BENE.A's column) is revised by a recorded override.
    const h2 = await recordAt(s13, W13.sheet, 1, 7);
    const corrected = h2.source_values.value - 10;
    const ov = await call(U_EDIT, 'SELECT public.phoenix_central_needs_record_field_override($1,$2::jsonb,$3,$4,$5) AS result',
      [h2.id, JSON.stringify(corrected), 'hospital return revised', 'C6 governed correction', 'C6-REF-1']);
    expect(ov).toMatchObject({ ok: true, final_value: corrected });
    ctx.override = { id: ov.override_id, record: h2.id, original: h2.source_values.value, corrected };

    for (const l of await sampleLines(s13, s20)) {
      const isCorrected = l.cells[0].rec.id === h2.id;
      const qty = String(isCorrected ? corrected : l.cells[0].rec.source_values.value);
      const out = await setLine(ctx.r2, { bene: l.bene, item: l.item, qty,
        sources: [{ sourceRecordId: l.cells[0].rec.id, designatedQuantity: qty, appliedOverrideId: isCorrected ? ov.override_id : null }],
        unit: l.item === ITEM[1] ? 'box' : 'other', sourceUnitText: await unitTextOf(s13, l.unitCell) });
      expect(out).toMatchObject({ ok: true, approved_quantity: qty });
    }
    Object.assign(ctx, { r2s20: s20 }, { s13: saved.s13, s20: saved.s20 });
    // The source evidence itself is untouched: the override is a separate, reasoned row.
    expect((await recordAt(s13, W13.sheet, 1, 7)).source_values.value).toBe(ctx.override.original);
    expect(await readiness(ctx.r2)).toMatchObject({ ready: true, blockers: [] });
  });

  it('L10: the correction is submitted and approved; the predecessor is superseded atomically in the same transaction', async () => {
    expect(await submit(ctx.r2)).toMatchObject({ status: 'submitted' });
    const approved = await approve(ctx.r2);
    expect(approved).toMatchObject({ ok: true, status: 'approved', revision_number: 2, superseded_revision_id: ctx.r1 });
    const statuses = await admin(`SELECT revision_number, status, approved_by FROM central_needs_plan_revisions WHERE plan_id = $1 ORDER BY revision_number`, [ctx.planId]);
    expect(statuses).toEqual([
      { revision_number: 1, status: 'superseded', approved_by: U_APPROVE },
      { revision_number: 2, status: 'approved', approved_by: U_APPROVE },
    ]);
    const [txids] = await admin(`SELECT (SELECT payload->>'txid' FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1) AS gate,
                                        (SELECT payload->>'approval_gate_txid' FROM audit_logs WHERE action = 'central_needs.plan_revision.approve' AND entity_id = $1) AS approve,
                                        (SELECT count(*)::int FROM audit_logs WHERE action = 'central_needs.plan_revision.supersede' AND entity_id = $2) AS supersedes`, [ctx.r2, ctx.r1]);
    expect(txids.gate).toBe(txids.approve);
    expect(txids.supersedes).toBe(1);
    const lines = await rows(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1)', [ctx.r2]);
    const corrected = lines.find((x: any) => x.sources.some((s: any) => s.source_record_id === ctx.override.record));
    expect(corrected).toMatchObject({ beneficiary_organization_id: BENE.A, central_item_id: ITEM[1], approved_quantity: String(ctx.override.corrected) });
    expect(corrected.sources[0]).toMatchObject({ designated_quantity: String(ctx.override.corrected), applied_override_id: ctx.override.id });
  });

  // ==========================================================================
  // L11 — history and audit
  // ==========================================================================
  it('L11: the lifecycle read model and the audit trail tell the whole governed history', async () => {
    const life = await call(U_VIEW, 'SELECT public.phoenix_central_needs_revision_lifecycle($1,$2) AS result', [ORG, PLAN_YEAR]);
    expect(life).toMatchObject({ ok: true, plan_id: ctx.planId, effective_revision_id: ctx.r2 });
    expect(life.revisions.map((r: any) => `${r.revision_number}:${r.status}:${r.effective}`)).toEqual(['1:superseded:false', '2:approved:true']);
    // Chronological: the supersede of revision 1 is written before revision 2's approve, in the same transaction.
    expect(life.events.map((e: any) => `${e.action.replace('central_needs.plan_revision.', '')}:${e.revision_number}`))
      .toEqual(['open:1', 'submit:1', 'approve:1', 'open_correction:2', 'submit:2', 'supersede:1', 'approve:2']);
    const approve2 = life.events.find((e: any) => e.action === 'central_needs.plan_revision.approve' && e.revision_number === 2);
    const supersede1 = life.events.find((e: any) => e.action === 'central_needs.plan_revision.supersede');
    expect(approve2).toMatchObject({ actor_id: U_APPROVE, from_status: 'submitted', to_status: 'approved', predecessor_revision_id: ctx.r1 });
    expect(supersede1).toMatchObject({ revision_id: ctx.r1, from_status: 'approved', to_status: 'superseded', superseded_by_revision_id: ctx.r2 });
    expect(supersede1.occurred_at).toBe(approve2.occurred_at);
    const audit = await admin(`SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action LIKE 'central_needs.%' GROUP BY 1 ORDER BY 1`, [ORG]);
    expect(Object.fromEntries(audit.map((a: any) => [a.action, a.n]))).toEqual({
      'central_needs.beneficiary_column.set': 18,
      'central_needs.beneficiary_region.add': 8,
      'central_needs.field_override.record': 1,
      'central_needs.import_batch.register': 2,
      'central_needs.import_session.authoritative_replay': 114,
      'central_needs.import_session.start': 114,
      'central_needs.need_line.delete': 1,
      'central_needs.need_line.set': 25,
      'central_needs.plan_revision.approval_gate': 2,
      'central_needs.plan_revision.approve': 2,
      'central_needs.plan_revision.open': 1,
      'central_needs.plan_revision.open_correction': 1,
      'central_needs.plan_revision.submission_gate': 2, // M218-FINAL: one per canonical submit
      'central_needs.plan_revision.submit': 2,
      'central_needs.plan_revision.supersede': 1,
      'central_needs.record_disposition.set': 2 * EXPECTED.targetEntities,
    });
  });

  it('L11: the superseded revision is intact, readable, immutable and cannot be resurrected', async () => {
    expect(await rows(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1) ORDER BY id', [ctx.r1])).toEqual(ctx.r1LinesApproved);
    const h2 = await recordAt(ctx.s13, W13.sheet, 1, 7);
    expect(await refusal(setLine(ctx.r1, { bene: BENE.B, item: ITEM[1], qty: '1',
      sources: [{ sourceRecordId: h2.id, designatedQuantity: '1', appliedOverrideId: null }] })))
      .toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    expect(await refusal(decideColumns(ctx.r1, ctx.s13))).toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    // ATTACKS on history: resurrecting the superseded revision, and rewriting its source evidence.
    expect(await refusal(admin(`UPDATE central_needs_plan_revisions SET status = 'approved' WHERE id = $1`, [ctx.r1])))
      .toEqual({ code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${ctx.r1}` });
    expect(await refusal(admin(`UPDATE central_needs_source_records SET source_values = source_values WHERE id = $1`, [h2.id])))
      .toMatchObject({ code: '23514', message: 'central_needs_source_file_immutable' });
    expect(await admin(`SELECT revision_number, status FROM central_needs_plan_revisions WHERE plan_id = $1 ORDER BY 1`, [ctx.planId]))
      .toEqual([{ revision_number: 1, status: 'superseded' }, { revision_number: 2, status: 'approved' }]);
    for (const rev of [ctx.r1, ctx.r2]) {
      const [b] = await admin(`SELECT storage_locator, container_sha256 FROM central_needs_import_batches WHERE plan_revision_id = $1`, [rev]);
      expect(b.container_sha256).toBe(C6_CORPUS.sha256);
      expect(sha256Hex(storedObject(b.storage_locator)!)).toBe(C6_CORPUS.sha256);
    }
    console.info(`[C6 lifecycle] import ${ctx.importMs} ms; ${EXPECTED.targetEntities} dispositions ${ctx.dispositionMs} ms`);
  });
});

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as any)[k])]));
  return v;
}
