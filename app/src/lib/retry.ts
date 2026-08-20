// fetchWithRetry — resilient fetch with exponential backoff for cold starts.
//
// HF Spaces sleep after 48h idle. The first request after sleep takes
// 30-60s to cold-start. Standard fetch gives up after one attempt, which
// makes the Space look dead. This wrapper retries with exponential backoff
// + jitter (to prevent thundering herd when multiple clients wake the same
// Space simultaneously).
//
// Retry conditions:
//   - Network error (fetch threw)
//   - HTTP 5xx (server error — Space is building/starting)
//   - HTTP 429 (rate limited)
//
// Does NOT retry on:
//   - HTTP 4xx (except 429) — client errors are not transient
//   - AbortError — caller cancelled

export interface RetryOptions {
  maxAttempts?: number;  // default 5
  baseDelayMs?: number;  // default 1000 (1s)
  maxDelayMs?: number;   // default 30000 (30s)
  timeoutMs?: number;    // per-attempt timeout, default 10000 (10s)
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
}

export async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  retryOpts: RetryOptions = {},
): Promise<Response> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    timeoutMs = 10000,
    onRetry,
  } = retryOpts;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Per-attempt timeout via AbortController.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        ...opts,
        signal: opts.signal || controller.signal,
      });
      clearTimeout(timeout);

      // Retry on 5xx and 429.
      if ((res.status >= 500 && res.status < 600) || res.status === 429) {
        if (attempt < maxAttempts) {
          const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
          onRetry?.(attempt, `HTTP ${res.status}`, delay);
          await sleep(delay);
          continue;
        }
      }
      return res;
    } catch (err: any) {
      lastError = err;
      if (err.name === 'AbortError' && opts.signal) {
        // Caller-initiated abort — don't retry.
        throw err;
      }
      if (attempt < maxAttempts) {
        const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
        onRetry?.(attempt, err.message, delay);
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error('fetchWithRetry: exhausted all attempts');
}

function computeBackoff(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential: base * 2^(attempt-1). With jitter: + 0-50% random.
  const exp = baseMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exp * 0.5;
  return Math.min(exp + jitter, maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
