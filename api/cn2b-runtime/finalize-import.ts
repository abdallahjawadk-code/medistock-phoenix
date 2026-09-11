import handler from '../central-needs/finalize-import.ts';

/** Vercel Web-standard method adapter. Keeps CN-2B business logic canonical. */
export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
