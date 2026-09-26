// ===========================================================================
// C5 ACTIVATION — the pure decision contract (C5 v1.9 §2 / §19 / §21, with
// Owner hardening H1-H13).
//
// WHY THIS EXISTS
// ---------------
// M217 converges the Central Needs safety defects, but it can only be applied
// safely inside an ordered activation window: a complete EXECUTE freeze of
// submit/approve, a pre-freeze transaction drain, governed rejection of every
// submitted revision, and two independent lifecycle/audit proofs before the
// captured ACL is restored. None of that belongs in migration history (§22):
// it is a separately authorized runbook. This module holds EVERY decision
// that runbook makes, as pure functions, so each refusal and each HOLD branch
// is unit-testable without a database, a runner or Production.
//
// It never connects, reads a file, or writes anything. The SQL it judges lives
// in c5-activation-sql.mjs; the I/O wrapper is c5-activation-runbook.mjs,
// which gathers inputs and calls these functions without deciding anything of
// its own.
//
// THE ORDER (ACTIVATION_STEPS)
// ----------------------------
//   fresh Production-history attestation (H12) -> runner capability (H1)
//   -> reject-operator preflight (H7) -> prior-attempt dispositions and the
//   ledger anchor (H3) -> [re-attest history + operator, bounded preflight
//   age] -> ONE-statement T0/S0/A0/ACL0/L0/body-fingerprint snapshot (§2.1,
//   H8) -> ledger ACL gate -> ONE DCL freeze transaction, verified before
//   COMMIT, + F0 + sealed frozen ACL (§2.2) -> drain 1 (§2.3, H2) -> S1
//   -> governed S0 ∪ S1 resolution (§2.4, H6) -> zero submitted -> drain 2
//   -> read-only preconditions incl. Proof A/B and the census -> READY_FOR_M217
//   [the executor applies M217 DATABASE FIRST; this tool only gates/records]
//   -> M217 outcome (H9) -> post-apply verification (H10, Proof A/B, H11)
//   -> zero submitted re-read -> exact ACL0 restore, verified before COMMIT
//   (§2.6) -> restore verify.
//
// Failure branches: a STOP before M217 is C5_ACTIVATION_HOLD (H3). ACL0 is
// restored ONLY when M217 non-commit is PROVEN (H9: history + absence of
// every M217 object + T0-identical bodies + no in-flight M217 backend, and —
// once READY_FOR_M217 exists — the executor's terminal non-success state).
// A STOP that finds M217 (partly) present after READY is refused and routed
// to post-apply; UNKNOWN keeps the freeze and restores nothing; any
// post-apply failure keeps the freeze. Every HOLD after T0 records the freeze
// state as the CATALOG shows it (deriveFreezeState), never as assumed.
//
// SECRETS: nothing here logs, returns or embeds a connection string. The one
// function that inspects one (assertActivationTarget) reads only its
// protocol, host, port, database, user and query keys, and never puts any
// value of them into a thrown message (query key NAMES only).
// ===========================================================================
import { parse as parsePgConnectionString } from 'pg-connection-string';
import { sanitizeRemoteConnectionString } from '../pg-rig/remote-io.mjs';
import {
  PINNED_PROJECT_REF,
  ProductionMigrationRefusal,
  assertProjectRefPinned,
  parseMigrationVersion,
} from './production-migration-contract.mjs';
import {
  MigrationHistoryRefusal,
  assertPostApplyAcceptance,
  assertRemoteHistoryVersionUsable,
  canonicalStem,
  reconcileMigrationHistory,
} from './production-migration-history.mjs';

// ---------------------------------------------------------------------------
// Fixed identities.
// ---------------------------------------------------------------------------

/** The one migration this activation governs (§19). */
export const M217_FILENAME = '217_phoenix_central_needs_c5_safety_convergence.sql';
/** The name the executor records it under (the full canonical stem, as for M216). */
export const M217_HISTORY_NAME = canonicalStem(M217_FILENAME);
export const EXPECTED_CURRENT_CEILING = 216;
export const EXPECTED_NEXT_CEILING = 217;

/**
 * SEALED PRODUCTION M216 IDENTITY — from the sealed dispatch evidence of
 * executor run 36026915933 (D:/phoenix-evidence/C4-I11-M216-Production-Dispatch,
 * 06-summary.txt), NOT from any repository fixture. The repository's historical
 * test fixtures carry the pre-dispatch value 20260923215400; §19 forbids
 * treating that as Production truth.
 *
 * This is the reference a FRESH read-only history read is compared against
 * (H12): the fresh row reconciled to canonical 216 must carry exactly this
 * version and name, and the local 216 file must hash to exactly this SHA-256.
 * A mismatch is a HOLD before T0 — never a reason to update this record.
 */
export const SEALED_M216 = Object.freeze({
  canonical: 216,
  filename: '216_phoenix_central_needs_region_persistence.sql',
  sha256: '6084eabbe2113e20cd8d25c5e5dd8c4ba9023117044f02ac012b014ab2d88052',
  remoteVersion: '20260924124100',
  remoteName: '216_phoenix_central_needs_region_persistence',
});

export const SUBMIT_SIGNATURE = 'public.phoenix_central_needs_submit_revision(uuid)';
export const APPROVE_SIGNATURE = 'public.phoenix_central_needs_approve_revision(uuid)';
export const REJECT_SIGNATURE = 'public.phoenix_central_needs_reject_revision(uuid, text)';
/** §2.2: exactly these two are frozen; reject is never touched. */
export const FREEZE_SIGNATURES = Object.freeze([SUBMIT_SIGNATURE, APPROVE_SIGNATURE]);
/** §2.2 step 3: always revoked explicitly, whatever the captured ACL shows. */
export const EXPLICIT_FREEZE_GRANTEES = Object.freeze(['authenticated', 'service_role', 'anon', 'PUBLIC']);
/** §2.2 verification: has_function_privilege must be false for each. */
export const CLIENT_ROLES = Object.freeze(['authenticated', 'service_role', 'anon']);

/** H7: the guard's role eligibility and the reject RPC's required capability. */
export const ELIGIBLE_OPERATOR_ROLES = Object.freeze(['super_admin', 'central_warehouse_manager']);
export const REJECT_CAPABILITY = 'central_needs.approve';

export const ACTION_SUBMIT = 'central_needs.plan_revision.submit';
export const ACTION_APPROVE = 'central_needs.plan_revision.approve';
export const ACTION_GATE = 'central_needs.plan_revision.approval_gate';
export const ACTION_SUPERSEDE = 'central_needs.plan_revision.supersede';
export const ACTION_REJECT = 'central_needs.plan_revision.reject';
/** H11: the lifecycle audit actions whose census must not move except by the governed procedure. */
export const LIFECYCLE_AUDIT_ACTIONS = Object.freeze([
  ACTION_SUBMIT, ACTION_APPROVE, ACTION_GATE, ACTION_SUPERSEDE, ACTION_REJECT,
]);
export const GATE_CONTRACT = 'c5-v1';
export const REVISION_ENTITY_TYPE = 'central_needs_plan_revision';

/** M217 objects by their frozen names (interface §2). Absence of ALL is part of the H9 non-commit proof. */
export const M217_OBJECTS = Object.freeze({
  classifier: 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)',
  lineageHelper: 'public._phoenix_central_needs_quantity_lineage_violation_v1(uuid)',
  fenceFunction: 'public._phoenix_central_needs_approval_gate_fence_v1()',
  fenceTrigger: 'central_needs_plan_revisions_c5_approval_gate',
  valueContract: 'central_needs_source_records_c5_value_contract',
});

/**
 * Behaviour-only replacements M217 makes, each with one C5-only token its
 * body must contain once M217 committed and must NOT contain on a pre-C5
 * chain. Every token is a name or code frozen by the interface document.
 */
export const M217_BODY_MARKERS = Object.freeze([
  Object.freeze({ fn: APPROVE_SIGNATURE, marker: 'approval_gate_txid' }),
  Object.freeze({ fn: 'public._phoenix_central_needs_review_blockers_v1(uuid)', marker: 'source_cell_value_contract_invalid' }),
  Object.freeze({ fn: 'public.phoenix_central_needs_list_beneficiary_columns(uuid)', marker: '_phoenix_central_needs_review_numeric_class_v1' }),
  Object.freeze({
    fn: 'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    marker: 'designated_quantity_not_canonical',
  }),
  Object.freeze({ fn: 'public._phoenix_central_needs_assert_need_line_integrity_v1()', marker: '_phoenix_central_needs_quantity_lineage_violation_v1' }),
  Object.freeze({ fn: 'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)', marker: 'beneficiary_organization_archived' }),
  Object.freeze({ fn: 'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)', marker: 'clock_timestamp' }),
]);

/**
 * D-02 / H9 "pre-C5 behaviour": every function M217 replaces, plus submit and
 * reject, is fingerprinted in the ONE-statement T0 snapshot (oid, source,
 * language, result type, security, volatility, strictness, parallel safety,
 * settings, owner, argument types — nothing session-dependent). A non-commit
 * proof requires every current fingerprint to equal its T0 value exactly, so a
 * marker-less privileged CREATE OR REPLACE, or a DROP + CREATE with the same
 * body (a new oid), is never mistaken for the pre-C5 body.
 */
export const FINGERPRINT_SIGNATURES = Object.freeze([...new Set([
  ...M217_BODY_MARKERS.map((m) => m.fn), SUBMIT_SIGNATURE, REJECT_SIGNATURE,
])]);

/**
 * D-02: query-text tokens that only M217's own statements carry (its prelude
 * GUC and refusal codes, and the names of the objects it creates). A backend
 * with an open transaction whose current query carries one of them is treated
 * as an in-flight M217; so is any other backend holding or awaiting a
 * ShareLock-or-stronger lock on either §1 relation (M217 holds ACCESS
 * EXCLUSIVE / EXCLUSIVE on them from its lock pair until COMMIT).
 */
export const M217_IN_FLIGHT_TOKENS = Object.freeze([
  'phoenix_m217.', '217_already_applied', '217_precondition_failed', '217_requires_read_committed',
  '_phoenix_central_needs_review_numeric_class_v1', '_phoenix_central_needs_quantity_lineage_violation_v1',
  '_phoenix_central_needs_approval_gate_fence_v1', 'central_needs_plan_revisions_c5_approval_gate',
  'central_needs_source_records_c5_value_contract',
]);
export const M217_LOCKED_RELATIONS = Object.freeze(['public.central_needs_source_records', 'public.central_needs_plan_revisions']);

/**
 * D-02: the executor's terminal state, supplied by the release operator from
 * the executor run (never inferred). Only a terminal NON-success state can be
 * part of a non-commit proof; 'not_dispatched' records that no executor run
 * was ever started for this attempt.
 */
export const EXECUTOR_CONCLUSIONS = Object.freeze(['success', 'failure', 'cancelled', 'not_dispatched']);
export const EXECUTOR_NON_COMMIT_CONCLUSIONS = Object.freeze(['failure', 'cancelled', 'not_dispatched']);

/** D-05: the preflight evidence (history, operator, prior-attempt deltas) older than this cannot open a T0. */
export const PREFLIGHT_MAX_AGE_SECONDS = 900;

/** §7: the two blocker codes M217 adds to the readiness vocabulary. */
export const C5_BLOCKER_CODES = Object.freeze(['source_cell_value_contract_invalid', 'need_line_quantity_lineage_unsafe']);

/** H10 exact overloads: each of these names exists exactly once in `public`. */
export const EXACT_OVERLOAD_NAMES = Object.freeze([
  'phoenix_central_needs_submit_revision',
  'phoenix_central_needs_approve_revision',
  'phoenix_central_needs_reject_revision',
  '_phoenix_central_needs_review_numeric_class_v1',
  '_phoenix_central_needs_quantity_lineage_violation_v1',
  '_phoenix_central_needs_approval_gate_fence_v1',
  '_phoenix_central_needs_review_blockers_v1',
  'phoenix_central_needs_list_beneficiary_columns',
  'phoenix_central_needs_set_need_line',
  '_phoenix_central_needs_assert_need_line_integrity_v1',
  '_phoenix_central_needs_assert_beneficiary_v1',
  'phoenix_central_needs_record_field_override',
]);

/**
 * H10 "no unexpected lifecycle writer": only submit/approve/reject UPDATE
 * plan_revisions.status; only the two openers INSERT (draft) revisions.
 */
export const EXPECTED_STATUS_WRITERS = Object.freeze([APPROVE_SIGNATURE, REJECT_SIGNATURE, SUBMIT_SIGNATURE]);
export const EXPECTED_REVISION_INSERTERS = Object.freeze([
  'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)',
  'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
]);

/** Outcomes. */
export const C5_ACTIVATION_HOLD = 'C5_ACTIVATION_HOLD';
export const C5_ACTIVATION_PASS = 'C5_ACTIVATION_PASS';
export const READY_FOR_M217 = 'READY_FOR_M217';
export const DRAIN_WAIT = 'DRAIN_WAIT';
/** An attempt that stopped before any T0 existed: nothing frozen, nothing to account for. */
export const REFUSED_BEFORE_T0 = 'REFUSED_BEFORE_T0';
export const M217_OUTCOMES = Object.freeze({
  APPLIED: 'APPLIED', FAILED_CLEAN: 'FAILED_CLEAN', FAILED_PARTIAL: 'FAILED_PARTIAL', UNKNOWN: 'UNKNOWN',
});

/**
 * Production is NOT authorized. The CLI refuses any non-loopback target unless
 * `--target=production`, the pinned project ref AND this exact phrase in
 * PHOENIX_C5_ACTIVATION_AUTHORIZATION are all present — and even then it only
 * proceeds under a separate, explicit Owner Production authorization.
 */
export const PRODUCTION_AUTHORIZATION_PHRASE =
  'EXECUTE_C5_PRODUCTION_ACTIVATION_UNDER_SEPARATE_OWNER_PRODUCTION_AUTHORIZATION';
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);
/**
 * D-06 / DIR-01: libpq / node-postgres connection-string query keys that can
 * redirect a connection to another SERVER. pg-connection-string copies every
 * query parameter into the driver config and lets it replace the URL's own
 * host or port. Refused, case-insensitively, for BOTH targets.
 */
export const CONNECTION_TARGET_REDIRECT_KEYS = Object.freeze(['host', 'hostaddr', 'port', 'service', 'servicefile']);
/**
 * DIR-01: keys that redirect a Supabase POOLER connection to another PROJECT
 * on the same server: `user` replaces the URL username, and the pooler picks
 * the tenant from `<role>.<project ref>`; `options` sends startup parameters
 * (tenant references, `-c` settings). Refused, case-insensitively, for
 * Production only — on a loopback rehearsal they cannot leave the machine.
 */
export const PRODUCTION_TENANT_ROUTING_KEYS = Object.freeze(['user', 'options']);
/** DIR-01: `replication` turns the Production session into a walsender session. Refused for Production. */
export const PRODUCTION_SESSION_MODE_KEYS = Object.freeze(['replication']);
/**
 * DIR-01: the PG* variables pg itself falls back to for the refused startup
 * parameters when the connection string carries none (pg's
 * ConnectionParameters reads `options` / `replication` from PGOPTIONS /
 * PGREPLICATION). Host, port, user and database cannot fall back: the guard
 * requires them explicit and non-empty.
 */
export const PRODUCTION_DRIVER_ENV_KEYS = Object.freeze(['PGOPTIONS', 'PGREPLICATION']);
/** DIR-01: the effective Production target — the pinned project's Supabase endpoints only. */
export const PRODUCTION_DIRECT_HOST = `db.${PINNED_PROJECT_REF}.supabase.co`;
const SUPABASE_POOLER_HOST_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pooler\.supabase\.com$/;
const PG_ROLE_PATTERN = /^[a-z_][a-z0-9_]*$/;
/** The pooler tenant user: `<role>.<pinned ref>`, exactly one dot. */
const PINNED_TENANT_USER_PATTERN = new RegExp(`^[a-z_][a-z0-9_]*\\.${PINNED_PROJECT_REF}$`);
export const PRODUCTION_PORTS = Object.freeze(['5432', '6543']);
export const PRODUCTION_DATABASE = 'postgres';

/**
 * THE ORDER. Each step may only follow the one before it; the tool refuses
 * to skip or repeat a step (STEP_OUT_OF_ORDER).
 */
export const ACTIVATION_STEPS = Object.freeze([
  'HISTORY_ATTESTED',
  'RUNNER_ATTESTED',
  'OPERATOR_ATTESTED',
  'PRIOR_ATTEMPTS_DISPOSITIONED',
  'T0_SNAPSHOT_SEALED',
  'ACL_FROZEN',
  'DRAIN_1_PASSED',
  'S1_ENUMERATED',
  'SUBMITTED_RESOLVED',
  'ZERO_SUBMITTED_PROVEN',
  'DRAIN_2_PASSED',
  'READY_FOR_M217',
  'M217_OUTCOME_CLASSIFIED',
  'POST_APPLY_VERIFIED',
  'PRE_RESTORE_ZERO_SUBMITTED',
  'ACL_RESTORED',
  'RESTORE_VERIFIED',
]);

// ---------------------------------------------------------------------------
// Refusals.
// ---------------------------------------------------------------------------

/**
 * A fail-closed refusal. `code` is stable and asserted by the unit tests.
 * `hold` is true when the refusal happens at or after T0, i.e. it is a
 * C5_ACTIVATION_HOLD of an attempt already in flight rather than a refusal to
 * start one.
 */
export class C5ActivationRefusal extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'C5ActivationRefusal';
    this.code = code;
    Object.assign(this, extra);
  }
}

const refuse = (code, message, extra) => {
  throw new C5ActivationRefusal(code, message, extra);
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sortedUnique = (xs) => [...new Set(xs.map(String))].sort();
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Target selection (loopback by default).
// ---------------------------------------------------------------------------

/**
 * Decide which database the runbook may address. Pure: the caller passes the
 * target flag and the relevant environment values.
 *
 * Default is REHEARSAL: the URL must be a loopback host. Any other host is a
 * refusal unless target is 'production' AND the connection string addresses
 * the pinned project ref AND the exact authorization phrase is present.
 *
 * `driverEnv` is the environment the pg driver will read (process.env by
 * default; injectable for tests) — DIR-01 refuses Production while it carries
 * a PRODUCTION_DRIVER_ENV_KEYS fallback.
 *
 * @returns {{kind:'rehearsal'|'production', connectionString:string}}
 */
export function assertActivationTarget({ target = 'rehearsal', rehearsalUrl, productionUrl, authorization, driverEnv = process.env } = {}) {
  if (target !== 'rehearsal' && target !== 'production') {
    // Never echo the value: a misplaced connection string must not be printed.
    refuse('TARGET_UNKNOWN', '--target must be rehearsal or production (the value given is not shown).');
  }
  if (target === 'rehearsal') {
    if (!rehearsalUrl) refuse('CONNECTION_STRING_MISSING', 'PHOENIX_C5_ACTIVATION_DATABASE_URL is required for a rehearsal.');
    let url;
    try {
      url = new URL(String(rehearsalUrl));
    } catch {
      refuse('CONNECTION_STRING_UNPARSEABLE', 'The rehearsal connection string is not a parseable URL (not shown).');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      refuse('TARGET_NOT_LOOPBACK', 'A rehearsal connection string must be a postgres:// or postgresql:// URL (not shown).');
    }
    // D-06: the driver lets a query parameter REPLACE the URL's host or port
    // (pg-connection-string copies every parameter and only falls back to the
    // URL host when none is given). No such override is accepted at all.
    const overrides = [...url.searchParams.keys()].filter((k) => CONNECTION_TARGET_REDIRECT_KEYS.includes(k.toLowerCase()));
    if (overrides.length > 0) {
      refuse('TARGET_NOT_LOOPBACK',
        `A rehearsal connection string may not override the host or port through its query (${[...new Set(overrides.map((k) => k.toLowerCase()))].sort().join(', ')}); ` +
          'no secret material is shown.');
    }
    if (!LOOPBACK_HOSTS.includes(url.hostname)) {
      refuse('TARGET_NOT_LOOPBACK',
        'A rehearsal may only address a loopback database; the host is not 127.0.0.1, localhost or ::1 ' +
          '(no secret material is shown). Production requires --target=production and a separate Owner authorization.');
    }
    // ... and the EFFECTIVE target, exactly as the driver will resolve it.
    let effective;
    try {
      effective = parsePgConnectionString(String(rehearsalUrl));
    } catch {
      refuse('CONNECTION_STRING_UNPARSEABLE', 'The rehearsal connection string is not parseable by the driver (not shown).');
    }
    if (!LOOPBACK_HOSTS.includes(String(effective?.host ?? '')) || (effective?.hostaddr !== undefined && effective?.hostaddr !== null)) {
      refuse('TARGET_NOT_LOOPBACK', 'The driver would resolve this rehearsal connection string to a non-loopback host (not shown).');
    }
    if (String(rehearsalUrl).includes(PINNED_PROJECT_REF)) {
      refuse('TARGET_NOT_LOOPBACK', 'The rehearsal connection string names the pinned Production project ref.');
    }
    return { kind: 'rehearsal', connectionString: String(rehearsalUrl) };
  }
  if (authorization !== PRODUCTION_AUTHORIZATION_PHRASE) {
    refuse('PRODUCTION_NOT_AUTHORIZED',
      'Production activation requires the exact PHOENIX_C5_ACTIVATION_AUTHORIZATION phrase issued with a separate ' +
        'Owner Production authorization. None is in force.');
  }
  // One coercion: the string validated below is exactly the string returned.
  const connectionString = productionUrl === undefined || productionUrl === null ? productionUrl : String(productionUrl);
  try {
    assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);
  } catch (e) {
    if (e instanceof ProductionMigrationRefusal) refuse('PROJECT_REF_MISMATCH', e.message);
    throw e;
  }
  assertProductionEffectiveTarget(connectionString, driverEnv);
  return { kind: 'production', connectionString };
}

/**
 * DIR-01: the Production connection string must lead the DRIVER to the pinned
 * project, not merely look like it. assertProjectRefPinned reads only the
 * lexical URL username/hostname; the driver can take its destination from
 * query parameters (host, port, user, …) or, for an empty host/port, from the
 * PG* environment. So, before any connection:
 *   1. postgres:// or postgresql:// only;
 *   2. no redirect-capable query key (CONNECTION_TARGET_REDIRECT_KEYS, plus the
 *      pooler's PRODUCTION_TENANT_ROUTING_KEYS and the walsender switch
 *      PRODUCTION_SESSION_MODE_KEYS), whatever its case — and none of the PG*
 *      variables pg falls back to for them (PRODUCTION_DRIVER_ENV_KEYS);
 *   3. the string buildRemoteIo will hand to pg (sanitizeRemoteConnectionString)
 *      is parsed with pg-connection-string — the parser pg itself uses — and
 *      the EFFECTIVE host, port, database and user must be the pinned
 *      project's: the direct host db.<ref>.supabase.co, or a
 *      *.pooler.supabase.com host with the tenant user <role>.<ref>; an
 *      explicit port 5432/6543 (so PGPORT never applies); database postgres;
 *      and the effective host must equal the URL's own host (no parser
 *      divergence).
 * Harmless parameters (sslmode & co., application_name, timeouts) pass.
 * Refusal messages name query keys / variable names only, never a value.
 */
function assertProductionEffectiveTarget(productionUrl, driverEnv) {
  let url;
  try {
    url = new URL(productionUrl);
  } catch {
    refuse('PRODUCTION_TARGET_UNPARSEABLE', 'The Production connection string is not a parseable URL (not shown).');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    refuse('PRODUCTION_TARGET_PROTOCOL', 'A Production connection string must be a postgres:// or postgresql:// URL (not shown).');
  }
  const forbidden = [...CONNECTION_TARGET_REDIRECT_KEYS, ...PRODUCTION_TENANT_ROUTING_KEYS, ...PRODUCTION_SESSION_MODE_KEYS];
  const overrides = [...new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()).filter((k) => forbidden.includes(k)))].sort();
  if (overrides.length > 0) {
    refuse('PRODUCTION_TARGET_REDIRECT',
      `A Production connection string may not redirect the connection through its query (${overrides.join(', ')}); ` +
        'no secret material is shown.');
  }
  let effective;
  try {
    effective = parsePgConnectionString(sanitizeRemoteConnectionString(productionUrl));
  } catch {
    refuse('PRODUCTION_TARGET_UNPARSEABLE', 'The Production connection string is not parseable by the driver (not shown).');
  }
  // Defense in depth against a parser divergence: the driver config itself
  // carries no redirect key beyond the canonical host/port/user it derives.
  const configOverrides = Object.keys(effective).filter((k) => forbidden.includes(k.toLowerCase()) && !['host', 'port', 'user'].includes(k));
  if (configOverrides.length > 0) {
    refuse('PRODUCTION_TARGET_REDIRECT', 'The driver would read a redirect-capable option from this Production connection string (not shown).');
  }
  const host = String(effective.host ?? '');
  const user = String(effective.user ?? '');
  const direct = host === PRODUCTION_DIRECT_HOST && (PG_ROLE_PATTERN.test(user) || PINNED_TENANT_USER_PATTERN.test(user));
  const pooler = SUPABASE_POOLER_HOST_PATTERN.test(host) && PINNED_TENANT_USER_PATTERN.test(user);
  if (!(direct || pooler) || host !== url.hostname) {
    refuse('PRODUCTION_TARGET_NOT_PINNED',
      `The driver would not connect to the pinned Supabase project ${PINNED_PROJECT_REF}: the effective host and user must be ` +
        `its direct endpoint or its pooler tenant (checked the driver-parsed host and user; no secret material is shown).`);
  }
  if (!PRODUCTION_PORTS.includes(String(effective.port ?? '')) || effective.database !== PRODUCTION_DATABASE) {
    refuse('PRODUCTION_TARGET_SHAPE',
      `A Production connection string must name an explicit port (${PRODUCTION_PORTS.join(' or ')}) and the database ` +
        `${PRODUCTION_DATABASE} (not shown).`);
  }
  // pg falls back to these for `options` / `replication` when the string has none.
  const envOverrides = PRODUCTION_DRIVER_ENV_KEYS.filter((k) => typeof driverEnv?.[k] === 'string' && driverEnv[k] !== '');
  if (envOverrides.length > 0) {
    refuse('PRODUCTION_TARGET_ENVIRONMENT',
      `The driver would add startup options from the environment (${envOverrides.join(', ')}); unset them before a Production ` +
        'run (the values are not shown).');
  }
}

/** Evidence must live outside the repository (it is sealed by hash, never committed). */
export function assertEvidenceDirOutsideRepo(evidenceDirAbs, repoRootAbs) {
  if (!evidenceDirAbs) refuse('EVIDENCE_DIR_MISSING', '--evidence-dir is required (an absolute directory outside the repository).');
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const dir = norm(evidenceDirAbs);
  const root = norm(repoRootAbs);
  if (dir === root || dir.startsWith(`${root}/`)) {
    refuse('EVIDENCE_DIR_INSIDE_REPO', 'The evidence directory is inside the repository; activation evidence is sealed outside it.');
  }
  return evidenceDirAbs;
}

export function assertOperatorId(operatorId) {
  const id = String(operatorId ?? '').toLowerCase();
  if (!UUID_PATTERN.test(id)) refuse('OPERATOR_ID_MALFORMED', 'The governed rejection operator must be named by its profile uuid.');
  return id;
}

const OWNER_REFERENCE_MAX = 200;
const SECRET_LIKE = /postgres(?:ql)?:\/\//i;

/**
 * D-11 — the Owner-reviewed CASCADE path (H8) is selected ONLY by an explicit
 * Owner review reference (`--reviewed-cascade=<owner_reference>`), which is
 * sealed with the ACL0 assessment. A bare flag is refused: it would let an
 * operator suppress the grant-option HOLD and run REVOKE ... CASCADE with no
 * recorded Owner decision.
 *
 * @returns {null | {owner_reference:string}}
 */
export function assertReviewedCascade(input) {
  if (input === undefined || input === null || input === false) return null;
  if (typeof input !== 'string' || input.trim() === '') {
    refuse('CASCADE_OWNER_REFERENCE_REQUIRED',
      'The reviewed CASCADE path needs the Owner review reference (--reviewed-cascade=<owner_reference>); a bare flag is refused.');
  }
  const ref = input.trim();
  if (ref.length > OWNER_REFERENCE_MAX || SECRET_LIKE.test(ref) || /[\r\n]/.test(ref)) {
    refuse('CASCADE_OWNER_REFERENCE_REQUIRED', `The Owner review reference must be one line of at most ${OWNER_REFERENCE_MAX} characters.`);
  }
  return { owner_reference: ref };
}

/**
 * D-02 — the executor's terminal state as the release operator read it from
 * the executor run: `{ run_id, conclusion }`. `run_id` is the numeric GitHub
 * run id; it is absent exactly when the conclusion is 'not_dispatched'.
 *
 * @returns {null | {run_id:string|null, conclusion:string}}
 */
export function assertExecutorRun(input) {
  if (input === undefined || input === null) return null;
  const conclusion = String(input.conclusion ?? '');
  if (!EXECUTOR_CONCLUSIONS.includes(conclusion)) {
    refuse('EXECUTOR_RUN_MALFORMED', `The executor conclusion must be one of ${EXECUTOR_CONCLUSIONS.join(' | ')}, got ${JSON.stringify(input.conclusion ?? null)}.`);
  }
  const rawId = input.run_id === undefined || input.run_id === null ? '' : String(input.run_id);
  if (conclusion === 'not_dispatched') {
    if (rawId !== '' && rawId !== 'none') refuse('EXECUTOR_RUN_MALFORMED', 'An executor that was never dispatched has no run id.');
    return { run_id: null, conclusion };
  }
  if (!/^[1-9][0-9]{0,19}$/.test(rawId)) {
    refuse('EXECUTOR_RUN_MALFORMED', `A dispatched executor run is named by its numeric run id (conclusion ${conclusion}).`);
  }
  return { run_id: rawId, conclusion };
}

// ---------------------------------------------------------------------------
// H12 — fresh Production-history attestation, before T0.
// ---------------------------------------------------------------------------

/**
 * Bind this activation to Production's ACTUAL M216 row and to the exact M217
 * the executor will be dispatched with, before anything is frozen.
 *
 * Identity = canonical number + filename + sealed SHA-256 + FRESH version +
 * FRESH name + reconciled history. The version and name are read now; they
 * must equal the sealed dispatch record, and the reconciler must independently
 * place that row at canonical 216. A fixture timestamp is never accepted as
 * Production truth, because nothing here derives the M216 version from the
 * repository.
 *
 * @param {{remoteRows:{version:string,name:string}[],
 *          localMigrations:{version:number,filename:string,sha256:string,manualApplyOnly?:boolean}[],
 *          sealedM216?:object,
 *          executor:{migrationFilename:string,migrationSha256:string,expectedCurrentCeiling:string|number,
 *                    expectedNextCeiling:string|number,remoteHistoryVersion:string}}} args
 */
export function attestProductionHistory({ remoteRows, localMigrations, sealedM216 = SEALED_M216, executor } = {}) {
  // ---- executor inputs, validated before anything is read into a decision --
  const ex = executor ?? {};
  if (String(ex.expectedCurrentCeiling ?? '') !== String(EXPECTED_CURRENT_CEILING)
    || String(ex.expectedNextCeiling ?? '') !== String(EXPECTED_NEXT_CEILING)) {
    refuse('EXECUTOR_CEILING_MISMATCH',
      `The executor must be pinned ${EXPECTED_CURRENT_CEILING} -> ${EXPECTED_NEXT_CEILING}, got ` +
        `${JSON.stringify(ex.expectedCurrentCeiling ?? null)} -> ${JSON.stringify(ex.expectedNextCeiling ?? null)}.`);
  }
  if (ex.migrationFilename !== M217_FILENAME) {
    refuse('EXECUTOR_FILENAME_MISMATCH', `The executor filename must be exactly ${M217_FILENAME}, got ${JSON.stringify(ex.migrationFilename ?? null)}.`);
  }
  const pinnedSha = String(ex.migrationSha256 ?? '');
  if (!SHA256_PATTERN.test(pinnedSha)) {
    refuse('EXECUTOR_SHA256_MALFORMED', 'The executor migration_sha256 must be 64 lowercase hex characters.');
  }

  // ---- the local catalogue --------------------------------------------------
  if (!Array.isArray(localMigrations) || localMigrations.length === 0) {
    refuse('LOCAL_MANIFEST_EMPTY', 'The local migration catalogue is empty.');
  }
  const local216 = localMigrations.filter((m) => m.version === sealedM216.canonical);
  if (local216.length !== 1 || local216[0].filename !== sealedM216.filename) {
    refuse('M216_LOCAL_FILENAME_MISMATCH',
      `Local canonical ${sealedM216.canonical} must be exactly ${sealedM216.filename}.`);
  }
  if (String(local216[0].sha256 ?? '').toLowerCase() !== sealedM216.sha256) {
    refuse('M216_LOCAL_SHA256_MISMATCH',
      `Local ${sealedM216.filename} hashes to ${local216[0].sha256}, sealed dispatch identity is ${sealedM216.sha256}.`);
  }
  const local217 = localMigrations.filter((m) => m.version === EXPECTED_NEXT_CEILING);
  if (local217.length !== 1 || local217[0].filename !== M217_FILENAME) {
    refuse('M217_MISSING_LOCALLY', `This checkout must carry exactly one canonical ${M217_FILENAME}.`);
  }
  if (parseMigrationVersion(local217[0].filename) !== EXPECTED_NEXT_CEILING) {
    refuse('M217_MISSING_LOCALLY', `${local217[0].filename} does not parse as canonical ${EXPECTED_NEXT_CEILING}.`);
  }
  if (String(local217[0].sha256 ?? '').toLowerCase() !== pinnedSha) {
    refuse('EXECUTOR_SHA256_MISMATCH',
      `Local ${M217_FILENAME} hashes to ${local217[0].sha256}, the executor is pinned to ${pinnedSha}.`);
  }
  if (local217[0].manualApplyOnly === true) {
    refuse('M217_MANUAL_APPLY_ONLY', `${M217_FILENAME} declares MANUAL APPLY ONLY; the executor would refuse it.`);
  }

  // ---- fresh history, reconciled -------------------------------------------
  if ((remoteRows ?? []).some((r) => String(r?.name) === M217_HISTORY_NAME)) {
    refuse('M217_ALREADY_RECORDED', `Production history already carries a row named ${M217_HISTORY_NAME}; this is not a pre-M217 state.`);
  }
  let reconciled;
  try {
    reconciled = reconcileMigrationHistory(remoteRows, localMigrations);
  } catch (e) {
    if (e instanceof MigrationHistoryRefusal) {
      refuse('HISTORY_NOT_RECONCILED', `[${e.code}] ${e.message}`, { historyCode: e.code });
    }
    throw e;
  }
  if (reconciled.canonicalCeiling !== EXPECTED_CURRENT_CEILING) {
    refuse('CEILING_NOT_216', `Fresh Production history reconciles to canonical ${reconciled.canonicalCeiling}, expected ${EXPECTED_CURRENT_CEILING}.`);
  }
  const row216 = reconciled.mapping.find((m) => m.canonical === sealedM216.canonical);
  if (!row216 || row216.remoteVersion !== sealedM216.remoteVersion) {
    refuse('M216_ROW_VERSION_MISMATCH',
      `Fresh Production history places ${row216?.remoteVersion ?? 'nothing'} at canonical ${sealedM216.canonical}; ` +
        `the sealed dispatch identity is ${sealedM216.remoteVersion}.`);
  }
  if (row216.remoteName !== sealedM216.remoteName) {
    refuse('M216_ROW_NAME_MISMATCH',
      `Fresh Production row ${row216.remoteVersion} is named ${JSON.stringify(row216.remoteName)}, sealed ${JSON.stringify(sealedM216.remoteName)}.`);
  }
  // With ceiling 216 proven and exactly one local 217, the reconciler's own
  // totality makes the pending set at or before 217 exactly [217].

  // ---- the remote_history_version the executor will record M217 under -------
  let remoteHistoryVersion;
  try {
    remoteHistoryVersion = assertRemoteHistoryVersionUsable(ex.remoteHistoryVersion, remoteRows);
  } catch (e) {
    if (e instanceof MigrationHistoryRefusal) {
      refuse('REMOTE_HISTORY_VERSION_UNUSABLE', `[${e.code}] ${e.message}`, { historyCode: e.code });
    }
    throw e;
  }

  return {
    canonical_ceiling: reconciled.canonicalCeiling,
    remote_row_count: remoteRows.length,
    numeric_row_count: reconciled.numericRowCount,
    timestamp_row_count: reconciled.timestampRowCount,
    m216: {
      canonical: sealedM216.canonical,
      filename: sealedM216.filename,
      sealed_sha256: sealedM216.sha256,
      local_sha256: local216[0].sha256,
      fresh_version: row216.remoteVersion,
      fresh_name: row216.remoteName,
    },
    m217: {
      filename: M217_FILENAME,
      local_sha256: local217[0].sha256,
      executor_sha256: pinnedSha,
      expected_history_name: M217_HISTORY_NAME,
      remote_history_version: remoteHistoryVersion,
    },
    newest_remote_version: remoteRows.map((r) => String(r.version)).filter((v) => /^\d{14}$/.test(v)).sort().pop() ?? null,
  };
}

/**
 * D-05 — the preflight evidence opens a T0 only while it is fresh. Both
 * instants are database clock readings (UTC text), so the runner's local
 * clock plays no part. The bound can only be tightened by a caller.
 *
 * @returns {number} the age in seconds
 */
export function assertPreflightFresh({ preflightAt, now, maxAgeSeconds = PREFLIGHT_MAX_AGE_SECONDS } = {}) {
  const bound = Math.min(Number.isFinite(maxAgeSeconds) ? maxAgeSeconds : PREFLIGHT_MAX_AGE_SECONDS, PREFLIGHT_MAX_AGE_SECONDS);
  const a = Date.parse(String(preflightAt ?? ''));
  const b = Date.parse(String(now ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    refuse('PREFLIGHT_TIME_MISSING', 'The preflight or the current database time was not read; the preflight cannot open a T0.');
  }
  const age = (b - a) / 1000;
  if (age < 0) refuse('PREFLIGHT_CLOCK_REGRESSED', `The database clock reads ${age}s before the sealed preflight; refusing to open a T0.`);
  if (age > bound) {
    refuse('PREFLIGHT_STALE', `The preflight evidence is ${Math.round(age)}s old (bound ${bound}s); run --phase=preflight again, then freeze at once.`);
  }
  return age;
}

/**
 * D-05 — the history attestation re-read immediately before T0 must be the
 * sealed preflight attestation exactly (a new history row, a moved M216 row,
 * changed executor inputs or local bytes all differ).
 */
export function assertAttestationUnchanged(sealed, fresh) {
  if (!sealed || !fresh || JSON.stringify(sealed) !== JSON.stringify(fresh)) {
    refuse('PREFLIGHT_ATTESTATION_CHANGED',
      'The Production-history attestation re-read immediately before T0 differs from the sealed preflight attestation.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// H1 — runner capability, and the same identity for every read.
// ---------------------------------------------------------------------------

/**
 * The §2 reads are only meaningful as a role that sees every row and every
 * session: (rolsuper OR rolbypassrls) AND (rolsuper OR pg_read_all_stats).
 * A runner lacking either is silently blind (a false-zero drain, or RLS-hidden
 * revisions), so it is refused before T0.
 */
export function assertRunnerCapability(attrs) {
  if (!attrs || typeof attrs.current_user !== 'string' || attrs.current_user === '') {
    refuse('RUNNER_ATTRIBUTES_MISSING', 'Runner attributes (current_user, rolsuper, rolbypassrls, pg_read_all_stats) were not read.');
  }
  for (const k of ['rolsuper', 'rolbypassrls', 'pg_read_all_stats']) {
    if (typeof attrs[k] !== 'boolean') refuse('RUNNER_ATTRIBUTES_MISSING', `Runner attribute ${k} was not read as a boolean.`);
  }
  if (!(attrs.rolsuper || attrs.rolbypassrls)) {
    refuse('RUNNER_CANNOT_BYPASS_RLS', `Runner ${attrs.current_user} is neither superuser nor BYPASSRLS; §2 reads would be RLS-filtered.`);
  }
  if (!(attrs.rolsuper || attrs.pg_read_all_stats)) {
    refuse('RUNNER_CANNOT_SEE_ALL_SESSIONS',
      `Runner ${attrs.current_user} is neither superuser nor a pg_read_all_stats member; the drain could report a false zero.`);
  }
  return {
    current_user: attrs.current_user,
    session_user: attrs.session_user ?? null,
    rolsuper: attrs.rolsuper,
    rolbypassrls: attrs.rolbypassrls,
    pg_read_all_stats: attrs.pg_read_all_stats,
  };
}

/** Every later read must come from the attested identity. */
export function assertSameRunner(attested, observed, where) {
  const sameCurrent = Boolean(attested && observed) && attested.current_user === observed.current_user;
  const sameSession = Boolean(attested && observed)
    && (observed.session_user === undefined || (attested.session_user ?? null) === (observed.session_user ?? null));
  if (!sameCurrent || !sameSession) {
    refuse('RUNNER_IDENTITY_CHANGED',
      `${where}: the read ran as ${observed?.current_user ?? '(unknown)'}, not the attested runner ${attested?.current_user ?? '(none)'}.`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// H7 — the governed rejection operator, verified before T0.
// ---------------------------------------------------------------------------

/**
 * The reject RPC authorizes through the Central Needs guard: active profile,
 * eligible role, central_needs.approve on the revision's owner organization
 * (super_admin: any organization), owner organization present and not
 * archived. Every owner organization of a submitted revision must pass, and
 * `authenticated` must still hold EXECUTE on reject (the operator calls it as
 * an ordinary authenticated identity; the freeze never touches it).
 *
 * @param {{operator:object|null, ownerOrgs:{id:string,exists:boolean,archived:boolean}[],
 *          rejectExecutableByAuthenticated:boolean}} args
 */
export function assertRejectOperatorReady({ operator, ownerOrgs, rejectExecutableByAuthenticated } = {}) {
  if (!operator || !operator.id) refuse('OPERATOR_NOT_FOUND', 'The governed rejection operator has no profile.');
  if (operator.status !== 'active') refuse('OPERATOR_NOT_ACTIVE', `Operator ${operator.id} is ${JSON.stringify(operator.status)}, not active.`);
  if (!ELIGIBLE_OPERATOR_ROLES.includes(operator.role)) {
    refuse('OPERATOR_ROLE_INELIGIBLE', `Operator ${operator.id} has role ${JSON.stringify(operator.role)}; the guard admits only ${ELIGIBLE_OPERATOR_ROLES.join(' | ')}.`);
  }
  if (operator.has_reject_capability !== true) {
    refuse('OPERATOR_LACKS_REJECT_CAPABILITY', `Operator ${operator.id} does not hold ${REJECT_CAPABILITY}.`);
  }
  for (const org of ownerOrgs ?? []) {
    if (!org.exists || org.archived) {
      refuse('OWNER_ORG_NOT_LIVE', `Owner organization ${org.id} of a submitted revision is ${org.exists ? 'archived' : 'missing'}; reject would refuse.`);
    }
    if (operator.role !== 'super_admin' && operator.organization_id !== org.id) {
      refuse('OPERATOR_ORG_MISMATCH', `Operator ${operator.id} belongs to ${operator.organization_id}, not owner organization ${org.id}.`);
    }
  }
  if (rejectExecutableByAuthenticated !== true) {
    refuse('REJECT_RPC_NOT_CALLABLE', `authenticated does not hold EXECUTE on ${REJECT_SIGNATURE}; the governed rejection path is unavailable.`);
  }
  return {
    operator_id: operator.id,
    role: operator.role,
    organization_id: operator.organization_id ?? null,
    owner_orgs_checked: (ownerOrgs ?? []).map((o) => o.id).sort(),
  };
}

// ---------------------------------------------------------------------------
// H8 — ACL tuples: normalization, semantic equality, freeze/restore plans.
// ---------------------------------------------------------------------------

const ACL_KEYS = ['fn', 'owner', 'grantee', 'grantor', 'privilege', 'grantable'];

/** Normalize one aclexplode tuple to the H8 shape. */
export function normalizeAclTuple(t) {
  for (const k of ACL_KEYS) {
    if (t?.[k] === undefined || t?.[k] === null) refuse('ACL_TUPLE_MALFORMED', `ACL tuple is missing ${k}.`);
  }
  return {
    fn: String(t.fn), owner: String(t.owner), grantee: String(t.grantee), grantor: String(t.grantor),
    privilege: String(t.privilege), grantable: t.grantable === true,
  };
}

/** The order-insensitive identity of an ACL tuple set. */
export function aclSetKey(tuples) {
  return (tuples ?? []).map(normalizeAclTuple)
    .map((t) => JSON.stringify(ACL_KEYS.map((k) => t[k])))
    .sort();
}

/** Semantic (order-insensitive, duplicate-insensitive) ACL set equality. */
export function aclSetsEqual(a, b) {
  const ka = [...new Set(aclSetKey(a))];
  const kb = [...new Set(aclSetKey(b))];
  return sameList(ka, kb);
}

/** The tuples present in `a` but not in `b` (for evidence). */
export function aclSetDifference(a, b) {
  const kb = new Set(aclSetKey(b));
  return (a ?? []).map(normalizeAclTuple).filter((t) => !kb.has(JSON.stringify(ACL_KEYS.map((k) => t[k]))));
}

/**
 * D-03 — the frozen set the §2.2 DCL must produce from a captured ACL0: the
 * owner's own tuples and nothing else. It is sealed BEFORE the freeze
 * transaction, so the freeze state can be derived from the catalog even when
 * the transaction's outcome (or the post-COMMIT reads) are lost.
 */
export function planFrozenAcl(acl0) {
  return (acl0 ?? []).map(normalizeAclTuple).filter((t) => t.grantee === t.owner);
}

/**
 * D-09 — a genuine pre-freeze ACL0 lets clients call submit AND approve: each
 * carries an EXECUTE tuple for `authenticated` (or PUBLIC, which includes it).
 * An ACL without one looks frozen and is never captured or carried as ACL0.
 */
export function aclGrantsClientExecute(acl) {
  const tuples = (acl ?? []).map(normalizeAclTuple);
  return FREEZE_SIGNATURES.every((fn) => tuples.some((t) => t.fn === fn && t.privilege === 'EXECUTE'
    && (t.grantee === 'authenticated' || t.grantee === 'PUBLIC')));
}

export const FREEZE_STATES = Object.freeze({ IN_PLACE: 'IN_PLACE', NOT_IN_PLACE: 'NOT_IN_PLACE', UNKNOWN: 'UNKNOWN' });

/**
 * D-03 — the freeze state from CATALOG TRUTH, never from what a transaction
 * was believed to do:
 *   live ACL == frozen set  => IN_PLACE     (freeze_in_place: true)
 *   live ACL == ACL0        => NOT_IN_PLACE (freeze_in_place: false)
 *   anything else, an unreadable ACL, or an ACL0 indistinguishable from its
 *   frozen set             => UNKNOWN       (freeze_in_place: 'UNKNOWN')
 * Only NOT_IN_PLACE is ever recorded as `false`; a later attempt must carry
 * forward (or explicitly rebaseline) every other state.
 */
export function deriveFreezeState({ liveAcl, acl0, frozenAcl } = {}) {
  const verdict = (state, extra = {}) => ({
    state, freeze_in_place: state === FREEZE_STATES.IN_PLACE ? true : state === FREEZE_STATES.NOT_IN_PLACE ? false : 'UNKNOWN', ...extra,
  });
  if (!Array.isArray(liveAcl)) return verdict(FREEZE_STATES.UNKNOWN, { reason: 'the live ACL could not be read' });
  if (!Array.isArray(acl0) || !Array.isArray(frozenAcl)) return verdict(FREEZE_STATES.UNKNOWN, { reason: 'no sealed ACL0 or frozen set to compare with' });
  if (aclSetsEqual(acl0, frozenAcl)) return verdict(FREEZE_STATES.UNKNOWN, { reason: 'ACL0 is indistinguishable from its frozen set' });
  if (aclSetsEqual(liveAcl, frozenAcl)) return verdict(FREEZE_STATES.IN_PLACE);
  if (aclSetsEqual(liveAcl, acl0)) return verdict(FREEZE_STATES.NOT_IN_PLACE);
  return verdict(FREEZE_STATES.UNKNOWN, {
    reason: 'the live ACL is neither ACL0 nor the frozen set',
    unexpected_vs_frozen: aclSetDifference(liveAcl, frozenAcl), missing_vs_frozen: aclSetDifference(frozenAcl, liveAcl),
  });
}

/**
 * Judge the captured ACL0 before any DCL. Refuses (HOLD) when:
 *   - a frozen function is missing from the snapshot;
 *   - any tuple's grantor is not the function owner (a grant made by a
 *     grant-option holder, which an owner REVOKE does not remove); or
 *   - any non-owner grantee holds the grant option (a chain can exist);
 * unless the Owner-reviewed CASCADE path is explicitly selected.
 */
export function assessAclSnapshot(acl0, { reviewedCascade = false } = {}) {
  const tuples = (acl0 ?? []).map(normalizeAclTuple);
  for (const fn of FREEZE_SIGNATURES) {
    if (!tuples.some((t) => t.fn === fn)) refuse('ACL_SNAPSHOT_INCOMPLETE', `The T0 ACL snapshot carries no tuple for ${fn}.`, { hold: true });
  }
  for (const t of tuples) {
    if (!FREEZE_SIGNATURES.includes(t.fn)) refuse('ACL_SNAPSHOT_INCOMPLETE', `The T0 ACL snapshot carries an unexpected function ${t.fn}.`, { hold: true });
  }
  const nonOwnerGrantor = tuples.filter((t) => t.grantor !== t.owner);
  const grantOption = tuples.filter((t) => t.grantee !== t.owner && t.grantable);
  if (!reviewedCascade && nonOwnerGrantor.length > 0) {
    refuse('ACL_NON_OWNER_GRANTOR',
      `ACL0 carries grants whose grantor is not the owner (${nonOwnerGrantor.map((t) => `${t.fn}:${t.grantee}<-${t.grantor}`).join(', ')}); ` +
        'an owner REVOKE does not remove them. HOLD unless the Owner-reviewed CASCADE path is selected.', { hold: true });
  }
  if (!reviewedCascade && grantOption.length > 0) {
    refuse('ACL_GRANT_OPTION_CHAIN',
      `ACL0 carries grant options (${grantOption.map((t) => `${t.fn}:${t.grantee}`).join(', ')}); a chain may exist. ` +
        'HOLD unless the Owner-reviewed CASCADE path is selected.', { hold: true });
  }
  return {
    tuple_count: tuples.length,
    non_owner_grantor: nonOwnerGrantor,
    grant_option: grantOption,
    cascade: reviewedCascade && (nonOwnerGrantor.length > 0 || grantOption.length > 0),
  };
}

const IDENT_SAFE = /^[\p{L}\p{N}_$ -]+$/u;
/** Quote a role name for DCL; PUBLIC is the keyword, never a quoted identifier. */
export function quoteRole(role) {
  const r = String(role ?? '');
  if (r === 'PUBLIC') return 'PUBLIC';
  if (r === '' || !IDENT_SAFE.test(r)) refuse('ACL_ROLE_NAME_UNSAFE', `Role name ${JSON.stringify(r)} is not a plain identifier.`);
  return `"${r.replace(/"/g, '""')}"`;
}

const assertFrozenFn = (fn) => {
  if (!FREEZE_SIGNATURES.includes(fn)) refuse('ACL_FUNCTION_UNEXPECTED', `Refusing DCL on ${fn}; only submit/approve are ever frozen.`);
  return fn;
};

/**
 * §2.2 freeze DCL, in order: REVOKE from every captured non-owner grantee,
 * then the explicit REVOKE from authenticated, service_role, anon, PUBLIC.
 * Reject is never named. CASCADE only on the Owner-reviewed path.
 */
export function planFreezeStatements(acl0, { reviewedCascade = false } = {}) {
  const tuples = (acl0 ?? []).map(normalizeAclTuple);
  const stmts = [];
  const seen = new Set();
  for (const t of tuples) {
    if (t.grantee === t.owner) continue;
    const key = `${t.fn}|${t.grantee}|${t.privilege}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cascade = reviewedCascade && tuples.some((x) => x.fn === t.fn && x.grantee === t.grantee && x.grantable) ? ' CASCADE' : '';
    stmts.push(`REVOKE ${t.privilege} ON FUNCTION ${assertFrozenFn(t.fn)} FROM ${quoteRole(t.grantee)}${cascade}`);
  }
  for (const fn of FREEZE_SIGNATURES) {
    stmts.push(`REVOKE EXECUTE ON FUNCTION ${fn} FROM ${EXPLICIT_FREEZE_GRANTEES.map(quoteRole).join(', ')}`);
  }
  return stmts;
}

/**
 * §2.6 restore DCL: exactly the captured ACL0, no guessed or default grants.
 * Owner-granted tuples first; tuples granted by a grant-option holder (only
 * possible on the reviewed CASCADE path) are re-granted AS that grantor,
 * because PostgreSQL records the executing role as grantor.
 */
export function planRestoreStatements(acl0) {
  const tuples = (acl0 ?? []).map(normalizeAclTuple).filter((t) => t.grantee !== t.owner);
  const byOwner = tuples.filter((t) => t.grantor === t.owner);
  const byOthers = tuples.filter((t) => t.grantor !== t.owner);
  const grant = (t) => `GRANT ${t.privilege} ON FUNCTION ${assertFrozenFn(t.fn)} TO ${quoteRole(t.grantee)}${t.grantable ? ' WITH GRANT OPTION' : ''}`;
  const stmts = byOwner.map(grant);
  for (const t of byOthers) {
    stmts.push(`SET LOCAL ROLE ${quoteRole(t.grantor)}`, grant(t), 'RESET ROLE');
  }
  return stmts;
}

/**
 * §2.2 verification, sealed as the frozen ACL: only owner self-tuples remain,
 * no client role can execute, PUBLIC holds nothing, every captured grantee is
 * cut off (a superuser/owner-equivalent grantee is recorded, not an ordinary
 * client path), and reject is untouched.
 */
export function assessFreeze({ acl0, frozenAcl, privileges, rejectAcl0, rejectAclNow } = {}) {
  const failures = [];
  const frozen = (frozenAcl ?? []).map(normalizeAclTuple);
  const residue = frozen.filter((t) => t.grantee !== t.owner);
  if (residue.length > 0) failures.push({ code: 'ACL_FREEZE_INCOMPLETE', detail: residue.map((t) => `${t.fn}:${t.grantee}`) });
  if (residue.length === 0 && !aclSetsEqual(frozen, planFrozenAcl(acl0))) {
    failures.push({ code: 'ACL_FREEZE_SHAPE_UNEXPECTED', detail: { unexpected: aclSetDifference(frozen, planFrozenAcl(acl0)), missing: aclSetDifference(planFrozenAcl(acl0), frozen) } });
  }
  const captured = new Set((acl0 ?? []).map(normalizeAclTuple).filter((t) => t.grantee !== t.owner && t.grantee !== 'PUBLIC').map((t) => t.grantee));
  const ownerEquivalent = [];
  for (const p of privileges ?? []) {
    if (!p.can_execute) continue;
    if (CLIENT_ROLES.includes(p.role)) {
      failures.push({ code: 'ACL_FREEZE_INCOMPLETE', detail: `${p.role} can still execute ${p.fn}` });
    } else if (captured.has(p.role)) {
      if (p.superuser || p.owner_equivalent) ownerEquivalent.push(`${p.fn}:${p.role}`);
      else failures.push({ code: 'ACL_FREEZE_INCOMPLETE', detail: `captured grantee ${p.role} can still execute ${p.fn}` });
    }
  }
  if (!aclSetsEqual(rejectAcl0, rejectAclNow)) failures.push({ code: 'REJECT_ACL_CHANGED', detail: 'the reject ACL moved during the freeze' });
  return { pass: failures.length === 0, failures, owner_equivalent_grantees: ownerEquivalent.sort() };
}

// ---------------------------------------------------------------------------
// H2 — the drain.
// ---------------------------------------------------------------------------

/**
 * §2.3 drain PASS = zero OTHER client transactions older than F0 (the exact
 * contract SQL) AND zero '<insufficient privilege>' sessions (no backend_type
 * filter — a hidden session has none) AND zero prepared transactions for the
 * database. Hidden sessions are a HOLD: the runner cannot see what it must
 * prove absent. Live old transactions and prepared transactions are a WAIT:
 * the freeze stays in place and the drain is re-polled; terminating a backend
 * or resolving a prepared transaction needs a separately recorded operator
 * decision.
 */
export function evaluateDrain({ preF0Rows, hiddenRows, preparedRows } = {}) {
  if (!Array.isArray(preF0Rows) || !Array.isArray(hiddenRows) || !Array.isArray(preparedRows)) {
    refuse('DRAIN_INPUT_MISSING', 'The drain needs the pre-F0, hidden-session and prepared-transaction reads.');
  }
  const codes = [];
  if (hiddenRows.length > 0) codes.push('DRAIN_HIDDEN_SESSIONS');
  if (preF0Rows.length > 0) codes.push('DRAIN_PRE_F0_TRANSACTIONS');
  if (preparedRows.length > 0) codes.push('DRAIN_PREPARED_TRANSACTIONS');
  const decision = codes.length === 0 ? 'PASS' : (codes.includes('DRAIN_HIDDEN_SESSIONS') ? 'HOLD' : 'WAIT');
  return {
    pass: decision === 'PASS', decision, codes,
    pre_f0: preF0Rows.length, hidden: hiddenRows.length, prepared: preparedRows.length,
  };
}

// ---------------------------------------------------------------------------
// H6 — governed resolution of S0 ∪ S1.
// ---------------------------------------------------------------------------

export function submittedUnion(s0, s1) {
  return sortedUnique([...(s0 ?? []), ...(s1 ?? [])]);
}

/**
 * The canonical reject evidence for one revision: a reject audit for the same
 * revision and owner organization, submitted -> rejected, written by the SAME
 * physical transaction that wrote the rejected row version (equal xmin).
 * Payload strings alone never count.
 */
export function canonicalRejectEvidence(row) {
  if (!row || row.status !== 'rejected') return null;
  return (row.reject_audits ?? []).find((a) =>
    a.organization_id === row.organization_id
    && a.from_status === 'submitted' && a.to_status === 'rejected'
    && typeof a.xmin === 'string' && a.xmin === row.revision_xmin) ?? null;
}

/**
 * Before calling the reject RPC: per id, 'reject' (still submitted),
 * 'already_rejected' (H6: rejected with canonical reject evidence — resolved),
 * or a STOP (any other status, especially approved, or a missing revision).
 */
export function planResolution(evidenceRows) {
  return (evidenceRows ?? []).map((r) => {
    if (r.status === 'submitted') return { id: r.id, action: 'reject' };
    if (canonicalRejectEvidence(r)) return { id: r.id, action: 'already_rejected' };
    return { id: r.id, action: 'stop', status: r.status ?? null };
  });
}

/**
 * After the governed rejections: every id in S0 ∪ S1 must be rejected with
 * canonical, physically bound reject evidence. Anything else is a STOP before
 * M217 (C5_ACTIVATION_HOLD).
 */
export function assessResolution({ union, evidenceRows } = {}) {
  const byId = new Map((evidenceRows ?? []).map((r) => [String(r.id), r]));
  const failures = [];
  for (const id of union ?? []) {
    const r = byId.get(String(id));
    if (!r || r.status === null || r.status === undefined) failures.push({ id, code: 'REVISION_NOT_FOUND' });
    else if (r.status !== 'rejected') failures.push({ id, code: 'RESOLUTION_STATUS_UNEXPECTED', status: r.status });
    else if (!canonicalRejectEvidence(r)) failures.push({ id, code: 'RESOLUTION_EVIDENCE_MISSING' });
  }
  return { pass: failures.length === 0, failures, resolved: (union ?? []).length - failures.length };
}

// ---------------------------------------------------------------------------
// H4 / H5 — Proof A and Proof B.
// ---------------------------------------------------------------------------

const A0_FIELDS = ['status', 'plan_id', 'organization_id', 'revision_number', 'approved_by', 'approved_at', 'updated_at'];
const PARENT_FIELDS = ['plan_id', 'organization_id', 'revision_number'];
const LIFECYCLE_STATES = ['approved', 'superseded'];
const TWO_TO_32 = 4294967296n;

/**
 * H5: a gate and an approve audit are the SAME physical transaction only if
 * they share xmin and created_at, the gate's payload txid (txid_current(),
 * epoch-qualified) reduces mod 2^32 to that xmin, the approve audit names the
 * same txid, and revision / organization / actor agree. Payload strings alone
 * never pass: a forger can copy a txid string, not an xmin.
 */
export function isPhysicalSameTransaction(gate, approve) {
  if (!gate || !approve) return false;
  if (gate.action !== ACTION_GATE || approve.action !== ACTION_APPROVE) return false;
  if (gate.contract !== GATE_CONTRACT) return false;
  if (gate.entity_id !== approve.entity_id || gate.organization_id !== approve.organization_id) return false;
  if ((gate.actor_id ?? null) !== (approve.actor_id ?? null)) return false;
  if (typeof gate.txid !== 'string' || !/^[0-9]+$/.test(gate.txid)) return false;
  if (approve.approval_gate_txid !== gate.txid) return false;
  if (typeof gate.xmin !== 'string' || gate.xmin !== approve.xmin) return false;
  if (!gate.created_at || gate.created_at !== approve.created_at) return false;
  return (BigInt(gate.txid) % TWO_TO_32).toString() === gate.xmin;
}

/** Payload-only correlation (what a forger CAN reproduce), kept for evidence contrast. */
export function isPayloadMatch(gate, approve) {
  return Boolean(gate && approve && gate.entity_id === approve.entity_id && gate.organization_id === approve.organization_id
    && (gate.actor_id ?? null) === (approve.actor_id ?? null) && typeof gate.txid === 'string'
    && gate.txid === approve.approval_gate_txid && gate.contract === GATE_CONTRACT);
}

/**
 * H4 Proof A — lifecycle-state delta from A0, BOTH directions. A0 carries
 * (id,status,plan_id,organization_id,revision_number,approved_by,approved_at,
 * updated_at) for every approved/superseded revision at T0. `current` carries
 * the same fields for every revision that is approved/superseded NOW or was
 * in A0 (whatever its status now).
 *
 * In the frozen window the expected delta is EMPTY: no legitimate approval can
 * happen between F0 and the restore. Every delta is classified — approval,
 * supersede, demotion, deletion, re_parent, round_trip — and annotated with
 * whatever audit evidence exists, but ANY delta is a HOLD.
 *
 * @param {{a0:object[], current:object[], audits?:object[], t0?:string}} args
 */
export function evaluateProofA({ a0, current, audits = [], t0 = null } = {}) {
  const before = new Map((a0 ?? []).map((r) => [String(r.id), r]));
  const now = new Map((current ?? []).map((r) => [String(r.id), r]));
  const deltas = [];
  const evidenceFor = (id) => {
    const approves = audits.filter((a) => a.action === ACTION_APPROVE && a.entity_id === id);
    const gates = audits.filter((a) => a.action === ACTION_GATE && a.entity_id === id);
    const successor = audits.filter((a) => a.action === ACTION_APPROVE && a.predecessor_revision_id === id);
    return {
      approve_audits: approves.map((a) => ({ audit_id: a.audit_id, created_at: a.created_at, before_t0: t0 !== null && a.created_at < t0 })),
      physical_gate_match: approves.some((a) => gates.some((g) => isPhysicalSameTransaction(g, a))),
      payload_gate_match: approves.some((a) => gates.some((g) => isPayloadMatch(g, a))),
      successor_approve_audits: successor.map((a) => a.audit_id),
    };
  };

  for (const [id, cur] of now) {
    const old = before.get(id);
    if (!old) {
      if (LIFECYCLE_STATES.includes(cur.status)) {
        deltas.push({ id, kind: cur.status === 'approved' ? 'approval' : 'supersede', from: null, to: cur.status, evidence: evidenceFor(id) });
      }
      continue;
    }
    if (old.status !== cur.status) {
      let kind;
      if (cur.status === 'approved') kind = 'approval';
      else if (cur.status === 'superseded') kind = 'supersede';
      else kind = 'demotion';
      deltas.push({ id, kind, from: old.status, to: cur.status, evidence: evidenceFor(id) });
      continue;
    }
    const parentMoved = PARENT_FIELDS.filter((f) => String(old[f] ?? '') !== String(cur[f] ?? ''));
    if (parentMoved.length > 0) {
      deltas.push({ id, kind: 're_parent', from: old.status, to: cur.status, fields: parentMoved, evidence: evidenceFor(id) });
      continue;
    }
    const moved = A0_FIELDS.filter((f) => String(old[f] ?? '') !== String(cur[f] ?? ''));
    if (moved.length > 0) {
      deltas.push({ id, kind: 'round_trip', from: old.status, to: cur.status, fields: moved, evidence: evidenceFor(id) });
    }
  }
  for (const [id, old] of before) {
    if (!now.has(id)) deltas.push({ id, kind: 'deletion', from: old.status, to: null, evidence: evidenceFor(id) });
  }
  deltas.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { pass: deltas.length === 0, deltas, kinds: sortedUnique(deltas.map((d) => d.kind)) };
}

/**
 * H5 Proof B — every approve audit at/after T0 needs a gate from the SAME
 * physical transaction. In the frozen window both sets are expected EMPTY; any
 * approve or gate audit at/after T0 is a HOLD, and each is classified
 * (physical match vs payload-only match) so a forgery is visible as such.
 */
export function evaluateProofB({ rows } = {}) {
  const approves = (rows ?? []).filter((r) => r.action === ACTION_APPROVE && r.at_or_after_t0);
  const gates = (rows ?? []).filter((r) => r.action === ACTION_GATE);
  const gatesAfter = gates.filter((g) => g.at_or_after_t0);
  const approvals = approves.map((a) => ({
    audit_id: a.audit_id, entity_id: a.entity_id, created_at: a.created_at,
    physical_match: gates.some((g) => isPhysicalSameTransaction(g, a)),
    payload_match: gates.some((g) => isPayloadMatch(g, a)),
  }));
  const orphanGates = gatesAfter
    .filter((g) => !approves.some((a) => isPhysicalSameTransaction(g, a)))
    .map((g) => ({ audit_id: g.audit_id, entity_id: g.entity_id, created_at: g.created_at }));
  return {
    pass: approves.length === 0 && gatesAfter.length === 0,
    approvals,
    unmatched: approvals.filter((a) => !a.physical_match).map((a) => a.audit_id),
    gates_at_or_after_t0: gatesAfter.length,
    orphan_gates: orphanGates,
  };
}

/**
 * H11 backstop — the lifecycle audit census. Between T0 and the restore the
 * only permitted changes to submit/approve/gate/supersede/reject audit rows
 * are one reject audit per governed S0 ∪ S1 id and the submit audit of an S1
 * revision that straddled T0. Any other addition, and ANY removal, is direct
 * audit DML by a privileged path: HOLD.
 *
 * D-10 — FAIL-CLOSED BY DESIGN: a pre-F0 submit that commits after T0 and is
 * then rejected by an ordinary reviewer BEFORE S1 is enumerated belongs to
 * neither S0 nor S1, so its submit and reject audits are unexpected here. The
 * census is NOT relaxed for it: admitting "a post-T0 submit + a post-T0 reject
 * of a rejected revision" would also admit the same pair forged by a
 * privileged writer together with a direct status edit, which H11 forbids.
 * Instead the runbook evaluates this census as a READY_FOR_M217 precondition,
 * so the case surfaces as a STOP BEFORE M217 (exact ACL0 restored, retryable
 * after an Owner disposition), and the pattern is named here as
 * `straddler_pattern` (evidence only — it never changes `pass`).
 */
export function evaluateLifecycleAuditCensus({ l0, current, union, s0 } = {}) {
  const key = (r) => String(r.id);
  const before = new Map((l0 ?? []).map((r) => [key(r), r]));
  const now = new Map((current ?? []).map((r) => [key(r), r]));
  const unionSet = new Set((union ?? []).map(String));
  const s0Set = new Set((s0 ?? []).map(String));
  const added = [...now.values()].filter((r) => !before.has(key(r)));
  const removed = [...before.values()].filter((r) => !now.has(key(r)));
  const changed = [...now.values()].filter((r) => before.has(key(r))
    && ['action', 'entity_id', 'organization_id', 'created_at'].some((k) => (before.get(key(r))[k] ?? null) !== (r[k] ?? null)));
  const rejectsPer = new Map();
  const unexpected = [];
  for (const r of added) {
    const id = String(r.entity_id);
    if (r.action === ACTION_REJECT && unionSet.has(id)) {
      rejectsPer.set(id, (rejectsPer.get(id) ?? 0) + 1);
      if (rejectsPer.get(id) > 1) unexpected.push(r);
    } else if (r.action === ACTION_SUBMIT && unionSet.has(id) && !s0Set.has(id)) {
      // an S1 revision whose submit straddled T0
    } else {
      unexpected.push(r);
    }
  }
  const byEntity = new Map();
  for (const r of unexpected) {
    const id = String(r.entity_id);
    if (!byEntity.has(id)) byEntity.set(id, []);
    byEntity.get(id).push(r.action);
  }
  const straddlerPattern = [...byEntity.entries()]
    .filter(([id, actions]) => !unionSet.has(id) && actions.length === 2
      && actions.filter((a) => a === ACTION_SUBMIT).length === 1 && actions.filter((a) => a === ACTION_REJECT).length === 1)
    .map(([id]) => id).sort();
  return {
    pass: unexpected.length === 0 && removed.length === 0 && changed.length === 0,
    added: added.length,
    unexpected_added: unexpected,
    removed,
    changed,
    straddler_pattern: straddlerPattern,
  };
}

/** D-09: the audit-row ids a census failure names (removed, changed, unexpectedly added) — what a disposition must acknowledge. */
export function censusDeltaIds(census) {
  return sortedUnique([
    ...(census?.removed ?? []).map((r) => r.id),
    ...(census?.changed ?? []).map((r) => r.id),
    ...(census?.unexpected_added ?? []).map((r) => r.id),
  ]);
}

// ---------------------------------------------------------------------------
// H9 — what happened to M217.
// ---------------------------------------------------------------------------

/**
 * D-02 — everything beyond "absent from the catalog" that a NON-COMMIT proof
 * needs before any §2.6 failure restore. Returns the list of what is NOT
 * proven (empty = proven):
 *   - the executor's terminal state, once READY_FOR_M217 exists
 *     (`requireExecutor`): a terminal NON-success conclusion; success, a
 *     missing input or a malformed one is unproven;
 *   - no in-flight M217: no other backend (or prepared transaction) holding
 *     or awaiting a ShareLock-or-stronger lock on either §1 relation, no open
 *     transaction running M217 text, and no session hidden from the runner;
 *   - pre-C5 behaviour: every FINGERPRINT_SIGNATURES body fingerprint equals
 *     its sealed T0 value exactly;
 *   - history: the row count is still the attested count.
 */
export function assessNonCommitProof(nonCommit) {
  const unproven = [];
  if (!nonCommit || typeof nonCommit !== 'object') return ['the non-commit proof inputs were not supplied'];
  if (nonCommit.requireExecutor === true) {
    let ex = null;
    try { ex = assertExecutorRun(nonCommit.executor); } catch { ex = undefined; }
    if (ex === undefined) unproven.push('the executor terminal state is malformed');
    else if (ex === null) unproven.push('the executor terminal state was not supplied (run id + conclusion)');
    else if (!EXECUTOR_NON_COMMIT_CONCLUSIONS.includes(ex.conclusion)) unproven.push(`the executor reports ${ex.conclusion}, not a terminal non-commit state`);
  }
  const f = nonCommit.inFlight;
  if (!f || !Array.isArray(f.locks) || !Array.isArray(f.sessions) || !Array.isArray(f.hidden)) {
    unproven.push('the in-flight M217 check could not be read');
  } else {
    if (f.locks.length > 0) unproven.push(`${f.locks.length} lock(s) on the §1 relations are held or awaited by another backend`);
    if (f.sessions.length > 0) unproven.push(`${f.sessions.length} open transaction(s) are running M217 text`);
    if (f.hidden.length > 0) unproven.push(`${f.hidden.length} session(s) are hidden from the runner`);
  }
  const t0 = nonCommit.t0Fingerprints;
  const now = nonCommit.fingerprints;
  if (!t0 || typeof t0 !== 'object') unproven.push('no T0 body fingerprint was sealed');
  else if (!now || typeof now !== 'object') unproven.push('the current body fingerprints could not be read');
  else {
    for (const sig of FINGERPRINT_SIGNATURES) {
      if (typeof t0[sig] !== 'string' || !/^[0-9a-f]{32}$/.test(t0[sig])) unproven.push(`no T0 fingerprint for ${sig}`);
      else if (now[sig] !== t0[sig]) unproven.push(`${sig} is not the T0 body (fingerprint ${now[sig] ?? 'absent'})`);
    }
  }
  if (!Number.isInteger(nonCommit.attestedRowCount) || nonCommit.historyRowCount !== nonCommit.attestedRowCount) {
    unproven.push(`the history carries ${nonCommit.historyRowCount ?? 'an unread number of'} rows, attested ${nonCommit.attestedRowCount ?? '(none)'}`);
  }
  return unproven;
}

/**
 * Classify the executor's M217 outcome from catalog + history facts.
 *
 *   APPLIED        history row present (exact version + name) AND every M217
 *                  object present AND every replaced body is the C5 body;
 *   FAILED_CLEAN   history row absent AND every M217 object absent AND every
 *                  replaced body (approve included) is still pre-C5 AND the
 *                  D-02 non-commit proof (`nonCommit`, see
 *                  assessNonCommitProof) holds in full;
 *   FAILED_PARTIAL anything in between (including a replaced function that
 *                  no longer exists at all, `bodies[fn] === null`);
 *   UNKNOWN        a fact could not be read, or M217 is absent from the
 *                  catalog but its non-commit is not PROVEN (`unproven`).
 *
 * Only FAILED_CLEAN permits the §2.6 failure restore; FAILED_PARTIAL and
 * UNKNOWN keep the freeze and restore nothing (HOLD).
 */
export function classifyM217Outcome({ historyReadable, historyRowPresent, objects, bodies, nonCommit } = {}) {
  const objectKeys = Object.keys(M217_OBJECTS);
  if (historyReadable !== true || !objects || !bodies
    || objectKeys.some((k) => typeof objects[k] !== 'boolean')
    || M217_BODY_MARKERS.some((m) => typeof bodies[m.fn] !== 'boolean' && bodies[m.fn] !== null)
    || typeof historyRowPresent !== 'boolean') {
    return { outcome: M217_OUTCOMES.UNKNOWN, reason: 'a history or catalog fact could not be read' };
  }
  const missingBodies = M217_BODY_MARKERS.filter((m) => bodies[m.fn] === null).map((m) => m.fn);
  if (missingBodies.length > 0) {
    return { outcome: M217_OUTCOMES.FAILED_PARTIAL, reason: 'a function M217 replaces no longer exists', missing_functions: missingBodies };
  }
  const present = objectKeys.filter((k) => objects[k]);
  const c5Bodies = M217_BODY_MARKERS.filter((m) => bodies[m.fn]).map((m) => m.fn);
  if (historyRowPresent && present.length === objectKeys.length && c5Bodies.length === M217_BODY_MARKERS.length) {
    return { outcome: M217_OUTCOMES.APPLIED, objects_present: present, c5_bodies: c5Bodies };
  }
  if (!historyRowPresent && present.length === 0 && c5Bodies.length === 0) {
    const unproven = assessNonCommitProof(nonCommit);
    if (unproven.length > 0) {
      return { outcome: M217_OUTCOMES.UNKNOWN, reason: 'M217 is absent from the catalog but its non-commit is not proven', unproven };
    }
    return { outcome: M217_OUTCOMES.FAILED_CLEAN, objects_present: [], c5_bodies: [], non_commit_proven: true };
  }
  return {
    outcome: M217_OUTCOMES.FAILED_PARTIAL,
    history_row_present: historyRowPresent,
    objects_present: present,
    objects_absent: objectKeys.filter((k) => !objects[k]),
    c5_bodies: c5Bodies,
  };
}

// ---------------------------------------------------------------------------
// H10 — post-apply verification.
// ---------------------------------------------------------------------------

/**
 * Every §21.11 / H10 invariant, collected rather than first-failure so the
 * sealed evidence names all of them. PASS only if the list is empty; any
 * failure keeps submit/approve frozen and restores nothing.
 */
export function evaluatePostApply(inputs = {}) {
  const f = [];
  const add = (code, detail) => f.push({ code, detail });

  // canonical M217 identity (fresh version + name, reconciled to 217)
  try {
    assertPostApplyAcceptance({
      remoteRows: inputs.remoteRows,
      localMigrations: inputs.localMigrations,
      expectedCeiling: EXPECTED_NEXT_CEILING,
      expectedRemoteVersion: inputs.attestation?.m217?.remote_history_version,
      expectedName: M217_HISTORY_NAME,
      expectedRowCount: Number.isInteger(inputs.attestation?.remote_row_count) ? inputs.attestation.remote_row_count + 1 : undefined,
    });
  } catch (e) {
    if (e instanceof MigrationHistoryRefusal) add('POST_APPLY_HISTORY_IDENTITY', `[${e.code}] ${e.message}`);
    else throw e;
  }
  const row216 = (inputs.remoteRows ?? []).filter((r) => String(r.version) === inputs.attestation?.m216?.fresh_version);
  if (row216.length !== 1 || row216[0].name !== inputs.attestation?.m216?.fresh_name) {
    add('POST_APPLY_M216_ROW_MOVED', 'the attested M216 row is no longer present exactly once with its attested name');
  }
  if (inputs.localM217Sha256 !== inputs.attestation?.m217?.executor_sha256) {
    add('POST_APPLY_M217_BYTES_CHANGED', 'the local M217 bytes no longer hash to the pinned executor SHA-256');
  }

  // exact overloads
  for (const name of EXACT_OVERLOAD_NAMES) {
    if ((inputs.overloads ?? {})[name] !== 1) add('POST_APPLY_OVERLOAD_MISMATCH', `${name} has ${(inputs.overloads ?? {})[name] ?? 0} overloads, expected exactly 1`);
  }

  // classifier / helper / fence function attributes and grants
  const cls = inputs.classifier;
  if (!cls || cls.volatile !== 'i' || cls.secdef !== false || cls.strict !== false || cls.search_path_pinned !== true
    || cls.returns !== 'text' || cls.authenticated !== true || cls.service_role !== true || cls.anon !== false || cls.public_entry !== false) {
    add('POST_APPLY_CLASSIFIER_CONTRACT', cls ?? 'classifier missing');
  }
  const helper = inputs.lineageHelper;
  if (!helper || helper.volatile !== 's' || helper.secdef !== true || helper.search_path_pinned !== true || helper.returns !== 'text'
    || helper.authenticated !== false || helper.service_role !== false || helper.anon !== false || helper.public_entry !== false) {
    add('POST_APPLY_LINEAGE_HELPER_CONTRACT', helper ?? 'lineage helper missing');
  }
  const fence = inputs.fenceFunction;
  if (!fence || fence.secdef !== true || fence.search_path_pinned !== true || fence.returns !== 'trigger'
    || fence.authenticated !== false || fence.service_role !== false || fence.anon !== false || fence.public_entry !== false) {
    add('POST_APPLY_FENCE_FUNCTION_CONTRACT', fence ?? 'fence function missing');
  }
  // BEFORE (2) | ROW (1) | INSERT (4) | UPDATE (16) = 23; no column list; enabled
  const trg = inputs.fenceTrigger;
  if (!trg || trg.type !== 23 || trg.column_list !== '' || trg.enabled !== 'O' || trg.function !== M217_OBJECTS.fenceFunction) {
    add('POST_APPLY_FENCE_MISSING', trg ?? 'fence trigger missing');
  }
  const chk = inputs.valueContract;
  if (!chk || chk.type !== 'c' || chk.validated !== false) add('POST_APPLY_VALUE_CONTRACT', chk ?? 'NOT VALID source CHECK missing');
  for (const code of C5_BLOCKER_CODES) {
    if ((inputs.blockerVocabulary ?? {})[code] !== true) add('POST_APPLY_BLOCKER_VOCABULARY', `${code} absent from the readiness blockers`);
  }
  for (const m of M217_BODY_MARKERS) {
    if ((inputs.bodies ?? {})[m.fn] !== true) add('POST_APPLY_BODY_NOT_C5', m.fn);
  }

  // zero submitted, zero pre-F0, zero prepared, zero hidden
  if (!Array.isArray(inputs.submittedIds) || inputs.submittedIds.length !== 0) add('POST_APPLY_SUBMITTED_PRESENT', inputs.submittedIds ?? 'unread');
  if (!inputs.drain || !inputs.drain.pass) add('POST_APPLY_DRAIN_NOT_ZERO', inputs.drain ?? 'unread');

  // governed resolution still holds
  if (!inputs.resolution || !inputs.resolution.pass) add('POST_APPLY_RESOLUTION_REGRESSED', inputs.resolution?.failures ?? 'unread');

  // Proof A, Proof B, the H11 census
  if (!inputs.proofA || !inputs.proofA.pass) add('POST_APPLY_PROOF_A_DELTA', inputs.proofA?.deltas ?? 'unread');
  if (!inputs.proofB || !inputs.proofB.pass) add('POST_APPLY_PROOF_B_UNMATCHED', inputs.proofB ?? 'unread');
  if (!inputs.census || !inputs.census.pass) add('POST_APPLY_LIFECYCLE_AUDIT_DELTA', inputs.census ?? 'unread');

  // no unexpected lifecycle writer
  const writers = inputs.lifecycleWriters ?? null;
  if (!writers) add('POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER', 'unread');
  else {
    const updaters = sortedUnique(writers.filter((w) => w.updates_status).map((w) => w.fn));
    const inserters = sortedUnique(writers.filter((w) => w.inserts_revision).map((w) => w.fn));
    if (!sameList(updaters, [...EXPECTED_STATUS_WRITERS].sort())) add('POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER', { status_writers: updaters });
    if (!sameList(inserters, [...EXPECTED_REVISION_INSERTERS].sort())) add('POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER', { revision_inserters: inserters });
  }

  // frozen ACL unchanged across M217 (M217 is ACL-neutral), reject untouched
  if (!aclSetsEqual(inputs.frozenAcl, inputs.aclNow)) add('POST_APPLY_ACL_FROZEN_CHANGED', aclSetDifference(inputs.aclNow, inputs.frozenAcl));
  if (!aclSetsEqual(inputs.rejectAcl0, inputs.rejectAclNow)) add('POST_APPLY_REJECT_ACL_CHANGED', aclSetDifference(inputs.rejectAclNow, inputs.rejectAcl0));

  return { pass: f.length === 0, failures: f };
}

/**
 * H13 / §12 post-apply DRAFT audit. These are DRAFT-workflow findings: an
 * affected DRAFT stays on HOLD until governed repin/review (the readiness
 * blockers enforce that from M217 on). They are sealed with the activation
 * evidence but do not gate the ACL restore.
 */
export function summarizeDraftAudit({ chronology, pins, lineage, invalidEvidence } = {}) {
  const requiredPins = (pins ?? []).filter((p) => p.required_pin === true);
  return {
    chronology_ambiguity: (chronology ?? []).length,
    non_head_pins: (pins ?? []).length,
    unsafe_required_pins: requiredPins.length,
    unsafe_lineage_links: (lineage ?? []).length,
    invalid_source_evidence: (invalidEvidence ?? []).length,
    draft_workflow_holds: sortedUnique([
      ...(chronology ?? []).map((c) => c.plan_revision_id),
      ...requiredPins.map((p) => p.plan_revision_id),
      ...(lineage ?? []).map((l) => l.plan_revision_id),
      ...(invalidEvidence ?? []).map((i) => i.plan_revision_id),
    ]),
  };
}

/**
 * §21.8 — the read-only activation preconditions immediately before the
 * executor is dispatched, all collected: zero submitted, M217 PROVEN absent
 * (catalog + T0 body fingerprints + no in-flight M217), the ACL still exactly
 * the sealed frozen ACL, and — so a violation surfaces as a STOP BEFORE M217
 * (restorable, retryable) rather than as a post-apply HOLD with M217 already
 * committed — Proof A, Proof B and the H11 census as they stand now (D-10).
 */
export function assessReadyForM217({ submittedIds, m217, aclStillFrozen, proofA, proofB, census } = {}) {
  const failures = [];
  if (!Array.isArray(submittedIds) || submittedIds.length !== 0) failures.push({ code: 'READY_SUBMITTED_PRESENT', detail: submittedIds ?? 'unread' });
  if (m217?.outcome !== M217_OUTCOMES.FAILED_CLEAN) failures.push({ code: 'READY_M217_NOT_PROVEN_ABSENT', detail: m217 ?? 'unread' });
  if (aclStillFrozen !== true) failures.push({ code: 'READY_ACL_NOT_FROZEN' });
  if (!proofA || proofA.pass !== true) failures.push({ code: 'READY_PROOF_A_DELTA', detail: proofA?.deltas ?? 'unread' });
  if (!proofB || proofB.pass !== true) failures.push({ code: 'READY_PROOF_B_NOT_EMPTY', detail: proofB ?? 'unread' });
  if (!census || census.pass !== true) failures.push({ code: 'READY_LIFECYCLE_AUDIT_DELTA', detail: census ?? 'unread' });
  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Steps, attempts and the H3 ledger.
// ---------------------------------------------------------------------------

/** Refuse anything but the next step in ACTIVATION_STEPS. */
export function assertStepInOrder(completed, step) {
  const done = completed ?? [];
  const expected = ACTIVATION_STEPS[done.length];
  if (!sameList(done, ACTIVATION_STEPS.slice(0, done.length))) {
    refuse('STEP_OUT_OF_ORDER', `The attempt's completed steps [${done.join(', ')}] are not a prefix of the activation order.`);
  }
  if (step !== expected) {
    refuse('STEP_OUT_OF_ORDER', `Step ${step} cannot run now; the next step is ${expected ?? '(none — the attempt is complete)'}.`);
  }
  return true;
}

export function assertAttemptOpen(state) {
  if (state?.conclusion) {
    refuse('ATTEMPT_ALREADY_CONCLUDED', `Attempt ${state.attempt_id} already concluded ${state.conclusion.outcome}; start a new attempt that dispositions it.`);
  }
  return true;
}

/**
 * A STOP (§2.4 / H3) exists only once T0 is sealed and until M217's outcome is
 * classified; after that the post-apply branch decides. (Before T0 an attempt
 * is simply abandoned: nothing was frozen and there is no T0/A0 to account for.)
 * Being allowed to STOP is not being allowed to restore: the runbook restores
 * ACL0 on a STOP only when classifyM217Outcome PROVES non-commit (D-01), and a
 * STOP at/after READY_FOR_M217 that finds M217 (partly) present is refused and
 * routed to post-apply.
 */
export function assertCanStop(state) {
  assertAttemptOpen(state);
  const done = state?.completed ?? [];
  if (!done.includes('T0_SNAPSHOT_SEALED')) refuse('STOP_BEFORE_T0', 'No T0 is sealed yet; there is nothing to stop.');
  if (done.includes('M217_OUTCOME_CLASSIFIED')) refuse('STOP_AFTER_M217', 'M217 has been classified; the post-apply branch decides, not STOP.');
  return true;
}


// ---------------------------------------------------------------------------
// D-03 / D-09 — the ACL ledger: what each attempt leaves behind, and what the
// next T0 may capture.
// ---------------------------------------------------------------------------

const LEDGER_KINDS = Object.freeze({ NONE: 'NONE', NOT_FROZEN: 'NOT_FROZEN', FROZEN: 'FROZEN', UNCERTAIN: 'UNCERTAIN' });
export { LEDGER_KINDS };

/**
 * The true pre-freeze ACL0 an attempt carries in the ledger — its
 * restoration target. An attempt whose T0 gate refused carries the ledger's
 * known ACL0 forward unchanged (never the ACL it happened to capture).
 */
export function attemptAcl0Target(p) {
  if (Array.isArray(p?.restoration_target_acl0)) return p.restoration_target_acl0;
  const ex = p?.ledger_expectation;
  if (ex && ex.kind && ex.kind !== LEDGER_KINDS.NONE && Array.isArray(ex.acl0)) return ex.acl0;
  if (Array.isArray(p?.inherited?.acl0)) return p.inherited.acl0;
  return Array.isArray(p?.acl0) ? p.acl0 : null;
}

/** The frozen set an attempt carries in the ledger (sealed, planned, or the ledger's own). */
export function attemptFrozenSet(p) {
  if (Array.isArray(p?.frozen_acl)) return p.frozen_acl;
  if (Array.isArray(p?.freeze_planned)) return p.freeze_planned;
  const ex = p?.ledger_expectation;
  if (ex && ex.kind && ex.kind !== LEDGER_KINDS.NONE && Array.isArray(ex.frozen)) return ex.frozen;
  const target = attemptAcl0Target(p);
  return target ? planFrozenAcl(target) : null;
}

/**
 * The ACL state the ledger says the database is in now: decided by the LAST
 * prior attempt that took a T0 (each attempt's own T0 was gated against the
 * one before it, so the chain is consistent).
 *   NONE        no prior attempt ever took a T0;
 *   NOT_FROZEN  its conclusion recorded freeze_in_place === false (or PASS);
 *   FROZEN      freeze_in_place === true;
 *   UNCERTAIN   anything else ('UNKNOWN', a legacy string, missing).
 */
export function ledgerAclExpectation(priorAttempts = []) {
  const withT0 = (priorAttempts ?? []).filter((p) => p && p.t0);
  if (withT0.length === 0) return { kind: LEDGER_KINDS.NONE, from: null, acl0: null, frozen: null, freeze_in_place: null };
  const last = withT0[withT0.length - 1];
  const fip = last.conclusion?.outcome === C5_ACTIVATION_PASS ? false : last.conclusion?.freeze_in_place;
  const kind = fip === false ? LEDGER_KINDS.NOT_FROZEN : fip === true ? LEDGER_KINDS.FROZEN : LEDGER_KINDS.UNCERTAIN;
  return { kind, from: last.attempt_id, acl0: attemptAcl0Target(last), frozen: attemptFrozenSet(last), freeze_in_place: fip ?? null };
}

/**
 * H3 — no laundering through a fresh T0. Every prior attempt that did not
 * PASS must carry an Owner disposition naming it, and that disposition must
 * acknowledge EXACTLY
 *   - the Proof A / Proof B revision deltas (`acknowledged_delta_ids`), and
 *   - the H11 lifecycle-audit census deltas (`acknowledged_audit_ids`: every
 *     removed, edited or unexpectedly added audit row, D-09)
 * measured now against the prior attempt's OWN T0/A0/L0. A prior attempt
 * still in progress blocks a new one.
 *
 * D-03: whatever the last T0 attempt left behind that is not a proven
 * NOT_FROZEN state (a kept freeze, or an uncertain one) must be resolved
 * explicitly by ITS disposition — `carry_forward_acl0: true` (its ACL0, not
 * today's frozen ACL, becomes the restoration target) or, after an Owner
 * repair, `acl_rebaseline: true` (the ACL captured at the next T0, which must
 * not be the frozen set, becomes ACL0).
 *
 * @param {{priorAttempts:object[], dispositions:object[], priorDeltas:Map<string,string[]>|object,
 *          priorAuditDeltas?:Map<string,string[]>|object}} args
 */
export function assertPriorAttemptsDispositioned({ priorAttempts = [], dispositions = [], priorDeltas = {}, priorAuditDeltas = {} } = {}) {
  const from = (m, id) => sortedUnique((m instanceof Map ? m.get(id) : m?.[id]) ?? []);
  const byId = new Map((dispositions ?? []).map((d) => [String(d.attempt_id), d]));
  const dispositioned = [];
  for (const p of priorAttempts) {
    if (p.manifest_ok !== true) refuse('PRIOR_ATTEMPT_EVIDENCE_TAMPERED', `Prior attempt ${p.attempt_id}'s sealed evidence no longer matches its manifest.`);
    if (!p.conclusion) {
      refuse('PRIOR_ATTEMPT_UNCONCLUDED', `Prior attempt ${p.attempt_id} never concluded; STOP it (restoring its ACL0) before a new T0.`);
    }
    if (p.conclusion.outcome === C5_ACTIVATION_PASS) continue;
    if (p.conclusion.outcome === REFUSED_BEFORE_T0 && !p.t0) continue;
    const d = byId.get(String(p.attempt_id));
    if (!d || typeof d.owner_reference !== 'string' || d.owner_reference.trim() === '' || typeof d.decision !== 'string' || d.decision.trim() === '') {
      refuse('PRIOR_ATTEMPT_UNDISPOSITIONED',
        `Prior attempt ${p.attempt_id} (${p.conclusion.outcome}) has no recorded Owner disposition (decision + owner_reference).`);
    }
    const expected = from(priorDeltas, p.attempt_id);
    const acked = sortedUnique(d.acknowledged_delta_ids ?? []);
    if (!sameList(expected, acked)) {
      refuse('PRIOR_ATTEMPT_DELTA_UNDISPOSITIONED',
        `Prior attempt ${p.attempt_id}: deltas measured against its own T0/A0 are [${expected.join(', ')}], ` +
          `the disposition acknowledges [${acked.join(', ')}].`);
    }
    const expectedAudit = from(priorAuditDeltas, p.attempt_id);
    const ackedAudit = sortedUnique(d.acknowledged_audit_ids ?? []);
    if (!sameList(expectedAudit, ackedAudit)) {
      refuse('PRIOR_ATTEMPT_AUDIT_DELTA_UNDISPOSITIONED',
        `Prior attempt ${p.attempt_id}: lifecycle-audit census deltas measured against its own L0 are [${expectedAudit.join(', ')}], ` +
          `the disposition acknowledges [${ackedAudit.join(', ')}].`);
    }
    dispositioned.push(p.attempt_id);
  }

  const expectation = ledgerAclExpectation(priorAttempts);
  let carryForward = false;
  let rebaseline = false;
  if (expectation.kind !== LEDGER_KINDS.NONE) {
    const d = byId.get(String(expectation.from));
    const unresolved = expectation.kind === LEDGER_KINDS.FROZEN || expectation.kind === LEDGER_KINDS.UNCERTAIN;
    carryForward = unresolved && d?.carry_forward_acl0 === true;
    rebaseline = d?.acl_rebaseline === true;
    if (carryForward && rebaseline) {
      refuse('PRIOR_ATTEMPT_DISPOSITION_CONFLICT', `The disposition of ${expectation.from} both carries its ACL0 forward and rebaselines it.`);
    }
    if (unresolved && !carryForward && !rebaseline) {
      refuse('PRIOR_ATTEMPT_FREEZE_UNRESOLVED',
        `Prior attempt ${expectation.from} left submit/approve ${expectation.kind === LEDGER_KINDS.FROZEN ? 'frozen' : 'in an uncertain freeze state'} ` +
          `(freeze_in_place=${JSON.stringify(expectation.freeze_in_place)}); a new T0 would capture that ACL. ` +
          'Carry its ACL0 forward explicitly (carry_forward_acl0) or, after an Owner repair, rebaseline (acl_rebaseline).');
    }
  }
  return {
    dispositioned,
    inheritedAcl0: carryForward ? expectation.acl0 : null,
    inheritedFrom: carryForward ? expectation.from : null,
    carry_forward: carryForward,
    rebaseline,
    expectation,
  };
}

/**
 * D-03 — the T0 ACL gate: a later attempt NEVER captures a frozen ACL as its
 * ACL0. The captured ACL must be a KNOWN ledger state:
 *   NONE        a first attempt: it becomes ACL0;
 *   NOT_FROZEN  it must equal the ledger's ACL0 (the frozen set is refused;
 *               anything else needs an Owner `acl_rebaseline`);
 *   FROZEN / UNCERTAIN
 *               the frozen set is accepted only with `carry_forward_acl0`
 *               and then the LEDGER's ACL0 is the restoration target; the
 *               ledger's ACL0 itself is accepted as-is; anything else needs
 *               an Owner `acl_rebaseline` or is PRIOR_FROZEN_ACL_CHANGED.
 * Whatever the basis, the restoration target must let `authenticated`
 * execute submit and approve (D-09), or it is refused as a frozen-looking ACL0.
 */
export function assessT0Acl({ capturedAcl, expectation, carryForward = false, rebaseline = false } = {}) {
  const ex = expectation ?? { kind: LEDGER_KINDS.NONE };
  const captured = (capturedAcl ?? []).map(normalizeAclTuple);
  const eq = (x) => Array.isArray(x) && aclSetsEqual(captured, x);
  let result;
  if (ex.kind === LEDGER_KINDS.NONE) {
    result = { basis: 'fresh', target_acl0: captured, inherited_from: null };
  } else if (ex.kind === LEDGER_KINDS.NOT_FROZEN) {
    if (eq(ex.acl0)) result = { basis: 'ledger_acl0', target_acl0: captured, inherited_from: null };
    else if (eq(ex.frozen)) {
      refuse('ACL0_IS_FROZEN_SET',
        `The ACL captured at this T0 is the frozen set of ${ex.from}, whose conclusion recorded no freeze in place; a frozen ACL is never captured as ACL0.`,
        { hold: true });
    } else if (rebaseline) result = { basis: 'rebaseline', target_acl0: captured, inherited_from: null };
    else {
      refuse('ACL0_NOT_IN_LEDGER',
        `The ACL captured at this T0 is neither ${ex.from}'s ACL0 nor its frozen set; an Owner disposition with acl_rebaseline is required.`,
        { hold: true });
    }
  } else {
    if (eq(ex.frozen)) {
      if (!carryForward) {
        refuse('PRIOR_ATTEMPT_FREEZE_UNRESOLVED',
          `The ACL captured at this T0 is ${ex.from}'s frozen set; only a carried-forward ACL0 may restore it.`, { hold: true });
      }
      result = { basis: 'carried_forward', target_acl0: ex.acl0, inherited_from: ex.from };
    } else if (eq(ex.acl0)) result = { basis: 'ledger_acl0', target_acl0: captured, inherited_from: null };
    else if (rebaseline) result = { basis: 'rebaseline', target_acl0: captured, inherited_from: null };
    else {
      refuse('PRIOR_FROZEN_ACL_CHANGED',
        `The ACL captured at this T0 is neither ${ex.from}'s sealed frozen set nor its ACL0.`, { hold: true });
    }
  }
  if (!Array.isArray(result.target_acl0) || !aclGrantsClientExecute(result.target_acl0)) {
    refuse('ACL0_LACKS_CLIENT_EXECUTE',
      'The restoration target ACL0 does not let authenticated execute submit and approve; it looks frozen and is never captured or carried as ACL0.',
      { hold: true });
  }
  return result;
}

/**
 * When an ACL0 is inherited from a prior attempt that kept the freeze, the
 * captured "ACL0" of this attempt must be that attempt's sealed frozen ACL —
 * otherwise something changed the ACL while it was supposed to be frozen.
 */
export function assertInheritedFreezeIntact({ capturedAcl0, priorFrozenAcl }) {
  if (!aclSetsEqual(capturedAcl0, priorFrozenAcl)) {
    refuse('PRIOR_FROZEN_ACL_CHANGED', 'The ACL captured at this T0 is not the prior attempt\'s sealed frozen ACL.', { hold: true });
  }
  return true;
}

const stableJson = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stableJson).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`);

/**
 * D-09 — the canonical text the ledger digest is the SHA-256 of: the database
 * identity, then one line per prior attempt, in sequence order,
 * `<attempt_id> <sha256 of its SHA256SUMS.txt>`.
 */
export function ledgerDigestInput({ database, priorEntries = [] } = {}) {
  return `c5-activation-ledger v1\ndatabase ${stableJson(database ?? null)}\n${priorEntries
    .map((e) => `${e.attempt_id} ${e.manifest_sha256 ?? 'MANIFEST_UNREADABLE'}\n`).join('')}`;
}

/**
 * D-09 — the ledger is bound to ONE database and ONE evidence root: every
 * prior attempt must carry the same database identity and the same
 * evidence-root hash as this one. The Owner-recorded anchor (the expected
 * prior-attempt count and ledger digest from the release record) is REQUIRED
 * for Production — it is what makes a retry from a fresh, empty evidence
 * directory visible — and, when given for a rehearsal, must match too.
 *
 * @param {{target:string, priorAttempts:object[], anchor:{database:object, evidence_root_sha256:string},
 *          ledger:{prior_attempts:number, ledger_sha256:string},
 *          expected?:{prior_attempts?:number|string|null, ledger_sha256?:string|null}}} args
 */
export function assertLedgerAnchor({ target = 'rehearsal', priorAttempts = [], anchor, ledger, expected = {} } = {}) {
  if (!anchor || !anchor.database || typeof anchor.database.database !== 'string'
    || typeof anchor.evidence_root_sha256 !== 'string' || !SHA256_PATTERN.test(anchor.evidence_root_sha256)) {
    refuse('LEDGER_ANCHOR_MISSING', 'The database identity and the evidence-root hash of this attempt were not read.');
  }
  for (const p of priorAttempts ?? []) {
    if (!p.ledger_anchor) {
      if (p.t0) refuse('LEDGER_ANCHOR_MISSING', `Prior attempt ${p.attempt_id} took a T0 but carries no ledger anchor.`);
      continue;
    }
    if (stableJson(p.ledger_anchor.database) !== stableJson(anchor.database)) {
      refuse('LEDGER_DATABASE_MISMATCH', `Prior attempt ${p.attempt_id} was taken against a different database; one ledger binds exactly one database.`);
    }
    if (p.ledger_anchor.evidence_root_sha256 !== anchor.evidence_root_sha256) {
      refuse('LEDGER_ROOT_MISMATCH', `Prior attempt ${p.attempt_id} was sealed under a different evidence root; one ledger lives in exactly one root.`);
    }
  }
  const exp = expected ?? {};
  const hasCount = exp.prior_attempts !== undefined && exp.prior_attempts !== null && String(exp.prior_attempts) !== '';
  const hasDigest = exp.ledger_sha256 !== undefined && exp.ledger_sha256 !== null && String(exp.ledger_sha256) !== '';
  if (target === 'production' && (!hasCount || !hasDigest)) {
    refuse('LEDGER_ANCHOR_REQUIRED',
      'Production requires the Owner-recorded ledger anchor (expected prior-attempt count and ledger SHA-256 from the release record).');
  }
  if (hasCount && (!/^\d+$/.test(String(exp.prior_attempts)) || Number(exp.prior_attempts) !== ledger?.prior_attempts)) {
    refuse('LEDGER_ANCHOR_MISMATCH', `The evidence root holds ${ledger?.prior_attempts} prior attempt(s); the Owner anchor expects ${exp.prior_attempts}.`);
  }
  if (hasDigest && String(exp.ledger_sha256).toLowerCase() !== ledger?.ledger_sha256) {
    refuse('LEDGER_ANCHOR_MISMATCH', 'The ledger digest of this evidence root is not the Owner-recorded ledger SHA-256.');
  }
  return { ...ledger, owner_anchored: hasCount && hasDigest };
}
