import handler from '../central-needs/finalize-import.ts';

/** Vercel Web Handler adapter. Keeps CN-2B business logic in the canonical module. */
export default { fetch: handler };
