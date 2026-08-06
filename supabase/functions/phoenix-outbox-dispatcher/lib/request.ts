// Pure request-shape validation for phoenix-outbox-dispatcher (D3-2A).
// No Deno globals — operates only on the standard Fetch API Request/Headers
// objects, so it is identical under Deno, Node, or any other host.

export const SUPPORTED_METHOD = "GET";

export function isSupportedMethod(method: string): boolean {
  return method === SUPPORTED_METHOD;
}

// A GET request carrying a body is outside the shape this endpoint expects.
// Checked via Content-Length / the body stream's presence rather than by
// reading the body, so a malformed request is rejected without incurring
// the cost (or side effects) of consuming it.
export function hasUnexpectedBody(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const trimmed = contentLength.trim();
    if (trimmed !== "" && trimmed !== "0") return true;
  }
  return request.body !== null;
}
