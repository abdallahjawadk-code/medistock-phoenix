import { authenticate, callerHasCentralNeedsAuthority } from '../_lib/supabase.ts';
import { reviewedAnnualLayouts } from '../_c3-core/registry.ts';
import { createAnnualSourceDiscoveryHandler } from '../_c4-core/discovery.ts';

export const GET = createAnnualSourceDiscoveryHandler({ registrations: reviewedAnnualLayouts,
  authenticate, authorized: callerHasCentralNeedsAuthority });
