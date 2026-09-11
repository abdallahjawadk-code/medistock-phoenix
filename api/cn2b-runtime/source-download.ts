import handler from '../central-needs/source-download.ts';

/** Vercel Web Handler adapter. Keeps CN-2B business logic in the canonical module. */
export default { fetch: handler };
