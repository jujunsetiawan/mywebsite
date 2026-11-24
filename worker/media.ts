// Read-only `/media/*` proxy to the private R2 bucket (Story 1.2).
//
// Invoked only for `/media/*` (`run_worker_first` in wrangler.jsonc); every
// other path is served by Workers static assets without running this script.
// One R2 read per request (`get` for GET, `head` for HEAD); never lists or
// writes. Bodies are streamed untransformed. The only exception to "one read"
// is a GET whose range starts past the end of the object: R2 rejects that read
// without reporting the size, so a `head` fetches it for the 416 response.

interface Env {
  MEDIA: R2Bucket;
}

const PREFIX = '/media/';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Returns the R2 key for a `/media/…` pathname, or null when it is not servable. */
export function mediaKey(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (key === '') return null;
  if (key.split('/').some((segment) => segment === '..')) return null;
  return key;
}

/**
 * Parses a single-range `Range: bytes=…` header.
 * `undefined` = no usable header (serve the full object), `'unsatisfiable'` = 416.
 */
export function parseRange(header: string | null): R2Range | 'unsatisfiable' | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Other units, multiple ranges or malformed syntax: ignore the header (RFC 9110 §14.2).
  if (!match) return undefined;
  const [, start = '', end = ''] = match;
  if (start === '' && end === '') return undefined;
  if (start === '') {
    const suffix = Number(end);
    return suffix === 0 ? 'unsatisfiable' : { suffix };
  }
  const offset = Number(start);
  if (end === '') return { offset };
  const last = Number(end);
  if (last < offset) return undefined;
  return { offset, length: last - offset + 1 };
}

/** Resolves a parsed range against the object size; null when unsatisfiable. */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } | null {
  if ('suffix' in range && range.suffix !== undefined) {
    if (size === 0) return null;
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = 'offset' in range && range.offset !== undefined ? range.offset : 0;
  if (offset >= size) return null;
  const requested = 'length' in range && range.length !== undefined ? range.length : size - offset;
  return { offset, length: Math.min(requested, size - offset) };
}

function baseHeaders(object: R2Object): Headers {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  // `_headers` rules never reach Worker responses, so set this here.
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

/** True when `If-None-Match` is `*` or lists the object's ETag (weak comparison). */
function etagMatches(header: string | null, object: R2Object): boolean {
  if (header === null) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === object.httpEtag);
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function notModified(object: R2Object): Response {
  return new Response(null, { status: 304, headers: baseHeaders(object) });
}

function unsatisfiable(object: R2Object): Response {
  return new Response(null, {
    status: 416,
    headers: { 'Content-Range': `bytes */${object.size}`, 'Accept-Ranges': 'bytes' },
  });
}

function partial(object: R2Object, body: ReadableStream | null, offset: number, length: number): Response {
  const headers = baseHeaders(object);
  headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  headers.set('Content-Length', String(length));
  return new Response(body, { status: 206, headers });
}

function full(object: R2Object, body: ReadableStream | null): Response {
  const headers = baseHeaders(object);
  headers.set('Content-Length', String(object.size));
  return new Response(body, { status: 200, headers });
}

/** R2 error 10039: "The requested range is not satisfiable". */
function isUnsatisfiableRange(error: unknown): boolean {
  return error instanceof Error && /\(10039\)|not satisfiable/i.test(error.message);
}

async function handleHead(env: Env, key: string, ifNoneMatch: string | null, range: ReturnType<typeof parseRange>) {
  const object = await env.MEDIA.head(key);
  if (object === null) return notFound();
  if (etagMatches(ifNoneMatch, object)) return notModified(object);
  if (range === 'unsatisfiable') return unsatisfiable(object);
  if (range !== undefined) {
    const resolved = resolveRange(range, object.size);
    return resolved === null ? unsatisfiable(object) : partial(object, null, resolved.offset, resolved.length);
  }
  return full(object, null);
}

async function handleGet(env: Env, key: string, ifNoneMatch: string | null, range: ReturnType<typeof parseRange>) {
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await env.MEDIA.get(key, {
      // R2 evaluates the precondition and returns the object without a body when it fails.
      onlyIf: ifNoneMatch === null ? undefined : new Headers({ 'If-None-Match': ifNoneMatch }),
      range: range === undefined || range === 'unsatisfiable' ? undefined : range,
    });
  } catch (error) {
    if (!isUnsatisfiableRange(error)) throw error;
    const meta = await env.MEDIA.head(key);
    if (meta === null) return notFound();
    return etagMatches(ifNoneMatch, meta) ? notModified(meta) : unsatisfiable(meta);
  }
  if (object === null) return notFound();
  if (!('body' in object)) return notModified(object);
  if (range === 'unsatisfiable') {
    await object.body.cancel();
    return unsatisfiable(object);
  }
  if (range !== undefined) {
    // Always clamp against the real size: R2 may echo the requested range unclamped.
    const resolved = resolveRange(range, object.size);
    if (resolved === null) {
      await object.body.cancel();
      return unsatisfiable(object);
    }
    return partial(object, object.body, resolved.offset, resolved.length);
  }
  return full(object, object.body);
}

export default {
  async fetch(request, env): Promise<Response> {
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const key = mediaKey(new URL(request.url).pathname);
    if (key === null) return notFound();
    const ifNoneMatch = request.headers.get('If-None-Match');
    const range = parseRange(request.headers.get('Range'));
    return method === 'HEAD' ? handleHead(env, key, ifNoneMatch, range) : handleGet(env, key, ifNoneMatch, range);
  },
} satisfies ExportedHandler<Env>;
