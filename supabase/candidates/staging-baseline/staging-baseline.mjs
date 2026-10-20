// ===========================================================================
// R1 STAGING BASELINE BUILDER (B1/B2 closure) - disposable-database tool, NOT a migration, NOT numbered, never run against Supabase here.
//
// Rebuilds the "approved state after M221" without editing any frozen historical migration and without presenting an edited file as
// original bytes:
//   * every historical file is hash-bound to the frozen manifest (M001-M221, git-blob form) BEFORE it is applied; the bytes applied are the
//     frozen bytes (the line-ending form that matches the manifest), never a patched copy;
//   * the only three departures from "apply the original file" are explicit, separately hashed, and recorded in a LEDGER:
//       M023  derived statement (VERIFY block reads with_check for INSERT policies)  - derivation 023-verify-read
//       M085  original file + a PROVEN precondition set (verify_085_preconditions.sql) + a named owner attestation; otherwise HOLD
//       M182  original file + hash-pinned OVERLAY 182b that re-states the two function bodies Production recorded
//   * M004 (demo data) is optional by decision B2 (skip004) and is never deleted after the fact.
// ===========================================================================
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { freshRigDb, MIGRATIONS_DIR as RIG_MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const toLF = (b) => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
const toCRLF = (b) => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

export class BaselineError extends Error {
  constructor(code, message, detail) { super(`${code}: ${message}`); this.code = code; this.detail = detail; }
}

/** The frozen bytes of a file: the form (as committed / LF / CRLF) whose SHA-256 equals the frozen manifest entry. */
export function frozenBytes(onDisk, frozenSha) {
  for (const [form, b] of [['as-on-disk', onDisk], ['lf', toLF(onDisk)], ['crlf', toCRLF(onDisk)]]) {
    if (sha256(b) === frozenSha) return { bytes: b, form };
  }
  return null;
}

// --- M023: the ONLY change is the three VERIFY reads (policy creation above them is untouched) -------------------------------
export const DERIVATION_023 = { id: '023-verify-read', from: /SELECT\s+qual\s+INTO/gi, to: 'SELECT coalesce(qual, with_check) INTO', expectedHits: 3 };
export function derive023(text) {
  const hits = (text.match(DERIVATION_023.from) ?? []).length;
  if (hits !== DERIVATION_023.expectedHits) throw new BaselineError('DERIVATION_DRIFT', `M023 expected ${DERIVATION_023.expectedHits} VERIFY reads, found ${hits}`);
  return text.replace(DERIVATION_023.from, DERIVATION_023.to);
}

export const OVERLAY_182B = join(HERE, '182b_production_body_overlay.sql');
export const VERIFY_085 = join(HERE, 'verify_085_preconditions.sql');
export const VERIFY_BASELINE = join(HERE, 'verify_baseline_221.sql');
export const ROLLBACK_PHASE1 = join(HERE, 'rollback_phase1_disposable.sql');

/**
 * @param {{ freeze: Array<{path:string, sha256:string}>, migrationsDir?: string, upTo?: number, skip004?: boolean, useDiskBytes?: boolean,
 *           overlay182?: boolean, attestation?: null | { ownerRef: string, evidenceSha256: string }, tamper?: Record<string,(b:Buffer)=>Buffer>,
 *           log?: (m:string)=>void }} o
 */
export async function buildBaseline(o) {
  const dir = o.migrationsDir ?? RIG_MIGRATIONS_DIR;
  const frozen = new Map(o.freeze.map((x) => [x.path.split('/').pop(), x.sha256]));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().filter((f) => parseInt(f.slice(0, 3), 10) <= (o.upTo ?? 221));
  const ledger = [];
  // 1. verify EVERYTHING against the freeze before the first statement runs
  const plan = [];
  for (const f of files) {
    const want = frozen.get(f);
    if (!want) throw new BaselineError('NOT_FROZEN', `${f} is not in the frozen manifest`);
    const disk = readFileSync(join(dir, f));
    const tampered = o.tamper?.[f] ? o.tamper[f](disk) : disk;
    const fb = frozenBytes(tampered, want);
    if (!fb) throw new BaselineError('HASH_MISMATCH', `${f} does not match the frozen SHA-256 in any line-ending form`, { file: f, frozen: want, disk: sha256(tampered) });
    plan.push({ f, original: fb.bytes, form: fb.form, diskBytes: tampered, frozenSha: want });
  }
  const missing = [...frozen.keys()].filter((f) => parseInt(f.slice(0, 3), 10) <= (o.upTo ?? 221) && !files.includes(f));
  if (missing.length) throw new BaselineError('MISSING_FROZEN_FILE', `frozen files absent: ${missing.join(', ')}`, missing);

  const c = await freshRigDb({});
  try {
    for (const p of plan) {
      const { f } = p;
      if (f.startsWith('004_') && o.skip004) { ledger.push({ file: f, action: 'NOT_APPLIED (decision B2: demo data skipped; schema-neutral, see test)', original_sha256: p.frozenSha }); continue; }
      const text = (o.useDiskBytes ? p.diskBytes : p.original).toString('utf8');
      let applied = text; let derivation = null; let extra = {};
      if (f.startsWith('023_')) { applied = derive023(text); derivation = DERIVATION_023.id; }
      if (f.startsWith('085_')) {
        const rows = (await c.query(readFileSync(VERIFY_085, 'utf8'))).rows;
        const failing = rows.filter((r) => !r.ok);
        if (failing.length) throw new BaselineError('PRECONDITION_FAILED', `M085 preconditions not proven: ${failing.map((r) => r.check).join('; ')}`, rows);
        if (!o.attestation?.ownerRef || !o.attestation?.evidenceSha256) throw new BaselineError('ATTESTATION_REQUIRED', 'M085 needs a named owner attestation for the client-reachability condition (not provable in SQL) - HOLD', rows);
        extra = { preconditions: rows, attestation: o.attestation };
        await c.query(`SET phoenix.availability_cutover_attested = 'true'`);
        try { await c.query(applied); } finally { await c.query(`RESET phoenix.availability_cutover_attested`); }
      } else {
        try { await c.query(applied); } catch (e) { throw new BaselineError('APPLY_FAILED', `${f}: ${e.message}`, { file: f }); }
      }
      if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
      ledger.push({ file: f, action: derivation ? `APPLIED derived (${derivation})` : 'APPLIED original bytes', original_sha256: p.frozenSha, applied_sha256: sha256(Buffer.from(applied, 'utf8')), form: p.form, ...extra });
      if (f.startsWith('182_') && o.overlay182 !== false) {
        const ov = readFileSync(OVERLAY_182B, 'utf8');
        await c.query(ov);
        ledger.push({ file: '182b (overlay, not a migration)', action: 'APPLIED hash-pinned overlay', applied_sha256: sha256(Buffer.from(ov, 'utf8')) });
      }
      o.log?.(`applied ${f}`);
    }
  } catch (e) { await c.end(); throw e; }
  return { client: c, ledger };
}

// A super_admin must exist before M062 (abort otherwise). On a real project this is an OWNER-provided identity (decision B5); here a synthetic one.
export const SEED_SUPER_ADMIN_ID = '00000000-0000-0000-0000-0000000000a1';
export const SEED_AFTER_001 = `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('${SEED_SUPER_ADMIN_ID}', 'root@rig.local', jsonb_build_object('full_name','Rig Root','role','super_admin')) ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='super_admin', status='active' WHERE id='${SEED_SUPER_ADMIN_ID}';
`;

/** Per-category catalog fingerprints (no OIDs). Equal fingerprints = equal schema/ACL/policy/body state. */
export const FINGERPRINT_SQL = `
WITH sch AS (SELECT oid, nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'),
proc AS (SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||md5(p.prosrc)||'|'||p.prosecdef||'|'||p.provolatile::text||'|'||coalesce(array_to_string(p.proconfig,','),'')||'|'||coalesce(p.proacl::text,'') s
         FROM pg_proc p JOIN sch n ON n.oid=p.pronamespace WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')),
rel AS (SELECT n.nspname||'.'||c.relname||'|'||c.relkind::text||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity||'|'||coalesce(c.relacl::text,'') s FROM pg_class c JOIN sch n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','v','m','S','p')),
col AS (SELECT n.nspname||'.'||c.relname||'.'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') s
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN sch n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p')),
pol AS (SELECT schemaname||'.'||tablename||'.'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') s FROM pg_policies),
trg AS (SELECT n.nspname||'.'||c.relname||'|'||pg_get_triggerdef(t.oid) s FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN sch n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal),
con AS (SELECT n.nspname||'.'||c.relname||'.'||k.conname||'|'||pg_get_constraintdef(k.oid) s FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN sch n ON n.oid=c.relnamespace),
idx AS (SELECT schemaname||'.'||indexname||'|'||indexdef s FROM pg_indexes WHERE schemaname IN (SELECT nspname FROM sch)),
keys AS (SELECT key||'|'||module||'|'||action||'|'||is_dangerous s FROM public.permission_keys),
defs AS (SELECT role||'|'||permission_key||'|'||allowed s FROM public.role_permission_defaults),
roles AS (SELECT rolname||'|'||rolcanlogin||'|'||rolinherit s FROM pg_roles WHERE rolname LIKE 'phoenix%')
SELECT jsonb_build_object(
 'proc',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM proc),'rel',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM rel),
 'col',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM col),'policy',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM pol),
 'trigger',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM trg),'constraint',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM con),
 'index',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM idx),'permission_keys',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM keys),
 'role_defaults',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM defs),'roles',(SELECT md5(string_agg(s,E'\\n' ORDER BY s)) FROM roles),
 'n_proc',(SELECT count(*) FROM proc),'n_rel',(SELECT count(*) FROM rel),'n_policy',(SELECT count(*) FROM pol),'n_trigger',(SELECT count(*) FROM trg)) AS fp`;
export async function fingerprint(c) { return (await c.query(FINGERPRINT_SQL)).rows[0].fp; }
