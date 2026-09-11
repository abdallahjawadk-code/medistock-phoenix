import handler from '../_cn2b-core/upload-ticket.ts';

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
