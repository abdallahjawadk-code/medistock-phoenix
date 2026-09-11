import handler from '../_cn2b-core/source-download.ts';

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
