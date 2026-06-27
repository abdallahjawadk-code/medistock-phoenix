/**
 * MediStock Phoenix — Full Wipe + Rebuild Execution Script
 *
 * Usage:  node phoenix-wipe-execute.cjs
 * Reads:  .env.local (PHOENIX_DATABASE_URL, FULL_PUBLIC_APP_WIPE_APPROVED)
 * Does:   inspect → wipe → migrations 001-004 → verify
 *
 * NEVER run npm audit fix --force.
 * NEVER commit .env.local.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// ─── paths ───────────────────────────────────────────────────────────────────
const PHOENIX_DIR = __dirname;

function resolve(...parts) {
  return path.join(PHOENIX_DIR, ...parts);
}

const SQL_FILES = {
  inspect:  resolve('supabase/full_wipe_tools/inspect_public_before_wipe.sql'),
  wipe:     resolve('supabase/full_wipe_tools/000_full_public_app_wipe.sql'),
  m001:     resolve('supabase/migrations/001_phoenix_core_schema.sql'),
  m002:     resolve('supabase/migrations/002_phoenix_rls_policies.sql'),
  m003:     resolve('supabase/migrations/003_phoenix_rpc_lifecycle.sql'),
  m004:     resolve('supabase/migrations/004_phoenix_seed_demo_data.sql'),
  verify:   resolve('supabase/full_wipe_tools/verify_phoenix_after_full_wipe.sql'),
};

// ─── env parsing ─────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = resolve('.env.local');
  if (!fs.existsSync(envPath)) {
    abort('STOP: .env.local not found at ' + envPath);
  }
  const raw = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

// ─── DB URL parser (handles @ in password) ───────────────────────────────────
function parseDbUrl(rawUrl) {
  if (!rawUrl) abort('STOP: PHOENIX_DATABASE_URL is empty in .env.local');
  const withoutScheme = rawUrl.replace(/^postgresql:\/\/|^postgres:\/\//, '');
  const lastAt = withoutScheme.lastIndexOf('@');
  if (lastAt === -1) abort('STOP: DB URL has no @ separator');

  const authPart = withoutScheme.slice(0, lastAt);
  const afterAt  = withoutScheme.slice(lastAt + 1);

  const colonIdx = authPart.indexOf(':');
  const user     = authPart.slice(0, colonIdx);
  const password = authPart.slice(colonIdx + 1);

  const slashIdx = afterAt.indexOf('/');
  const hostPort = afterAt.slice(0, slashIdx);
  const database = afterAt.slice(slashIdx + 1) || 'postgres';
  const hpColon  = hostPort.lastIndexOf(':');
  const host     = hpColon === -1 ? hostPort : hostPort.slice(0, hpColon);
  const port     = hpColon === -1 ? 5432 : (parseInt(hostPort.slice(hpColon + 1), 10) || 5432);

  return { user, password, host, port, database };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function abort(msg) {
  console.error('\n' + msg + '\n');
  process.exit(1);
}

function log(msg) {
  console.log(msg);
}

function separator(title) {
  log('\n' + '='.repeat(60));
  log('  ' + title);
  log('='.repeat(60));
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  separator('MediStock Phoenix — Wipe + Rebuild Executor');

  // 1. Load env
  log('[1/8] Reading .env.local ...');
  const env = loadEnv();

  // 2. Verify approval gate
  log('[2/8] Checking approval gate ...');
  const approved = env['FULL_PUBLIC_APP_WIPE_APPROVED'];
  if (approved !== 'yes') {
    abort(
      'STOP: FULL_PUBLIC_APP_WIPE_APPROVED is not "yes".\n' +
      '      Current value: "' + (approved || '') + '"\n' +
      '      Set it to exactly: yes\n' +
      '      Then re-run this script.'
    );
  }
  log('  OK Approval gate: yes');

  // 3. Verify project ref
  const ref = env['PHOENIX_SUPABASE_PROJECT_REF'];
  log('[3/8] Target project ref: ' + (ref || '(missing)'));
  if (ref !== 'eyrzxgfkvqybjdgyphap') {
    abort('STOP: Project ref mismatch. Expected eyrzxgfkvqybjdgyphap, got: ' + ref);
  }
  log('  OK Project ref matches');

  // 4. Parse DB URL (never log password)
  log('[4/8] Parsing DB connection (password masked) ...');
  const dbUrl = env['PHOENIX_DATABASE_URL'];
  const connOpts = parseDbUrl(dbUrl);
  log('  OK host: ' + connOpts.host);
  log('  OK port: ' + connOpts.port);
  log('  OK user: ' + connOpts.user);
  log('  OK db:   ' + connOpts.database);
  log('  OK pass: [MASKED]');

  // 5. Verify SQL files exist
  log('[5/8] Verifying SQL files ...');
  for (const [key, filePath] of Object.entries(SQL_FILES)) {
    if (!fs.existsSync(filePath)) {
      abort('STOP: SQL file missing: ' + filePath);
    }
    log('  OK ' + key + ': ' + path.basename(filePath));
  }

  // 6. Connect
  log('[6/8] Connecting to Supabase PostgreSQL ...');
  const client = new Client({
    host:     connOpts.host,
    port:     connOpts.port,
    user:     connOpts.user,
    password: connOpts.password,
    database: connOpts.database,
    ssl:      { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
  });

  try {
    await client.connect();
    log('  OK Connected');
    const dbResult = await client.query('select current_database()');
    const dbName = dbResult.rows[0].current_database;
    log('  OK current_database(): ' + dbName);
    if (dbName !== 'postgres') {
      abort('STOP: Wrong database. Expected "postgres", got "' + dbName + '"');
    }
  } catch (err) {
    abort('STOP: Connection failed: ' + err.message);
  }

  // 7. Execute SQL files in order
  separator('Phase 9 Execution — SQL in Order');

  const steps = [
    { key: 'inspect', label: 'Step 1/6: Pre-wipe inventory (inspect_public_before_wipe.sql)', destructive: false },
    { key: 'wipe',    label: 'Step 2/6: FULL WIPE — DROP + RECREATE public schema',           destructive: true  },
    { key: 'm001',    label: 'Step 3/6: Migration 001 — core schema (10 tables)',              destructive: false },
    { key: 'm002',    label: 'Step 4/6: Migration 002 — RLS policies',                        destructive: false },
    { key: 'm003',    label: 'Step 5/6: Migration 003 — RPCs + lifecycle',                    destructive: false },
    { key: 'm004',    label: 'Step 6/6: Migration 004 — demo seed data',                      destructive: false },
  ];

  for (const step of steps) {
    separator(step.label);
    const filePath = SQL_FILES[step.key];
    const sql = fs.readFileSync(filePath, 'utf8');
    log('  File: ' + path.basename(filePath));
    log('  Size: ' + sql.length + ' chars');
    if (step.destructive) {
      log('\n  WARNING: DESTRUCTIVE STEP — executing DROP CASCADE ...\n');
    }
    try {
      await client.query(sql);
      log('  OK Completed');
    } catch (err) {
      await client.end().catch(() => {});
      abort(
        'STOP: SQL execution failed in step ' + step.key + '\n' +
        '  Error:  ' + err.message + '\n' +
        '  Code:   ' + (err.code   || 'n/a') + '\n' +
        '  Detail: ' + (err.detail || 'n/a')
      );
    }
  }

  // 8. Verify
  separator('Step 7/7: Post-wipe Verification');
  const verifySql = fs.readFileSync(SQL_FILES.verify, 'utf8');
  let verifyPassed = false;
  try {
    await client.query(verifySql);
    verifyPassed = true;
    log('  OK Verify completed');
  } catch (err) {
    if (err.message && err.message.includes('BAD_FULL_WIPE_REVIEW_REQUIRED')) {
      log('\n  FAILED: ' + err.message);
    } else {
      log('\n  Verify error: ' + err.message);
    }
  }

  await client.end().catch(() => {});

  separator('FINAL RESULT');
  if (verifyPassed) {
    log('\n  OK_FULL_WIPE_PHOENIX_READY\n');
    log('  Next step: run create_first_admin_profile.sql with your real auth user UUID.\n');
    process.exit(0);
  } else {
    log('\n  BAD_FULL_WIPE_REVIEW_REQUIRED\n');
    log('  Check the notices/errors above. Some checks failed.\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
