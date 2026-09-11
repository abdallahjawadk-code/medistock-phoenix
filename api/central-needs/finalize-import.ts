import handler from '../_cn2b-core/finalize-import.ts';

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
