import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { authenticate, callerHasCentralNeedsAuthority } from '../_lib/supabase.ts';
import { readAuthorizedAnnualC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import { runC3IsolatedWorker } from '../_cn2b-core/annual-c3-worker-boundary.ts';
import { createC3ReadHandler } from '../_c3-core/http.ts';

// Real corpus definitions remain private local review artifacts. No synthetic
// layout or unapproved registry is activated in the deployed business route.
export const POST = createC3ReadHandler({ registrations: [],
  workerEntry: pathToFileURL(resolve('.c3-runtime/worker.mjs')),
  authenticate, authorized: callerHasCentralNeedsAuthority,
  read: readAuthorizedAnnualC3Original, run: runC3IsolatedWorker,
});
