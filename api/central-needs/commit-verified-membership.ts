import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { authenticate, callerHasCentralNeedsAuthority, serviceClient } from '../_lib/supabase.ts';
import { readAuthorizedAnnualC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import { runC3IsolatedWorker } from '../_cn2b-core/annual-c3-worker-boundary.ts';
import { createC4MembershipHandler } from '../_c4-core/http.ts';
import { reviewedAnnualLayouts } from '../_c3-core/registry.ts';

const workerEntry = pathToFileURL(resolve('.c3-runtime/worker.mjs'));
// No real or synthetic registrations are deployed. Missing/unapplied C4 SQL,
// inactive contracts and unreviewed sources remain closed independently.
export const POST = createC4MembershipHandler({ registrations: reviewedAnnualLayouts, workerEntry,
  authenticate, authorized: callerHasCentralNeedsAuthority, service: serviceClient,
  read: readAuthorizedAnnualC3Original, run: runC3IsolatedWorker,
  workerSha256: async () => createHash('sha256').update(await readFile(workerEntry)).digest('hex'),
});
