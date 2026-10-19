// Derivation audit: exact differences between the frozen originals (M023, M085, M182) and what the PG-rig applies, with SHA-256 before/after,
// the reason and the security effect. Also GENERATES the hash-pinned 182b overlay from the rig's own hash-checked contract (so the overlay
// can never drift from what the rig proves). Usage: node audit-derivations.mjs <out-dir>   (needs the LF migrations dir + no database)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compareSqlTokens } from './sql-tokens.mjs';
import { shimSql, MIGRATIONS_DIR, ATTESTED_CUTOVER_MIGRATIONS } from '../../../tools/pg-rig/rig.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(HERE, 'audit-out'); mkdirSync(out, { recursive: true });
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const f023 = '023_phoenix_live_profile_role_resolution_fix.sql', f085 = '085_phoenix_revoke_manual_availability_writers.sql', f182 = '182_phoenix_health_center_facility_scoped_rbac.sql';
const lines = (s) => s.split('\n');
const diffLines = (a, b) => {  // minimal line diff for same-order edits
  const A = lines(a), B = lines(b), rows = []; let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (A[i] === B[j]) { i++; j++; continue; }
    let k = j; while (k < B.length && B[k] !== A[i]) k++;           // lines added in B before A[i] reappears
    if (k < B.length && i < A.length && (k - j) < 400) { for (; j < k; j++) rows.push('+ ' + B[j]); continue; }
    let m = i; while (m < A.length && A[m] !== B[j]) m++;           // lines removed from A
    if (m < A.length && j < B.length && (m - i) < 4000) { for (; i < m; i++) rows.push('- ' + A[i]); continue; }
    rows.push('- ' + (A[i] ?? '')); rows.push('+ ' + (B[j] ?? '')); i++; j++;
  }
  return rows;
};
const report = { generated_for: 'R1 staging B1/B2 closure', files: [] };

// M023
const o023 = readFileSync(join(MIGRATIONS_DIR, f023), 'utf8'); const s023 = shimSql(f023, o023);
const d023 = diffLines(o023, s023);
report.files.push({ file: f023, original_sha256: sha(o023), rig_applied_sha256: sha(s023), changed_lines: d023.length / 2,
  change: d023, reason: 'M023 VERIFY DO-block ASSERTs read pg_policies.qual for INSERT/UPDATE policies; an INSERT policy has only with_check (qual is NULL), so on a fresh replay the VERIFY aborts the whole transaction (policy changes roll back).',
  security_effect: 'None on the policies themselves: the CREATE POLICY statements above the VERIFY block are byte-identical. Only the verification READ changes (coalesce(qual, with_check)); it can only make an assertion see the real predicate. It does not weaken what is created.',
  open_question: "How Production's M023 VERIFY passed is not known from the repository (no live read, D10); the derivation is a repository-replay fact, not a Production fact." });

// M085
const o085 = readFileSync(join(MIGRATIONS_DIR, f085), 'utf8'); const s085 = shimSql(f085, o085);
report.files.push({ file: f085, original_sha256: sha(o085), rig_applied_sha256: sha(s085), changed_lines: 0, change: [], attestation_guc: ATTESTED_CUTOVER_MIGRATIONS.get(f085),
  reason: 'M085 is a fail-closed cutover file: it aborts unless `phoenix.availability_cutover_attested = true` is set in the apply session. The rig sets the GUC around that single apply and resets it. The FILE is not changed.',
  security_effect: 'Applying it REVOKEs EXECUTE on the two manual availability writers from authenticated (service_role keeps it). Setting the GUC asserts "derived-availability parity proven AND no client reaches a manual quantity writer" - the rig simply asserts it; the staging path must PROVE P1-P4 in SQL (verify_085_preconditions.sql) and carry a named owner attestation for P5, else HOLD.' });

// M182
const o182 = readFileSync(join(MIGRATIONS_DIR, f182), 'utf8'); const s182 = shimSql(f182, o182);
const sigs = ['CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)', 'CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(p_profile_id uuid, p_key text)'];
const stmts = [];
for (const sig of sigs) {
  const a = s182.indexOf(sig); const end = s182.indexOf('$function$;', s182.indexOf('AS $function$', a)) + '$function$;'.length;
  stmts.push(s182.slice(a, end));
  const oa = o182.indexOf(sig); const oend = o182.indexOf('$function$;', o182.indexOf('AS $function$', oa)) + '$function$;'.length;
  const norm = (t) => t.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').toLowerCase();
  const ob = o182.slice(o182.indexOf('AS $function$', oa) + 13, oend - 11), pb = s182.slice(s182.indexOf('AS $function$', a) + 13, end - 11);
  report.files.push({ file: f182, function: sig, original_body_sha256: sha(ob), production_recorded_body_sha256: sha(pb), whitespace_comment_normalised_identical: norm(ob) === norm(pb), token_aware_identical: compareSqlTokens(ob, pb).equal, token_count: compareSqlTokens(ob, pb).count,
    reason: 'M196 fingerprints the function bodies Production actually has (compact forms recorded in schema_migrations); the repository 182 text has expanded, comment-rich bodies with the same behaviour. A rebuild must reproduce the recorded bodies before M196.',
    security_effect: compareSqlTokens(ob, pb).equal ? 'None provable: token-aware identical (comments/whitespace ignored; identifiers/keywords case-insensitive; literals exact) AND behaviourally equal on the matrix in m182-equivalence.dynamic.test.ts.' : 'REVIEW REQUIRED: bodies differ beyond comments/whitespace - see diff.' });
}
report.files[report.files.length - 2].file_sha = { original_sha256: sha(o182), rig_applied_sha256: sha(s182) };
const overlay = `-- 182b: Production-recorded function bodies (OVERLAY, not a migration, not part of the frozen history).
-- Generated by audit-derivations.mjs from the rig's hash-checked M182 contract. Applied immediately AFTER the unmodified M182 and BEFORE M183,
-- exactly where the rig substitutes them. CREATE OR REPLACE keeps the function ACL and attributes of M182.
${stmts.join('\n\n')}
`;
writeFileSync(join(HERE, '182b_production_body_overlay.sql'), overlay);
report.overlay = { file: '182b_production_body_overlay.sql', sha256: sha(overlay), bytes: overlay.length };
writeFileSync(join(out, 'derivation-audit.json'), JSON.stringify(report, null, 1));
for (const [n, d] of [['023', d023]]) writeFileSync(join(out, `diff-M${n}.txt`), d.join('\n') + '\n');
// M182 minimal diff (only the two replaced bodies)
const d182 = []; for (const sig of sigs) { const oa = o182.indexOf(sig); const oend = o182.indexOf('$function$;', o182.indexOf('AS $function$', oa)); const a = s182.indexOf(sig); const end = s182.indexOf('$function$;', s182.indexOf('AS $function$', a));
  d182.push(`@@ ${sig} @@`, ...o182.slice(o182.indexOf('AS $function$', oa), oend).split('\n').map((l) => '- ' + l), ...s182.slice(s182.indexOf('AS $function$', a), end).split('\n').map((l) => '+ ' + l)); }
writeFileSync(join(out, 'diff-M182.txt'), d182.join('\n') + '\n');
console.log(JSON.stringify(report.files.map((x) => ({ file: x.file, fn: x.function, orig: (x.original_sha256 ?? x.original_body_sha256)?.slice(0, 12), after: (x.rig_applied_sha256 ?? x.production_recorded_body_sha256)?.slice(0, 12), norm_identical: x.whitespace_comment_normalised_identical, lines: x.changed_lines })), null, 1));
console.log('overlay', report.overlay);
