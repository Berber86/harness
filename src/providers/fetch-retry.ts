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
 * ECONNRESET in Node undici) and 502/503/504 gateway glitches.
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
