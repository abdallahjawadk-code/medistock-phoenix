// CLI: apply the canonical chain to the disposable rig and report.
//   PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres node tools/pg-rig/apply.mjs [upTo]
import { buildRig } from './rig.mjs';

const upTo = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const t0 = Date.now();
try {
  const rig = await buildRig({ upTo, log: (m) => process.stdout.write(m + '\n') });
  const { rows } = await rig.asAdmin((c) =>
    c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`));
  console.log(`OK — chain applied through ${upTo === Infinity ? 'latest' : upTo} in ${((Date.now()-t0)/1000).toFixed(1)}s; public functions: ${rows[0].n}`);
  await rig.end();
  process.exit(0);
} catch (e) {
  console.error('RIG FAILED:', e.message);
  process.exit(1);
}
