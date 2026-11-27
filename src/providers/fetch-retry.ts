import http from 'node:http';
import https from 'node:https';

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

/**
 * Node `http`/`https` streaming fetch with a 300s connect/socket timeout (unlike
 * built-in undici `fetch`, which hardcodes a 10s connectTimeout) and fast IPv4/IPv6
 * fallback via `autoSelectFamily`.
 */
export function createLongTimeoutFetch(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): typeof fetch {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return globalThis.fetch(input, init);
    }

    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = normalizeHeaders(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const bodyBuf =
      typeof init.body === 'string'
        ? Buffer.from(init.body, 'utf8')
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : init.body instanceof ArrayBuffer
            ? Buffer.from(init.body)
            : null;
    if (bodyBuf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(bodyBuf.byteLength);
    }

    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const requestOptions = {
        method,
        headers,
        timeout: timeoutMs,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 2500,
      } as https.RequestOptions;

      const req = transport.request(
        url,
        requestOptions,
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else if (value !== undefined) {
              responseHeaders.set(key, value);
            }
          }

          res.setTimeout(timeoutMs, () => {
            res.destroy(Object.assign(new Error(`Stream timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
          });

          const status = res.statusCode ?? 200;
          const noBody = status === 204 || status === 304 || method === 'HEAD';
          const stream = noBody
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  res.on('data', (chunk: Buffer) => {
                    controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                  });
                  res.on('end', () => {
                    signal?.removeEventListener('abort', onAbort);
                    try {
                      controller.close();
                    } catch {
                      // stream already closed
                    }
                  });
                  res.on('error', (err) => {
                    signal?.removeEventListener('abort', onAbort);
                    try {
                      controller.error(err);
                    } catch {
                      // stream already errored
                    }
                  });
                },
                cancel() {
                  signal?.removeEventListener('abort', onAbort);
                  res.destroy();
                  req.destroy();
                },
              });

          if (noBody) {
            res.resume();
            res.on('end', () => signal?.removeEventListener('abort', onAbort));
          }

          settled = true;
          resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
        },
      );

      const onAbort = () => {
        const err = signal?.reason ?? new Error('Aborted');
        req.destroy(err instanceof Error ? err : new Error(String(err)));
        fail(err);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      req.on('timeout', () => {
        const err = Object.assign(new Error(`Connect/socket timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
        req.destroy(err);
        fail(err);
      });
      req.on('error', fail);

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  };
}

/**
 * Unwraps Node.js / undici `TypeError: fetch failed` errors to expose the
 * underlying socket, TLS, DNS, or timeout cause instead of an opaque message.
 */
export function formatNetworkError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));

  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const err = current as Error & { code?: unknown; errno?: unknown; errors?: unknown[] };
    const code = typeof err.code === 'string' && err.code ? err.code : undefined;
    const msg = typeof err.message === 'string' ? err.message.trim() : '';

    if (current !== error) {
      const part = [code, msg].filter(Boolean).join(': ');
      if (part && !details.includes(part)) details.push(part);
    } else if (code && !msg.includes(code)) {
      details.push(code);
    }

    if (Array.isArray(err.errors)) {
      for (const nested of err.errors.slice(0, 2)) {
        if (nested && typeof nested === 'object') {
          const n = nested as Error & { code?: unknown };
          const part = [typeof n.code === 'string' ? n.code : '', n.message].filter(Boolean).join(': ');
          if (part && !details.includes(part)) details.push(part);
        }
      }
    }

    current = (err as { cause?: unknown }).cause;
  }

  const base = error.message || 'fetch failed';
  return details.length ? new Error(`${base} (${details.join(' -> ')})`) : error;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Retries transient pre-stream network/socket failures (e.g. stale keep-alive
 * ECONNRESET) and 502/503/504 gateway glitches.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = Math.max(0, options.retries ?? 2);
  const baseDelay = options.retryDelayMs ?? 350;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new Error('Aborted');
    }

    const headers =
      attempt > 0 && init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
        ? { ...init.headers, connection: 'close' }
        : init.headers;

    try {
      const response = await fetchImpl(url, { ...init, headers });
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore body cancel error
        }
        await sleep(baseDelay * (attempt + 1), init.signal ?? undefined);
        continue;
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(baseDelay * (attempt + 1), init.signal ?? undefined);
        continue;
      }
    }
  }

  throw formatNetworkError(lastError);
}
