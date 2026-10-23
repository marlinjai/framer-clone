// src/server/books/http/boundedBody.ts
//
// Request bodies read with a limit, as a stream: a body over the limit is
// refused once it passes the limit, never held in memory whole, also when the
// client sends no Content-Length (or a false one). Used by the template
// preview (256 KB of JSON) and the logo upload (1 MB of image bytes). Route
// modules may only export route handlers, so the helper lives here.

/** The body's bytes, or null once they pass `limit`. */
export async function boundedBytes(req: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? '0') > limit) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The body as UTF-8 text without a leading byte order mark, or null once it passes `limit`. */
export async function boundedText(req: Request, limit: number): Promise<string | null> {
  const bytes = await boundedBytes(req, limit);
  // As req.text() did: a leading byte order mark is not part of the JSON.
  return bytes === null ? null : Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
}
