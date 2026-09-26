#!/usr/bin/env node
// ===========================================================================
// C5 ACTIVATION RUNBOOK — the ordered §2 / §21 activation window around M217.
//
// WHY THIS EXISTS
// ---------------
// C5 v1.9 §21 makes the activation sequence part of C5 correctness: a
// complete submit/approve EXECUTE freeze, a pre-freeze transaction drain,
// governed rejection of every submitted revision, and two independent
// lifecycle/audit proofs must surround M217, and the captured ACL may only be
// restored after all of them PASS. §22 keeps that DCL out of migration
// history. This CLI runs the sequence; every decision it takes is made by the
// pure contract (c5-activation-contract.mjs) over the reads in
// c5-activation-sql.mjs. It applies NO migration itself: M217 is applied by
// the pinned executor between the `resolve` and `post-apply` phases, and this
// tool only gates and records.
//
// MUTATIONS: this tool is READ-ONLY except for exactly three things, all
// inside the activation window it governs: the §2.2 freeze DCL transaction,
// the §2.6 restore DCL transaction (each verified INSIDE its transaction and
// rolled back unless the result is exactly the planned set), and governed
// rejections through the canonical reject RPC executed AS the designated
// operator identity. It never edits a status, an audit row or a history row.
//
// TARGETS: LOOPBACK REHEARSAL BY DEFAULT. Any non-loopback URL is refused
// unless --target=production AND the connection string addresses the pinned
// project ref AND PHOENIX_C5_ACTIVATION_AUTHORIZATION carries the exact
// authorization phrase. Production activation is NOT authorized: it needs a
// separate, explicit Owner Production authorization, and this tool must not
// be pointed at Production without one.
//
// EVIDENCE: every step writes sealed JSON into --evidence-dir (which must be
// OUTSIDE the repository), one directory per attempt, with a sha256sum-format
// SHA256SUMS.txt manifest re-verified at the start of every phase. Later
// attempts must reference and disposition earlier ones (H3); the ledger is
// bound to one database identity and one evidence root (D-09).
//
// FREEZE STATE IS CATALOG TRUTH (D-03): the planned frozen set is sealed and a
// write-ahead `freeze_committed: 'unknown'` is persisted BEFORE the freeze
// COMMIT, the commit is persisted immediately after it, and every HOLD after
// T0 records freeze_in_place from the live ACL (deriveFreezeState), never from
// what a transaction was believed to do.
//
// Usage (one phase per invocation, in order):
//   PHOENIX_C5_ACTIVATION_DATABASE_URL=postgresql://postgres@127.0.0.1:55452/rehearsal \
//   PHOENIX_C5_REJECT_OPERATOR_ID=<profile uuid> \
//   PHOENIX_MIGRATION_FILENAME=217_phoenix_central_needs_c5_safety_convergence.sql \
//   PHOENIX_MIGRATION_SHA256=<64 hex> PHOENIX_EXPECTED_CURRENT_CEILING=216 \
//   PHOENIX_EXPECTED_NEXT_CEILING=217 PHOENIX_REMOTE_HISTORY_VERSION=<14 digits> \
//     node tools/phoenix-demo/c5-activation-runbook.mjs --phase=preflight --evidence-dir=D:/phoenix-evidence/<campaign>
//   ... --phase=freeze (within PREFLIGHT_MAX_AGE_SECONDS of the preflight)
//   ... --phase=resolve (re-run while the drain WAITs)
//   [executor applies M217]
//   ... --phase=post-apply --executor-run-id=<run id> --executor-conclusion=<success|failure|cancelled>
//       (re-runnable after a transient read error: it re-classifies and continues)
//   ... --phase=stop   (operator STOP; after READY_FOR_M217 it also needs
//       --executor-conclusion=not_dispatched|failure|cancelled [+ --executor-run-id])
// Optional: --attempt=<id> (default: the latest open attempt),
// --reviewed-cascade=<Owner review reference> (Owner-reviewed grant-option path),
// --dispositions=<json file> (H3), --expected-prior-attempts=<n> and
// --expected-ledger-sha256=<hex> (the Owner-recorded ledger anchor; REQUIRED
// for --target=production).
// Exit codes: 0 PASS / READY_FOR_M217 / step done, 1 refusal or HOLD, 2 drain WAIT.
// ===========================================================================
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { declaresManualApplyOnly, parseMigrationVersion } from './production-migration-contract.mjs';
import * as C from './c5-activation-contract.mjs';
import * as Q from './c5-activation-sql.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const errOf = (e) => ({ code: e?.code ?? null, message: String(e?.message ?? e), detail: e?.detail ?? null });

// ---------------------------------------------------------------------------
// Local catalogue.
// ---------------------------------------------------------------------------

/** Every migration in the checkout, with its exact byte hash (as the executor preflight reads it). */
export function readLocalMigrations(migrationsDir = MIGRATIONS_DIR) {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => {
      const version = parseMigrationVersion(filename);
      if (version === null) {
        throw new C.C5ActivationRefusal('LOCAL_MANIFEST_UNRECOGNIZED',
          `supabase/migrations contains ${JSON.stringify(filename)}, which is not a NNN_lower_snake_case.sql migration filename.`);
      }
      const bytes = readFileSync(join(migrationsDir, filename));
      return { version, filename, sha256: sha256(bytes), manualApplyOnly: declaresManualApplyOnly(bytes.toString('utf8')) };
    })
    .sort((a, b) => a.version - b.version);
}

// ---------------------------------------------------------------------------
// Evidence store — outside the repository, sealed by a sha256sum manifest.
// ---------------------------------------------------------------------------

const STATE_FILE = 'attempt-state.json';
const MANIFEST_FILE = 'SHA256SUMS.txt';
const SECRET_PATTERN = /postgres(?:ql)?:\/\//i;

export class EvidenceStore {
  constructor(evidenceDir, { repoRoot = REPO_ROOT } = {}) {
    C.assertEvidenceDirOutsideRepo(evidenceDir && resolve(evidenceDir), repoRoot);
    this.root = resolve(evidenceDir);
    mkdirSync(this.root, { recursive: true });
  }

  dir(attemptId) { return join(this.root, attemptId); }

  /** Attempt directories, in sequence order. */
  listAttempts() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^attempt-\d{3}-/.test(d.name) && existsSync(join(this.root, d.name, STATE_FILE)))
      .map((d) => d.name)
      .sort();
  }

  readState(attemptId) {
    return JSON.parse(readFileSync(join(this.dir(attemptId), STATE_FILE), 'utf8'));
  }

  /** Recompute every hash; any unlisted, missing or altered file fails. */
  verifyManifest(attemptId) {
    const dir = this.dir(attemptId);
    const path = join(dir, MANIFEST_FILE);
    if (!existsSync(path)) return false;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const listed = new Map(lines.map((l) => {
      const m = /^([0-9a-f]{64}) \*\.\/(.+)$/.exec(l);
      return m ? [m[2], m[1]] : ['', ''];
    }));
    if (listed.has('')) return false;
    const onDisk = readdirSync(dir).filter((f) => f !== MANIFEST_FILE).sort();
    if (JSON.stringify(onDisk) !== JSON.stringify([...listed.keys()].sort())) return false;
    return onDisk.every((f) => sha256(readFileSync(join(dir, f))) === listed.get(f));
  }

  manifestSha256(attemptId) {
    return sha256(readFileSync(join(this.dir(attemptId), MANIFEST_FILE)));
  }

  #writeManifest(attemptId) {
    const dir = this.dir(attemptId);
    const lines = readdirSync(dir).filter((f) => f !== MANIFEST_FILE).sort()
      .map((f) => `${sha256(readFileSync(join(dir, f)))} *./${f}`);
    writeFileSync(join(dir, MANIFEST_FILE), `${lines.join('\n')}\n`);
  }

  #writeJson(attemptId, file, obj) {
    const text = `${JSON.stringify(obj, null, 2)}\n`;
    if (SECRET_PATTERN.test(text)) {
      throw new C.C5ActivationRefusal('EVIDENCE_CONTAINS_SECRET_PATTERN', `Refusing to write ${file}: it contains a connection-string pattern.`);
    }
    mkdirSync(this.dir(attemptId), { recursive: true });
    writeFileSync(join(this.dir(attemptId), file), text);
    return sha256(text);
  }

  /** Seal one evidence file for a step and persist the attempt state; both enter the manifest. */
  record(state, name, payload) {
    state.evidence_seq = (state.evidence_seq ?? 0) + 1;
    const file = `${String(state.evidence_seq).padStart(2, '0')}-${name}.json`;
    const hash = this.#writeJson(state.attempt_id, file, { attempt_id: state.attempt_id, step: name, recorded_at: new Date().toISOString(), ...payload });
    (state.evidence ??= []).push({ file, sha256: hash });
    this.saveState(state);
    return { file, sha256: hash };
  }

  saveState(state) {
    this.#writeJson(state.attempt_id, STATE_FILE, state);
    this.#writeManifest(state.attempt_id);
  }
}

// ---------------------------------------------------------------------------
// I/O adapters. Same {asAdmin, asUser} shape as tools/pg-rig/rig.mjs and
// tools/pg-rig/remote-io.mjs, so the rehearsal can hand the rig straight in.
// ---------------------------------------------------------------------------

function redact(str, secret) {
  if (!secret || !str) return str;
  return String(str).split(secret).join('[REDACTED]');
}

/** Loopback rehearsal I/O: no TLS (a disposable local cluster), errors redacted, SQLSTATE kept. */
export async function buildLoopbackIo({ connectionString, maxConnections = 4 } = {}) {
  const pool = new pg.Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
  pool.on('error', (err) => {
    const benign = err?.code === '57P01' || err?.code === 'ECONNRESET' || /terminat/i.test(err?.message ?? '');
    if (!benign) throw new Error(redact(err?.message ?? String(err), connectionString));
  });
  const wrap = (e) => Object.assign(new Error(redact(e?.message ?? String(e), connectionString)),
    { code: e?.code, detail: redact(e?.detail, connectionString) });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    throw new Error(`buildLoopbackIo: initial connection failed: ${redact(e?.message ?? String(e), connectionString)}`);
  }
  async function asUser(userId, fn, { role = 'authenticated', commit = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      const out = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw wrap(e);
    } finally {
      client.release();
    }
  }
  async function asAdmin(fn) {
    const client = await pool.connect();
    try { return await fn(client); } catch (e) { throw wrap(e); } finally { client.release(); }
  }
  return { pool, asUser, asAdmin, async end() { await pool.end(); } };
}

const one = async (io, sql, params = []) => io.asAdmin(async (c) => (await c.query(sql, params)).rows[0]);
const all = async (io, sql, params = []) => io.asAdmin(async (c) => (await c.query(sql, params)).rows);


const sha256Text = (text) => sha256(Buffer.from(String(text), 'utf8'));
/** The evidence root as the ledger binds it (D-09): absolute, forward slashes, no trailing slash, case-folded. */
const normalizedRoot = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ---------------------------------------------------------------------------
// Reads shared by several phases.
// ---------------------------------------------------------------------------

/** The three drain reads, each on the attested runner connection. */
export async function readDrain(io, f0) {
  return io.asAdmin(async (c) => {
    const runner = (await c.query(Q.RUNNER_SQL)).rows[0];
    const preF0 = (await c.query(Q.DRAIN_PRE_F0_SQL, [f0])).rows;
    const hidden = (await c.query(Q.DRAIN_HIDDEN_SESSIONS_SQL)).rows;
    const prepared = (await c.query(Q.DRAIN_PREPARED_SQL)).rows;
    const decision = C.evaluateDrain({ preF0Rows: preF0, hiddenRows: hidden, preparedRows: prepared });
    return { runner, pre_f0_rows: preF0, hidden_rows: hidden, prepared_rows: prepared, ...decision };
  });
}

async function readProofs(io, { t0, a0 }) {
  const a0Ids = (a0 ?? []).map((r) => r.id);
  const current = (await all(io, Q.PROOF_A_CURRENT_SQL, [a0Ids])).map((r) => r.row);
  const beforeKeys = new Map((a0 ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const candidateIds = [...new Set([
    ...current.filter((r) => beforeKeys.get(r.id) !== JSON.stringify(r)).map((r) => r.id),
    ...a0Ids.filter((id) => !current.some((r) => r.id === id)),
  ])];
  const audits = candidateIds.length ? await all(io, Q.PROOF_A_EVIDENCE_SQL, [candidateIds, candidateIds]) : [];
  const proofA = C.evaluateProofA({ a0, current, audits, t0 });
  const proofB = C.evaluateProofB({ rows: await all(io, Q.PROOF_B_SQL, [t0]) });
  return { proofA, proofB };
}

async function readCensus(io) {
  return (await one(io, Q.LIFECYCLE_AUDIT_CENSUS_SQL)).census;
}

async function readRunner(io, state, where) {
  const attrs = await one(io, Q.RUNNER_ATTRIBUTES_SQL);
  const runner = C.assertRunnerCapability(attrs);
  if (state.runner) C.assertSameRunner(state.runner, attrs, where);
  return { runner, attrs };
}

async function readOperator(io, operatorId, extraIds = []) {
  const row = await one(io, Q.REJECT_OPERATOR_SQL, [operatorId, extraIds]);
  return {
    row,
    verdict: C.assertRejectOperatorReady({
      operator: row.operator, ownerOrgs: row.owner_orgs, rejectExecutableByAuthenticated: row.reject_executable_by_authenticated,
    }),
  };
}

/** The live submit/approve ACL, or null when it cannot be read — never a guess. */
async function readLiveAcl(io) {
  try { return (await one(io, Q.FREEZE_ACL_SQL)).acl; } catch { return null; }
}

/** D-09: the database identity the attempt ledger is bound to. */
async function readDatabaseIdentity(io) {
  const row = await one(io, Q.DATABASE_IDENTITY_SQL);
  const systemIdentifier = row.can_read_system_identifier === true ? (await one(io, Q.SYSTEM_IDENTIFIER_SQL)).system_identifier : null;
  return { database: row.database, database_oid: row.database_oid, system_identifier: systemIdentifier };
}

/**
 * H9 / D-02 facts: history, catalog state + body fingerprints, and the
 * in-flight M217 check. Each is read on its own so an unreadable fact is
 * RECORDED (and classifies UNKNOWN) instead of being guessed.
 *
 * A-01: the in-flight check brackets the catalog reads — once BEFORE and once
 * AFTER — and both must be empty. An M217 that was running when the catalog was
 * read is then seen by the later read unless it committed in between, and an
 * M217 committed before the catalog read is seen by the catalog. This narrows
 * the window; only the in-transaction re-proof in restoreAcl (under the A-01
 * exclusion lock) closes it for the restore itself.
 */
async function readM217Facts(io) {
  const facts = {
    remote_rows: null, history_error: null, m217_state: null, catalog_error: null,
    in_flight: null, in_flight_error: null, in_flight_before: null, in_flight_after: null,
  };
  try { facts.in_flight_before = await one(io, Q.M217_IN_FLIGHT_SQL); } catch (e) { facts.in_flight_error = errOf(e); }
  try { facts.remote_rows = await all(io, Q.HISTORY_SQL); } catch (e) { facts.history_error = errOf(e); }
  try { facts.m217_state = await one(io, Q.M217_STATE_SQL); } catch (e) { facts.catalog_error = errOf(e); }
  try { facts.in_flight_after = await one(io, Q.M217_IN_FLIGHT_SQL); } catch (e) { facts.in_flight_error = facts.in_flight_error ?? errOf(e); }
  facts.in_flight = mergeInFlight(facts.in_flight_before, facts.in_flight_after);
  return facts;
}

/** A-01: the union of two in-flight reads; null (unproven) unless both were read. */
function mergeInFlight(before, after) {
  if (!before || !after) return null;
  const list = (k) => (Array.isArray(before[k]) && Array.isArray(after[k]) ? [...before[k], ...after[k]] : null);
  return { locks: list('locks'), sessions: list('sessions'), hidden: list('hidden'), runner: after.runner ?? before.runner ?? null };
}

function classifyFacts(state, facts, { requireExecutor, executor }) {
  const expectedVersion = state.attestation?.m217?.remote_history_version;
  const m = facts.m217_state;
  const rows = facts.remote_rows;
  return C.classifyM217Outcome({
    historyReadable: rows !== null,
    historyRowPresent: rows === null ? undefined : rows.some((r) => r.version === expectedVersion || r.name === C.M217_HISTORY_NAME),
    objects: m && { classifier: m.classifier, lineageHelper: m.lineage_helper, fenceFunction: m.fence_function, fenceTrigger: m.fence_trigger, valueContract: m.value_contract },
    bodies: m?.bodies,
    nonCommit: {
      requireExecutor, executor,
      inFlight: facts.in_flight,
      t0Fingerprints: state.fingerprints0 ?? null,
      fingerprints: m?.fingerprints ?? null,
      historyRowCount: rows === null ? null : rows.length,
      attestedRowCount: state.attestation?.remote_row_count,
    },
  });
}

const restorationTargetOf = (state) => C.attemptAcl0Target(state);
const frozenSetOf = (state) => C.attemptFrozenSet(state);

/** D-03: the freeze state from catalog truth — the live ACL against the restoration target and the frozen set. */
async function freezeTruth(io, state) {
  const liveAcl = await readLiveAcl(io);
  return { liveAcl, truth: C.deriveFreezeState({ liveAcl, acl0: restorationTargetOf(state), frozenAcl: frozenSetOf(state) }) };
}

// ---------------------------------------------------------------------------
// Attempt lifecycle.
// ---------------------------------------------------------------------------

function complete(state, step) {
  C.assertStepInOrder(state.completed, step);
  state.completed.push(step);
}

function conclude(ctx, state, conclusion) {
  state.conclusion = { concluded_at: new Date().toISOString(), ...conclusion };
  ctx.store.record(state, 'conclusion', { conclusion: state.conclusion, completed: state.completed });
  return { attempt_id: state.attempt_id, outcome: conclusion.outcome, conclusion: state.conclusion };
}

/**
 * Every C5_ACTIVATION_HOLD after T0. `freeze_in_place` is what the CATALOG
 * shows at the moment of concluding (D-03): true only when the live ACL is
 * the frozen set, false only when it is the restoration-target ACL0, and
 * 'UNKNOWN' otherwise (or when it cannot be read). A caller cannot assert it.
 */
async function hold(ctx, state, fields) {
  const { liveAcl, truth } = await freezeTruth(ctx.io, state);
  const { freeze_in_place: _ignored, ...rest } = fields;
  return conclude(ctx, state, {
    outcome: C.C5_ACTIVATION_HOLD, ...rest,
    freeze_in_place: truth.freeze_in_place, freeze_state: truth.state, acl_at_conclusion: liveAcl,
  });
}

function loadOpenAttempt(ctx) {
  const ids = ctx.store.listAttempts();
  const id = ctx.attemptId ?? ids[ids.length - 1];
  if (!id) throw new C.C5ActivationRefusal('ATTEMPT_NOT_FOUND', 'No attempt exists in this evidence directory; run --phase=preflight first.');
  if (!ctx.store.verifyManifest(id)) throw new C.C5ActivationRefusal('EVIDENCE_TAMPERED', `Attempt ${id}'s evidence no longer matches its SHA256SUMS.txt.`);
  const state = ctx.store.readState(id);
  C.assertAttemptOpen(state);
  return state;
}

/**
 * The §2.6 restore: ONE DCL transaction re-granting exactly the restoration
 * target (ACL0, or an ACL0 carried forward from a prior attempt), only if the
 * ACL is still exactly the frozen set. D-07: the result is compared with the
 * target INSIDE the transaction and COMMITTED only on exact order-insensitive
 * equality; any mismatch rolls back, so the freeze stays intact. The catalog
 * is re-read afterwards on a fresh connection as the recorded truth.
 *
 * A-01: a restore justified by FAILED_CLEAN (`m217Guard` = the executor inputs
 * of that classification) first takes RESTORE_M217_EXCLUSION_LOCK_SQL and then
 * re-proves non-commit INSIDE the transaction (history, catalog, fingerprints,
 * in-flight) with the same classification. While the lock is held no M217 can
 * commit, so the proof still holds at COMMIT. An M217 found in flight (the lock
 * NOWAIT fails) or not proven absent rolls the restore back:
 * M217_PRESENT_AT_RESTORE, freeze kept, nothing restored. The restore after a
 * post-apply PASS (M217 APPLIED by design) passes no guard.
 */
async function restoreAcl(ctx, state, { m217Guard = null } = {}) {
  const target = restorationTargetOf(state);
  const frozen = frozenSetOf(state);
  const statements = C.planRestoreStatements(target);
  let result = null;
  try {
    await ctx.io.asAdmin(async (c) => {
      await c.query('BEGIN');
      let committing = false;
      try {
        await c.query(Q.DCL_LOCK_TIMEOUT_SQL);
        if (m217Guard) {
          try {
            await c.query(Q.RESTORE_M217_EXCLUSION_LOCK_SQL);
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            // 55P03: another backend (M217) holds ACCESS EXCLUSIVE on source_records.
            result = e?.code === '55P03'
              ? { ok: false, code: 'M217_PRESENT_AT_RESTORE', m217: 'IN_FLIGHT', error: errOf(e) }
              : { ok: false, code: 'ACL_RESTORE_FAILED', error: errOf(e) };
            return;
          }
          const inTxFacts = {
            remote_rows: (await c.query(Q.HISTORY_SQL)).rows,
            m217_state: (await c.query(Q.M217_STATE_SQL)).rows[0],
            in_flight: (await c.query(Q.M217_IN_FLIGHT_SQL)).rows[0],
          };
          const inTx = classifyFacts(state, inTxFacts, m217Guard);
          if (inTx.outcome !== C.M217_OUTCOMES.FAILED_CLEAN) {
            await c.query('ROLLBACK');
            result = { ok: false, code: 'M217_PRESENT_AT_RESTORE', m217: inTx.outcome, in_transaction_outcome: inTx };
            return;
          }
        }
        const cur = (await c.query(Q.FREEZE_ACL_SQL)).rows[0].acl;
        if (!C.aclSetsEqual(cur, frozen)) {
          await c.query('ROLLBACK');
          result = { ok: false, code: 'ACL_FROZEN_CHANGED', unexpected: C.aclSetDifference(cur, frozen), missing: C.aclSetDifference(frozen, cur) };
          return;
        }
        for (const s of statements) await c.query(s);
        const inTx = (await c.query(Q.FREEZE_ACL_SQL)).rows[0].acl;
        if (!C.aclSetsEqual(inTx, target)) {
          await c.query('ROLLBACK');
          result = { ok: false, code: 'ACL_RESTORE_MISMATCH', unexpected: C.aclSetDifference(inTx, target), missing: C.aclSetDifference(target, inTx) };
          return;
        }
        committing = true;
        await c.query('COMMIT');
        result = { ok: true, verified_in_transaction: true };
      } catch (e) {
        if (!committing) await c.query('ROLLBACK').catch(() => {});
        result = { ok: committing ? 'unknown' : false, code: committing ? 'ACL_RESTORE_COMMIT_UNKNOWN' : 'ACL_RESTORE_FAILED', error: errOf(e) };
      }
    });
  } catch (e) {
    result = result ?? { ok: 'unknown', code: 'ACL_RESTORE_CONNECTION_FAILED', error: errOf(e) };
  }
  let after = null;
  let text = null;
  let readError = null;
  try {
    after = (await one(ctx.io, Q.FREEZE_ACL_SQL)).acl;
    text = (await one(ctx.io, Q.FREEZE_ACL_TEXT_SQL)).acl_text;
  } catch (e) {
    readError = errOf(e);
  }
  const setEqual = Array.isArray(after) && C.aclSetsEqual(after, target);
  const truth = C.deriveFreezeState({ liveAcl: after, acl0: target, frozenAcl: frozen });
  return {
    statements, ...result, acl_after: after, acl_text_after: text, acl_read_error: readError, set_equal: setEqual,
    acl_text_equal_to_t0_text: JSON.stringify(text) === JSON.stringify(state.acl0_text ?? null),
    freeze_state_after: truth.state,
    restored: result.ok !== false && setEqual,
  };
}

/**
 * STOP (§2.4 / H3): C5_ACTIVATION_HOLD. Proof A/B and the census run against
 * THIS attempt's own T0/A0/L0 and are sealed. ACL0 is restored ONLY when:
 *   - M217 non-commit is PROVEN (D-01/D-02): history row absent, every M217
 *     object absent, every replaced body identical to its T0 fingerprint (the
 *     pre-C5 approve included), no in-flight M217 backend, the history still
 *     the attested count and — once READY_FOR_M217 exists, i.e. the executor
 *     may have been dispatched — the executor's terminal NON-success state
 *     (`options.executorRun`);
 *   - AND catalog truth says the freeze is in place (D-03).
 * At/after READY_FOR_M217 a STOP that finds M217 (partly) present is REFUSED
 * (STOP_M217_PRESENT): the attempt stays open, the freeze is kept, and
 * --phase=post-apply decides. Anything unproven is a HOLD that restores
 * nothing.
 */
async function stopBeforeM217(ctx, state, reason) {
  C.assertCanStop(state);
  const executor = C.assertExecutorRun(ctx.options?.executorRun ?? null);
  const readyReached = state.completed.includes('READY_FOR_M217');
  const proofs = await readProofs(ctx.io, state);
  const census = C.evaluateLifecycleAuditCensus({ l0: state.l0, current: await readCensus(ctx.io), union: state.union ?? state.s0, s0: state.s0 });
  ctx.store.record(state, 'stop-proofs', { reason, proof_a: proofs.proofA, proof_b: proofs.proofB, census });
  const summary = { proof_a_deltas: proofs.proofA.deltas.length, proof_b_pass: proofs.proofB.pass, census_pass: census.pass };

  const facts = await readM217Facts(ctx.io);
  const outcome = classifyFacts(state, facts, { requireExecutor: readyReached, executor });
  const { liveAcl, truth } = await freezeTruth(ctx.io, state);
  ctx.store.record(state, 'stop-m217-check', {
    reason, ready_for_m217_reached: readyReached, executor, outcome, ...facts, acl_now: liveAcl, freeze_truth: truth,
  });

  if (outcome.outcome === C.M217_OUTCOMES.APPLIED || outcome.outcome === C.M217_OUTCOMES.FAILED_PARTIAL) {
    if (readyReached) {
      throw new C.C5ActivationRefusal('STOP_M217_PRESENT',
        `M217 is ${outcome.outcome} in the catalog; a STOP after READY_FOR_M217 may not restore. The freeze is kept and nothing ` +
          'was restored: run --phase=post-apply, which classifies the outcome and verifies before any restore.',
        { hold: true, m217: outcome.outcome });
    }
    return hold(ctx, state, { stage: 'STOP_M217_PRESENT', reason, m217: outcome.outcome, restored: false, ...summary });
  }
  if (outcome.outcome !== C.M217_OUTCOMES.FAILED_CLEAN) {
    return hold(ctx, state, {
      stage: 'STOP_M217_NON_COMMIT_UNPROVEN', reason, m217: outcome.outcome, unproven: outcome.unproven ?? [outcome.reason],
      restored: false, ...summary,
    });
  }
  if (truth.state === C.FREEZE_STATES.IN_PLACE) {
    state.freeze_committed = true;
    const restore = await restoreAcl(ctx, state, { m217Guard: { requireExecutor: readyReached, executor } });
    ctx.store.record(state, 'stop-acl-restore', { restore });
    if (restore.code === 'M217_PRESENT_AT_RESTORE') {
      // A-01: M217 committed (or is committing) after the classification above.
      if (readyReached) {
        throw new C.C5ActivationRefusal('STOP_M217_PRESENT',
          `M217 was found ${restore.m217} inside the restore transaction; the restore was rolled back. The freeze is kept and ` +
            'nothing was restored: run --phase=post-apply, which classifies the outcome and verifies before any restore.',
          { hold: true, m217: restore.m217 });
      }
      return hold(ctx, state, { stage: 'STOP_M217_PRESENT', reason, m217: restore.m217, restored: false, ...summary });
    }
    return hold(ctx, state, { stage: 'STOP_BEFORE_M217', reason, restored: restore.restored, ...summary });
  }
  if (truth.state === C.FREEZE_STATES.NOT_IN_PLACE) {
    return hold(ctx, state, { stage: 'STOP_BEFORE_M217', reason, restored: 'not_needed', ...summary });
  }
  return hold(ctx, state, { stage: 'STOP_FREEZE_STATE_UNKNOWN', reason, restored: false, freeze_reason: truth.reason, ...summary });
}

// ---------------------------------------------------------------------------
// Phase: preflight (H12, H1, H7, H3 + the D-09 ledger anchor) — read-only.
// ---------------------------------------------------------------------------

export async function runPreflight(ctx) {
  const { io, store, options } = ctx;
  const priorIds = store.listAttempts();
  const prior = priorIds.map((id) => ({ ...store.readState(id), manifest_ok: store.verifyManifest(id) }));
  // the chain: every attempt names all attempts before it; none may vanish
  prior.forEach((p, i) => {
    const expected = priorIds.slice(0, i);
    if (p.sequence !== i + 1 || JSON.stringify((p.prior_attempts ?? []).map((x) => x.attempt_id)) !== JSON.stringify(expected)) {
      throw new C.C5ActivationRefusal('PRIOR_ATTEMPT_CHAIN_BROKEN', `Attempt ${p.attempt_id} does not chain to the attempts before it; evidence is missing or reordered.`);
    }
  });
  const sequence = prior.length + 1;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const state = {
    attempt_id: `attempt-${String(sequence).padStart(3, '0')}-${stamp}`,
    sequence,
    created_at: new Date().toISOString(),
    target: options.target ?? 'rehearsal',
    operator_id: C.assertOperatorId(options.operatorId),
    reviewed_cascade: C.assertReviewedCascade(options.reviewedCascade),
    executor: { ...options.executor },
    prior_attempts: prior.map((p) => ({
      attempt_id: p.attempt_id, outcome: p.conclusion?.outcome ?? null, manifest_ok: p.manifest_ok,
      manifest_sha256: p.manifest_ok ? store.manifestSha256(p.attempt_id) : null,
    })),
    completed: [],
    conclusion: null,
  };
  store.saveState(state);

  try {
    // D-09 — the ledger anchor first, so every later attempt can check it.
    const database = await readDatabaseIdentity(io);
    state.ledger_anchor = { database, evidence_root_sha256: sha256Text(normalizedRoot(store.root)) };
    store.saveState(state);

    // H12 — fresh history, sealed identities, executor inputs, before T0.
    const localMigrations = readLocalMigrations(options.migrationsDir ?? MIGRATIONS_DIR);
    const remoteRows = await all(io, Q.HISTORY_SQL);
    state.attestation = C.attestProductionHistory({
      remoteRows, localMigrations, sealedM216: options.sealedM216 ?? C.SEALED_M216, executor: options.executor,
    });
    complete(state, 'HISTORY_ATTESTED');
    store.record(state, 'history-attestation', { attestation: state.attestation, remote_rows: remoteRows, ledger_anchor: state.ledger_anchor });

    // H1 — runner capability.
    const { runner, attrs } = await readRunner(io, state, 'runner preflight');
    state.runner = runner;
    complete(state, 'RUNNER_ATTESTED');
    store.record(state, 'runner', { attributes: attrs, verdict: runner });

    // H7 — the governed rejection operator; H11 privileged-writer census.
    const op = await readOperator(io, state.operator_id);
    state.operator = op.verdict;
    const writers = await all(io, Q.PRIVILEGED_WRITERS_SQL);
    complete(state, 'OPERATOR_ATTESTED');
    store.record(state, 'reject-operator', {
      operator: op.row.operator, owner_orgs: op.row.owner_orgs, verdict: op.verdict,
      reject_executable_by_authenticated: op.row.reject_executable_by_authenticated,
      privileged_writers: writers,
      h11: 'Direct DML on central_needs_plan_revisions / audit_logs by any role listed here is prohibited from T0 until the restore; Proof A, Proof B and the lifecycle-audit census detect it.',
    });

    // H3 — every prior attempt referenced and dispositioned: its Proof A/B
    // revision deltas AND its H11 census deltas (D-09), each measured against
    // ITS OWN T0/A0/L0; then the ledger anchor and the ACL expectation (D-03).
    const priorDeltas = {};
    const priorAuditDeltas = {};
    const priorMeasurements = [];
    const currentCensus = await readCensus(io);
    for (const p of prior) {
      if (!p.t0 || !p.conclusion || p.conclusion.outcome === C.C5_ACTIVATION_PASS) continue;
      const proofs = await readProofs(io, { t0: p.t0, a0: p.a0 });
      const ids = [...new Set([
        ...proofs.proofA.deltas.map((d) => d.id),
        ...proofs.proofB.approvals.map((a) => a.entity_id),
        ...proofs.proofB.orphan_gates.map((g) => g.entity_id),
      ])].sort();
      const census = C.evaluateLifecycleAuditCensus({ l0: p.l0 ?? [], current: currentCensus, union: p.union ?? p.s0 ?? [], s0: p.s0 ?? [] });
      const auditIds = C.censusDeltaIds(census);
      priorDeltas[p.attempt_id] = ids;
      priorAuditDeltas[p.attempt_id] = auditIds;
      priorMeasurements.push({ attempt_id: p.attempt_id, t0: p.t0, proof_a: proofs.proofA, proof_b: proofs.proofB, delta_ids: ids, census, audit_delta_ids: auditIds });
    }
    const ledger = C.assertLedgerAnchor({
      target: state.target, priorAttempts: prior, anchor: state.ledger_anchor,
      ledger: { prior_attempts: prior.length, ledger_sha256: sha256Text(C.ledgerDigestInput({ database, priorEntries: state.prior_attempts })) },
      expected: options.ledgerExpected ?? {},
    });
    state.ledger = ledger;
    const verdict = C.assertPriorAttemptsDispositioned({
      priorAttempts: prior, dispositions: options.dispositions ?? [], priorDeltas, priorAuditDeltas,
    });
    state.ledger_expectation = verdict.expectation;
    state.ledger_carry_forward = verdict.carry_forward;
    state.ledger_rebaseline = verdict.rebaseline;
    complete(state, 'PRIOR_ATTEMPTS_DISPOSITIONED');
    // D-05: the preflight is fresh evidence only for PREFLIGHT_MAX_AGE_SECONDS (database clock).
    state.preflight_at = (await one(io, Q.CLOCK_SQL)).now;
    store.record(state, 'prior-attempts', {
      measurements: priorMeasurements, dispositions: options.dispositions ?? [], verdict, ledger, ledger_anchor: state.ledger_anchor,
      preflight_at: state.preflight_at,
    });
  } catch (e) {
    if (e instanceof C.C5ActivationRefusal) {
      conclude(ctx, state, { outcome: C.REFUSED_BEFORE_T0, code: e.code, message: e.message, freeze_in_place: false, restored: 'not_needed' });
    }
    throw e;
  }
  return { attempt_id: state.attempt_id, outcome: 'PREFLIGHT_PASS', completed: state.completed, ledger: state.ledger };
}

// ---------------------------------------------------------------------------
// Phase: freeze (D-05 re-check, §2.1 T0 snapshot, ledger ACL gate, §2.2 DCL
// freeze, F0, sealed frozen ACL). Re-runnable after a post-COMMIT failure.
// ---------------------------------------------------------------------------

/**
 * D-05 — immediately before T0, in the same invocation: the preflight must be
 * fresh (database clock), the history attestation must be EXACTLY the sealed
 * one, and the governed rejection operator must still cover every owner
 * organization of every currently submitted revision.
 */
async function recheckBeforeT0(ctx, state) {
  const { io, store, options } = ctx;
  const now = (await one(io, Q.CLOCK_SQL)).now;
  const age = C.assertPreflightFresh({ preflightAt: state.preflight_at, now, maxAgeSeconds: options?.preflightMaxAgeSeconds });
  const remoteRows = await all(io, Q.HISTORY_SQL);
  const fresh = C.attestProductionHistory({
    remoteRows, localMigrations: readLocalMigrations(options?.migrationsDir ?? MIGRATIONS_DIR),
    sealedM216: options?.sealedM216 ?? C.SEALED_M216, executor: state.executor,
  });
  C.assertAttestationUnchanged(state.attestation, fresh);
  const op = await readOperator(io, state.operator_id);
  store.record(state, 'pre-t0-recheck', { checked_at: now, preflight_age_seconds: age, attestation: fresh, operator: op.verdict, owner_orgs: op.row.owner_orgs });
}

/**
 * After the freeze committed (or catalog truth says it did): F0, the sealed
 * frozen ACL and the §2.2 verification. Every read here may fail transiently;
 * the commit is already durable on disk, so a re-run of --phase=freeze resumes
 * here instead of leaving an attempt that believes nothing was frozen.
 */
async function finishFreeze(ctx, state, statements, tx) {
  const { io, store } = ctx;
  if (!state.f0) {
    // F0 on the committing connection if it was read there; otherwise a
    // fresh reading now, which is LATER than the true commit and therefore
    // only widens the §2.3 drain (conservative).
    state.f0 = tx.f0 ?? (await one(io, Q.CLOCK_SQL)).now;
    state.f0_source = tx.f0 ? 'same_connection_after_commit' : 'fresh_read_after_commit';
    store.saveState(state);
  }
  state.frozen_acl = (await one(io, Q.FREEZE_ACL_SQL)).acl;
  const capturedGrantees = [...new Set(state.acl0.map(C.normalizeAclTuple)
    .filter((t) => t.grantee !== t.owner && t.grantee !== 'PUBLIC').map((t) => t.grantee))];
  const privileges = await all(io, Q.FREEZE_PRIVILEGES_SQL, [[...new Set([...C.CLIENT_ROLES, ...capturedGrantees])]]);
  const rejectNow = (await one(io, Q.REJECT_ACL_SQL)).acl;
  const verdict = C.assessFreeze({ acl0: state.acl0, frozenAcl: state.frozen_acl, privileges, rejectAcl0: state.reject_acl0, rejectAclNow: rejectNow });
  store.record(state, 'acl-freeze', {
    statements, committed: tx.committed === true ? true : tx.committed, transaction: tx, f0: state.f0, f0_source: state.f0_source,
    frozen_acl: state.frozen_acl, freeze_planned: state.freeze_planned, privileges, reject_acl: rejectNow, verdict,
  });
  if (!verdict.pass) {
    return stopBeforeM217(ctx, state, { code: 'ACL_FREEZE_INCOMPLETE', failures: verdict.failures });
  }
  complete(state, 'ACL_FROZEN');
  store.saveState(state);
  return { attempt_id: state.attempt_id, outcome: 'FROZEN', t0: state.t0, f0: state.f0, s0: state.s0.length };
}

export async function runFreeze(ctx) {
  const { io, store } = ctx;
  const state = loadOpenAttempt(ctx);
  const statementsFor = () => C.planFreezeStatements(state.acl0, { reviewedCascade: Boolean(state.reviewed_cascade) });

  // D-03 — resume after a freeze whose COMMIT (or post-COMMIT reads) did not
  // complete in the previous invocation: catalog truth decides.
  if (state.completed[state.completed.length - 1] === 'T0_SNAPSHOT_SEALED'
    && state.freeze_committed !== undefined && state.freeze_committed !== false) {
    await readRunner(io, state, 'freeze resume');
    const { liveAcl, truth } = await freezeTruth(io, state);
    store.record(state, 'acl-freeze-resume', { freeze_committed_recorded: state.freeze_committed, acl_now: liveAcl, freeze_truth: truth });
    if (truth.state === C.FREEZE_STATES.IN_PLACE) {
      const recorded = state.freeze_committed;
      state.freeze_committed = true;
      store.saveState(state);
      return finishFreeze(ctx, state, statementsFor(), { committed: recorded === true ? true : 'established_from_catalog', resumed: true });
    }
    if (truth.state === C.FREEZE_STATES.NOT_IN_PLACE) {
      state.freeze_committed = false;
      return hold(ctx, state, { stage: 'ACL_FREEZE', code: 'ACL_FREEZE_NOT_IN_PLACE', reason: 'catalog truth: the ACL is still ACL0; the freeze did not take effect', restored: 'not_needed' });
    }
    return hold(ctx, state, { stage: 'ACL_FREEZE', code: 'ACL_FREEZE_STATE_UNKNOWN', reason: 'catalog truth: the ACL is neither ACL0 nor the frozen set', restored: false });
  }

  C.assertStepInOrder(state.completed, 'T0_SNAPSHOT_SEALED');
  await readRunner(io, state, 'T0');

  // D-05 — re-attest history and the operator, with a bounded preflight age.
  try {
    await recheckBeforeT0(ctx, state);
  } catch (e) {
    if (e instanceof C.C5ActivationRefusal) {
      conclude(ctx, state, { outcome: C.REFUSED_BEFORE_T0, stage: 'PRE_T0_RECHECK', code: e.code, message: e.message, freeze_in_place: false, restored: 'not_needed' });
    }
    throw e;
  }

  // §2.1 — ONE statement.
  const snap = await one(io, Q.T0_SNAPSHOT_SQL);
  C.assertSameRunner(state.runner, { current_user: snap.runner_current_user, session_user: snap.runner_session_user }, 'T0 snapshot');
  Object.assign(state, {
    t0: snap.t0, s0: snap.s0, a0: snap.a0, acl0: snap.acl0, acl0_text: snap.acl0_text, reject_acl0: snap.reject_acl0, l0: snap.l0,
    fingerprints0: snap.fingerprints,
  });
  complete(state, 'T0_SNAPSHOT_SEALED');
  store.record(state, 't0-snapshot', { snapshot: snap });

  // D-03 ledger gate + H8 + D-11 — judge the captured ACL before any DCL.
  let assessment;
  try {
    const cascade = state.reviewed_cascade === null || state.reviewed_cascade === undefined
      ? null : C.assertReviewedCascade(state.reviewed_cascade?.owner_reference ?? state.reviewed_cascade);
    const gate = C.assessT0Acl({
      capturedAcl: snap.acl0, expectation: state.ledger_expectation,
      carryForward: state.ledger_carry_forward === true, rebaseline: state.ledger_rebaseline === true,
    });
    state.restoration_target_acl0 = gate.target_acl0;
    state.freeze_planned = C.planFrozenAcl(snap.acl0);
    if (gate.inherited_from) {
      state.inherited = { from: gate.inherited_from, acl0: gate.target_acl0, frozen_acl: state.ledger_expectation?.frozen ?? null };
      assessment = { ledger_gate: { basis: gate.basis, inherited_from: gate.inherited_from } };
    } else {
      assessment = {
        ledger_gate: { basis: gate.basis, inherited_from: null },
        acl: C.assessAclSnapshot(snap.acl0, { reviewedCascade: cascade !== null }),
      };
    }
  } catch (e) {
    if (!(e instanceof C.C5ActivationRefusal)) throw e;
    store.record(state, 'acl0-assessment', { refused: { code: e.code, message: e.message }, reviewed_cascade: state.reviewed_cascade ?? null });
    return hold(ctx, state, { stage: 'ACL0_ASSESSMENT', code: e.code, reason: e.message, restored: 'not_needed' });
  }
  store.record(state, 'acl0-assessment', { assessment, reviewed_cascade: state.reviewed_cascade ?? null, freeze_planned: state.freeze_planned });

  // §2.2 — ONE short DCL transaction: reconfirm ACL == ACL0, revoke, verify
  // the result is EXACTLY the planned frozen set, commit; F0.
  const statements = statementsFor();
  const planned = state.freeze_planned;
  state.freeze_committed = 'unknown'; // write-ahead (D-03)
  store.saveState(state);
  let tx = null;
  try {
    await io.asAdmin(async (c) => {
      await c.query('BEGIN');
      let committing = false;
      try {
        await c.query(Q.DCL_LOCK_TIMEOUT_SQL);
        const cur = (await c.query(Q.FREEZE_ACL_SQL)).rows[0].acl;
        if (!C.aclSetsEqual(cur, snap.acl0)) {
          await c.query('ROLLBACK');
          tx = { committed: false, code: 'ACL_CHANGED_SINCE_T0', unexpected: C.aclSetDifference(cur, snap.acl0), missing: C.aclSetDifference(snap.acl0, cur) };
          return;
        }
        for (const s of statements) await c.query(s);
        const inTx = (await c.query(Q.FREEZE_ACL_SQL)).rows[0].acl;
        if (!C.aclSetsEqual(inTx, planned)) {
          await c.query('ROLLBACK');
          tx = { committed: false, code: 'ACL_FREEZE_SHAPE_UNEXPECTED', unexpected: C.aclSetDifference(inTx, planned), missing: C.aclSetDifference(planned, inTx) };
          return;
        }
        committing = true;
        await c.query('COMMIT');
        tx = { committed: true };
      } catch (e) {
        if (!committing) await c.query('ROLLBACK').catch(() => {});
        tx = { committed: committing ? 'unknown' : false, code: committing ? 'ACL_FREEZE_COMMIT_UNKNOWN' : 'ACL_FREEZE_FAILED', error: errOf(e) };
        return;
      }
      // F0 on the SAME connection, immediately after COMMIT (§2.2).
      try {
        tx.f0 = (await c.query(Q.CLOCK_SQL)).rows[0].now;
      } catch (e) {
        tx.f0_error = errOf(e);
      }
    });
  } catch (e) {
    tx = tx ?? { committed: 'unknown', code: 'ACL_FREEZE_CONNECTION_FAILED', error: errOf(e) };
  }
  if (tx.committed === true) {
    state.freeze_committed = true;
    store.saveState(state); // durable before any further read
    return finishFreeze(ctx, state, statements, tx);
  }

  // Not known to have committed: derive the freeze state from catalog truth.
  const { liveAcl, truth } = await freezeTruth(io, state);
  store.record(state, 'acl-freeze-outcome', { statements, committed: tx.committed, transaction: tx, acl_after: liveAcl, freeze_truth: truth, freeze_planned: planned });
  if (truth.state === C.FREEZE_STATES.IN_PLACE) {
    // The COMMIT took effect although its reply was lost: the freeze IS in
    // place. Record that durably and continue; F0 is then read now, which is
    // later than the true commit and only widens the §2.3 drain.
    state.freeze_committed = true;
    store.saveState(state);
    return finishFreeze(ctx, state, statements, { ...tx, committed: 'established_from_catalog' });
  }
  if (truth.state === C.FREEZE_STATES.NOT_IN_PLACE) {
    state.freeze_committed = false;
    return hold(ctx, state, {
      stage: 'ACL_FREEZE', code: tx.code, reason: 'the freeze transaction did not take effect (catalog truth: the ACL is ACL0)', restored: 'not_needed',
    });
  }
  return hold(ctx, state, {
    stage: 'ACL_FREEZE', code: tx.code, reason: 'the freeze outcome could not be established from the catalog', restored: false,
  });
}

// ---------------------------------------------------------------------------
// Phase: resolve (drain 1, S1, governed S0 ∪ S1 rejection, zero submitted,
// drain 2, READY_FOR_M217). Re-runnable while the drain WAITs.
// ---------------------------------------------------------------------------

async function drainStep(ctx, state, step) {
  const drain = await readDrain(ctx.io, state.f0);
  C.assertSameRunner(state.runner, drain.runner, step);
  ctx.store.record(state, `drain-${step === 'DRAIN_1_PASSED' ? 1 : 2}-poll`, { f0: state.f0, drain });
  if (drain.decision === 'PASS') {
    complete(state, step);
    ctx.store.saveState(state);
    return null;
  }
  if (drain.decision === 'HOLD') return stopBeforeM217(ctx, state, { code: drain.codes.join(','), drain });
  return { attempt_id: state.attempt_id, outcome: C.DRAIN_WAIT, step, codes: drain.codes, drain };
}

export async function runResolve(ctx) {
  const { io, store } = ctx;
  const state = loadOpenAttempt(ctx);
  if (!state.completed.includes('ACL_FROZEN')) C.assertStepInOrder(state.completed, 'DRAIN_1_PASSED');
  if (state.completed.includes('READY_FOR_M217')) C.assertStepInOrder(state.completed, 'READY_FOR_M217');
  await readRunner(io, state, 'resolve');

  if (!state.completed.includes('DRAIN_1_PASSED')) {
    const waited = await drainStep(ctx, state, 'DRAIN_1_PASSED');
    if (waited) return waited;
  }

  if (!state.completed.includes('S1_ENUMERATED')) {
    const s1 = await one(io, Q.SUBMITTED_SQL);
    C.assertSameRunner(state.runner, { current_user: s1.runner }, 'S1');
    state.s1 = s1.ids;
    state.union = C.submittedUnion(state.s0, state.s1);
    complete(state, 'S1_ENUMERATED');
    store.record(state, 's1', { s0: state.s0, s1: state.s1, union: state.union });
  }

  if (!state.completed.includes('SUBMITTED_RESOLVED')) {
    // H7 re-check against every owner organization in S0 ∪ S1.
    let op;
    try {
      op = await readOperator(io, state.operator_id, state.union);
    } catch (e) {
      if (!(e instanceof C.C5ActivationRefusal)) throw e;
      return stopBeforeM217(ctx, state, { code: e.code, message: e.message });
    }
    const before = await all(io, Q.RESOLUTION_EVIDENCE_SQL, [state.union]);
    const plan = C.planResolution(before);
    const stops = plan.filter((p) => p.action === 'stop');
    if (stops.length > 0) {
      store.record(state, 'resolution', { operator: op.verdict, plan, evidence_before: before, stopped: stops });
      return stopBeforeM217(ctx, state, { code: 'RESOLUTION_STATUS_UNEXPECTED', ids: stops });
    }
    const calls = [];
    for (const p of plan.filter((x) => x.action === 'reject')) {
      try {
        const r = await io.asUser(state.operator_id,
          (c) => c.query(Q.REJECT_RPC_SQL, [p.id, `C5 activation governed rejection (${state.attempt_id})`]).then((x) => x.rows[0].result),
          { role: 'authenticated', commit: true });
        calls.push({ id: p.id, ok: true, result: r });
      } catch (e) {
        // A concurrent governed rejection is resolved by the evidence re-read
        // below (H6); anything else stays unresolved and STOPs.
        calls.push({ id: p.id, ok: false, error: errOf(e) });
      }
    }
    const after = await all(io, Q.RESOLUTION_EVIDENCE_SQL, [state.union]);
    const verdict = C.assessResolution({ union: state.union, evidenceRows: after });
    store.record(state, 'resolution', { operator: op.verdict, plan, calls, evidence_after: after, verdict });
    if (!verdict.pass) return stopBeforeM217(ctx, state, { code: 'RESOLUTION_FAILED', failures: verdict.failures });
    complete(state, 'SUBMITTED_RESOLVED');
    store.saveState(state);
  }

  // Zero submitted (re-read on every pass through here), then drain 2.
  const zero = await one(io, Q.SUBMITTED_SQL);
  if (zero.ids.length !== 0) {
    store.record(state, 'zero-submitted', { submitted: zero.ids });
    return stopBeforeM217(ctx, state, { code: 'SUBMITTED_REMAIN', ids: zero.ids });
  }
  if (!state.completed.includes('ZERO_SUBMITTED_PROVEN')) {
    complete(state, 'ZERO_SUBMITTED_PROVEN');
    store.record(state, 'zero-submitted', { submitted: [] });
  }
  if (!state.completed.includes('DRAIN_2_PASSED')) {
    const waited = await drainStep(ctx, state, 'DRAIN_2_PASSED');
    if (waited) return waited;
  }

  // §21.8 — the read-only activation preconditions this tool can see: zero
  // submitted, M217 PROVEN absent (catalog + T0 fingerprints + no in-flight
  // M217), the ACL still the frozen set, and Proof A / Proof B / the census as
  // they stand now — so any accounting violation (including the D-10
  // straddler pattern) is a STOP BEFORE M217, never a post-apply HOLD.
  const facts = await readM217Facts(io);
  const pre = classifyFacts(state, facts, { requireExecutor: false, executor: null });
  const aclNow = (await one(io, Q.FREEZE_ACL_SQL)).acl;
  const finalZero = await one(io, Q.SUBMITTED_SQL);
  const proofs = await readProofs(io, state);
  const census = C.evaluateLifecycleAuditCensus({ l0: state.l0, current: await readCensus(io), union: state.union, s0: state.s0 });
  const aclStillFrozen = C.aclSetsEqual(aclNow, state.frozen_acl);
  const verdict = C.assessReadyForM217({
    submittedIds: finalZero.ids, m217: pre, aclStillFrozen, proofA: proofs.proofA, proofB: proofs.proofB, census,
  });
  const ready = {
    zero_submitted: finalZero.ids.length === 0,
    m217_absent: pre.outcome === C.M217_OUTCOMES.FAILED_CLEAN,
    acl_still_frozen: aclStillFrozen,
    accounting_clean: proofs.proofA.pass && proofs.proofB.pass && census.pass,
    ready_at: (await one(io, Q.CLOCK_SQL)).now,
    enforced_inside_m217: 'zero DRAFT invalid source evidence and zero DRAFT unsafe lineage links are M217 preconditions (its classifier/helper do not exist before it); a failure there rolls M217 back and is classified by --phase=post-apply',
    drain_gap: 'the executor applies M217 after this read; M217 NOWAIT locks, its zero-submitted precondition, and the post-apply drain + Proof A/B cover the gap',
  };
  store.record(state, 'ready-for-m217', {
    ready, verdict, m217_outcome: pre, m217_state: facts.m217_state, in_flight: facts.in_flight,
    proof_a: proofs.proofA, proof_b: proofs.proofB, census,
  });
  if (!verdict.pass) {
    return stopBeforeM217(ctx, state, { code: 'PRE_M217_PRECONDITION_FAILED', failures: verdict.failures.map((f) => f.code), ready });
  }
  state.ready_at = ready.ready_at;
  complete(state, 'READY_FOR_M217');
  store.saveState(state);
  return {
    attempt_id: state.attempt_id, outcome: C.READY_FOR_M217,
    executor: state.executor, t0: state.t0, f0: state.f0, union: state.union,
  };
}

// ---------------------------------------------------------------------------
// Phase: stop — the operator's STOP (failure branch).
// ---------------------------------------------------------------------------

export async function runStop(ctx, reason = 'operator STOP before M217') {
  const state = loadOpenAttempt(ctx);
  C.assertExecutorRun(ctx.options?.executorRun ?? null);
  if (!state.completed.includes('T0_SNAPSHOT_SEALED')) {
    // Abandoned before T0: nothing frozen, no T0/A0 to account for.
    return conclude(ctx, state, { outcome: C.REFUSED_BEFORE_T0, code: 'OPERATOR_STOP_BEFORE_T0', message: reason, freeze_in_place: false, restored: 'not_needed' });
  }
  await readRunner(ctx.io, state, 'stop');
  return stopBeforeM217(ctx, state, { code: 'OPERATOR_STOP', message: reason });
}

// ---------------------------------------------------------------------------
// Phase: post-apply (H9 outcome, H10 verification, exact ACL0 restore).
// Re-entrant (D-08): a transient read error leaves the attempt open, and a
// re-run re-classifies M217 and continues.
// ---------------------------------------------------------------------------

/**
 * D-08 — when a previous post-apply run stopped after M217_OUTCOME_CLASSIFIED
 * (and before the restore), step back to READY_FOR_M217 so classification and
 * every verification are redone from fresh reads. The earlier evidence stays
 * sealed; the resume itself is recorded.
 */
function resumeAfterClassification(ctx, state) {
  const i = state.completed.indexOf('READY_FOR_M217');
  if (i < 0 || state.completed.length === i + 1) return null;
  const beyond = state.completed.slice(i + 1);
  const prior = state.m217_outcome?.outcome ?? null;
  state.completed = state.completed.slice(0, i + 1);
  ctx.store.record(state, 'post-apply-resume', { resumed_from: beyond, prior_outcome: prior });
  return { prior_outcome: prior, resumed_from: beyond };
}

async function verifyRestore(ctx, state) {
  const { io, store } = ctx;
  const target = restorationTargetOf(state);
  const aclAfter = (await one(io, Q.FREEZE_ACL_SQL)).acl;
  const rejectAfter = (await one(io, Q.REJECT_ACL_SQL)).acl;
  let operator = null;
  let operatorError = null;
  try { operator = (await readOperator(io, state.operator_id, [])).verdict; } catch (e) { operatorError = errOf(e); }
  const aclSetEqual = C.aclSetsEqual(aclAfter, target);
  const restoreVerified = aclSetEqual && C.aclSetsEqual(rejectAfter, state.reject_acl0) && operator !== null;
  store.record(state, 'restore-verification', {
    acl_set_equal: aclSetEqual, acl_after: aclAfter, reject_acl: rejectAfter, operator, operator_error: operatorError,
    draft_audit_summary: state.draft_audit_summary ?? null,
  });
  if (!restoreVerified) {
    return hold(ctx, state, { stage: 'RESTORE_VERIFICATION', restored: aclSetEqual });
  }
  complete(state, 'RESTORE_VERIFIED');
  return conclude(ctx, state, {
    outcome: C.C5_ACTIVATION_PASS, restored: true, freeze_in_place: false,
    draft_workflow_holds: state.draft_audit_summary?.draft_workflow_holds ?? [],
  });
}

export async function runPostApply(ctx) {
  const { io, store, options } = ctx;
  const state = loadOpenAttempt(ctx);
  const executor = C.assertExecutorRun(options?.executorRun ?? null);
  // A-05: post-apply classifies what an executor RUN did; a run that was never
  // dispatched is a --phase=stop matter, never a post-apply restore basis.
  if (executor?.conclusion === 'not_dispatched') {
    throw new C.C5ActivationRefusal('POST_APPLY_REQUIRES_EXECUTOR_RUN',
      'post-apply needs the executor run id and its terminal conclusion (success|failure|cancelled); not_dispatched belongs to --phase=stop.');
  }
  await readRunner(io, state, 'post-apply');

  // D-08 — the restore already committed; only its verification remains.
  if (state.completed.includes('ACL_RESTORED')) return verifyRestore(ctx, state);
  const resumed = resumeAfterClassification(ctx, state);
  C.assertStepInOrder(state.completed, 'M217_OUTCOME_CLASSIFIED');
  const postApplyAt = (await one(io, Q.CLOCK_SQL)).now;

  // H9 — what happened to M217? FAILED_CLEAN needs the full D-02 proof.
  const facts = await readM217Facts(io);
  let outcome = classifyFacts(state, facts, { requireExecutor: true, executor });
  if (resumed?.prior_outcome === C.M217_OUTCOMES.APPLIED && outcome.outcome !== C.M217_OUTCOMES.APPLIED) {
    outcome = {
      outcome: C.M217_OUTCOMES.UNKNOWN, reason: 'an earlier post-apply run classified M217 APPLIED; a committed M217 cannot disappear',
      unproven: ['M217 classification changed between post-apply runs'], observed: outcome,
    };
  }
  state.m217_outcome = outcome;
  complete(state, 'M217_OUTCOME_CLASSIFIED');
  store.record(state, 'm217-outcome', { outcome, executor, resumed, post_apply_at: postApplyAt, ...facts });

  if (outcome.outcome !== C.M217_OUTCOMES.APPLIED) {
    let proofs = { proofA: null, proofB: null };
    let census = null;
    let proofsError = null;
    try {
      proofs = await readProofs(io, state);
      census = C.evaluateLifecycleAuditCensus({ l0: state.l0, current: await readCensus(io), union: state.union, s0: state.s0 });
    } catch (e) {
      proofsError = errOf(e);
    }
    store.record(state, 'failure-proofs', { proof_a: proofs.proofA, proof_b: proofs.proofB, census, proofs_error: proofsError });
    if (outcome.outcome === C.M217_OUTCOMES.FAILED_CLEAN) {
      // Non-commit PROVEN (history + catalog + T0 fingerprints + no in-flight
      // M217 + the executor's terminal non-success state): restore the exact
      // ACL0 only if catalog truth says the freeze is in place.
      const { truth } = await freezeTruth(io, state);
      if (truth.state !== C.FREEZE_STATES.IN_PLACE) {
        return hold(ctx, state, { stage: 'M217_FAILED_CLEAN', m217: outcome.outcome, restored: false, freeze_reason: truth.reason ?? truth.state });
      }
      const restore = await restoreAcl(ctx, state, { m217Guard: { requireExecutor: true, executor } });
      store.record(state, 'failure-acl-restore', { restore });
      if (restore.code === 'M217_PRESENT_AT_RESTORE') {
        // A-01: the attempt stays OPEN at M217_OUTCOME_CLASSIFIED with the freeze
        // kept; a re-run of post-apply resumes and re-classifies from fresh reads.
        throw new C.C5ActivationRefusal('M217_PRESENT_AT_RESTORE',
          `M217 was found ${restore.m217} inside the restore transaction after it had classified FAILED_CLEAN; the restore was ` +
            'rolled back, the freeze is kept and nothing was restored. Re-run --phase=post-apply once the executor has concluded.',
          { hold: true, m217: restore.m217 });
      }
      return hold(ctx, state, { stage: 'M217_FAILED_CLEAN', m217: outcome.outcome, restored: restore.restored });
    }
    // FAILED_PARTIAL / UNKNOWN: keep the freeze, restore nothing.
    return hold(ctx, state, { stage: `M217_${outcome.outcome}`, m217: outcome.outcome, restored: false, unproven: outcome.unproven ?? null });
  }

  // H10 — every post-apply invariant, all collected. A read error here throws
  // and leaves the attempt open at M217_OUTCOME_CLASSIFIED (re-run to resume).
  const localMigrations = readLocalMigrations(options.migrationsDir ?? MIGRATIONS_DIR);
  const catalog = await one(io, Q.POST_APPLY_CATALOG_SQL);
  const submitted = await one(io, Q.SUBMITTED_SQL);
  const drain = await readDrain(io, state.f0);
  const resolution = C.assessResolution({ union: state.union, evidenceRows: await all(io, Q.RESOLUTION_EVIDENCE_SQL, [state.union]) });
  const writers = await all(io, Q.LIFECYCLE_WRITERS_SQL);
  const aclNow = (await one(io, Q.FREEZE_ACL_SQL)).acl;
  const rejectAclNow = (await one(io, Q.REJECT_ACL_SQL)).acl;
  const proofs = await readProofs(io, state);
  const census = C.evaluateLifecycleAuditCensus({ l0: state.l0, current: await readCensus(io), union: state.union, s0: state.s0 });
  const draftAudit = {
    chronology: await all(io, Q.CHRONOLOGY_AMBIGUITY_SQL, [state.t0, postApplyAt]),
    pins: await all(io, Q.NON_HEAD_PIN_AUDIT_SQL),
    lineage: await all(io, Q.DRAFT_LINEAGE_AUDIT_SQL),
    invalidEvidence: await all(io, Q.DRAFT_INVALID_EVIDENCE_SQL),
  };
  const verdict = C.evaluatePostApply({
    remoteRows: facts.remote_rows, localMigrations, attestation: state.attestation,
    localM217Sha256: localMigrations.find((m) => m.filename === C.M217_FILENAME)?.sha256 ?? null,
    overloads: catalog.overloads,
    classifier: catalog.classifier, lineageHelper: catalog.lineage_helper, fenceFunction: catalog.fence_function,
    fenceTrigger: catalog.fence_trigger, valueContract: catalog.value_contract, blockerVocabulary: catalog.blocker_vocabulary,
    bodies: facts.m217_state.bodies,
    submittedIds: submitted.ids, drain, resolution,
    proofA: proofs.proofA, proofB: proofs.proofB, census,
    lifecycleWriters: writers,
    frozenAcl: state.frozen_acl, aclNow, rejectAcl0: state.reject_acl0, rejectAclNow,
  });
  const draftSummary = C.summarizeDraftAudit(draftAudit);
  state.draft_audit_summary = draftSummary;
  store.record(state, 'post-apply-verification', {
    post_apply_at: postApplyAt, verdict, catalog, submitted: submitted.ids, drain, resolution,
    proof_a: proofs.proofA, proof_b: proofs.proofB, census, lifecycle_writers: writers,
    acl_now: aclNow, reject_acl_now: rejectAclNow, draft_audit: draftAudit, draft_audit_summary: draftSummary,
  });
  if (!verdict.pass) {
    return hold(ctx, state, { stage: 'POST_APPLY_VERIFICATION', failures: verdict.failures.map((x) => x.code), restored: false });
  }
  complete(state, 'POST_APPLY_VERIFIED');
  store.saveState(state);

  // H10 — re-read zero submitted IMMEDIATELY before the restore.
  const again = await one(io, Q.SUBMITTED_SQL);
  store.record(state, 'pre-restore-zero-submitted', { submitted: again.ids });
  if (again.ids.length !== 0) {
    return hold(ctx, state, { stage: 'PRE_RESTORE_ZERO_SUBMITTED', code: 'SUBMITTED_PRESENT', submitted: again.ids, restored: false });
  }
  complete(state, 'PRE_RESTORE_ZERO_SUBMITTED');
  store.saveState(state);

  // §2.6 / §21.13 — restore EXACTLY the captured ACL0, verified before COMMIT.
  const restore = await restoreAcl(ctx, state);
  store.record(state, 'acl-restore', { restore });
  if (!restore.restored) {
    return hold(ctx, state, { stage: 'ACL_RESTORE', code: restore.code ?? 'ACL_RESTORE_MISMATCH', restored: false });
  }
  complete(state, 'ACL_RESTORED');
  store.saveState(state);

  // §21.14 — restored set + the reject/operator capability.
  return verifyRestore(ctx, state);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const [i, a] of argv.entries()) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    // Never echo the argument: a misplaced connection string must not be printed (DIR-01).
    if (!m) throw new C.C5ActivationRefusal('ARGUMENT_UNRECOGNIZED', `Unrecognized argument #${i + 1}; expected --name or --name=value (not shown).`);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const PHASES = { preflight: runPreflight, freeze: runFreeze, resolve: runResolve, 'post-apply': runPostApply, stop: runStop };

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const phase = PHASES[args.phase];
  if (!phase) throw new C.C5ActivationRefusal('PHASE_UNKNOWN', `--phase must be one of ${Object.keys(PHASES).join(', ')}.`);
  const target = C.assertActivationTarget({
    target: args.target ?? 'rehearsal',
    rehearsalUrl: env.PHOENIX_C5_ACTIVATION_DATABASE_URL,
    productionUrl: env.PHOENIX_PRODUCTION_DATABASE_URL,
    authorization: env.PHOENIX_C5_ACTIVATION_AUTHORIZATION,
  });
  // Validated before anything connects.
  const reviewedCascade = args['reviewed-cascade'] ?? null;
  C.assertReviewedCascade(reviewedCascade);
  const executorRun = args['executor-conclusion'] === undefined && args['executor-run-id'] === undefined ? null
    : C.assertExecutorRun({
      run_id: typeof args['executor-run-id'] === 'string' ? args['executor-run-id'] : null,
      conclusion: typeof args['executor-conclusion'] === 'string' ? args['executor-conclusion'] : '',
    });
  const store = new EvidenceStore(args['evidence-dir']);
  const dispositions = typeof args.dispositions === 'string' ? JSON.parse(readFileSync(args.dispositions, 'utf8')) : [];
  const ledgerExpected = {
    prior_attempts: args['expected-prior-attempts'] ?? env.PHOENIX_C5_EXPECTED_PRIOR_ATTEMPTS ?? null,
    ledger_sha256: args['expected-ledger-sha256'] ?? env.PHOENIX_C5_EXPECTED_LEDGER_SHA256 ?? null,
  };
  const io = target.kind === 'production'
    ? await buildRemoteIo({ connectionString: target.connectionString })
    : await buildLoopbackIo({ connectionString: target.connectionString });
  try {
    const result = await phase({
      io, store, attemptId: typeof args.attempt === 'string' ? args.attempt : undefined,
      options: {
        target: target.kind,
        operatorId: env.PHOENIX_C5_REJECT_OPERATOR_ID,
        reviewedCascade,
        dispositions,
        executorRun,
        ledgerExpected,
        executor: {
          migrationFilename: env.PHOENIX_MIGRATION_FILENAME,
          migrationSha256: env.PHOENIX_MIGRATION_SHA256,
          expectedCurrentCeiling: env.PHOENIX_EXPECTED_CURRENT_CEILING,
          expectedNextCeiling: env.PHOENIX_EXPECTED_NEXT_CEILING,
          remoteHistoryVersion: env.PHOENIX_REMOTE_HISTORY_VERSION,
        },
      },
    });
    console.log(`C5 activation ${args.phase}: ${result.outcome} (attempt ${result.attempt_id}).`);
    if (result.ledger) {
      console.log(`Ledger: ${result.ledger.prior_attempts} prior attempt(s), sha256 ${result.ledger.ledger_sha256}${result.ledger.owner_anchored ? ' (Owner-anchored)' : ''}.`);
    }
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, `c5_activation_outcome=${result.outcome}\n`);
      appendFileSync(env.GITHUB_OUTPUT, `c5_activation_attempt=${result.attempt_id}\n`);
    }
    if (result.outcome === C.C5_ACTIVATION_HOLD) {
      console.error(`::error::[${C.C5_ACTIVATION_HOLD}] ${JSON.stringify(result.conclusion)}`);
      process.exitCode = 1;
    } else if (result.outcome === C.DRAIN_WAIT) {
      console.log(`Drain not yet zero (${result.codes.join(', ')}); submit/approve stay frozen. Re-run --phase=resolve.`);
      process.exitCode = 2;
    }
    return result;
  } finally {
    await io.end();
  }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    // Nothing in this file interpolates a connection string into a message,
    // and both I/O adapters redact driver errors.
    console.error(`::error::${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
