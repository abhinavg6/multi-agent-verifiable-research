// Shared retry helper for transient network errors.
//
// Why this exists: every external HTTP call in the lab — Anthropic LLM
// requests, MemWal recall/remember through the relayer, source-API
// fetches — sits on top of Node's undici fetch. When a TCP connection
// drops mid-stream, undici throws an Error whose `.message` is literally
// "This operation was aborted", and that bubbles up unwrapped through
// the SDKs that don't add their own retry policy. A single hiccup can
// kill an entire research run.
//
// We retry on a small allowlist of failure modes that are genuinely
// transient (AbortError, ECONNRESET, fetch-failed, the Anthropic SDK's
// own "Connection error." wrapper, etc.) — never on 4xx / validation /
// rate-limit-after-retry-budget-exhausted, since those won't be helped
// by another attempt.
//
// Walrus uploads do NOT use this helper because retrying a half-finished
// writeBlobFlow risks duplicating gas/WAL spend on the loser transaction
// (see walrus.ts for the equivocation discussion). The serial mutex
// there handles that case differently.

export interface RetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  // Called before each retry sleep. Useful for trace events.
  onRetry?: (attempt: number, err: unknown, backoffMs: number) => void;
}

/**
 * Returns true for the transient network-shaped errors worth retrying.
 *
 * The Anthropic SDK wraps AbortError as `APIConnectionError("Connection
 * error.")` with the original in `.cause`; we match the wrapper text too
 * so wrapped and raw forms both retry.
 */
export function isAbortLike(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: any };
  const name = e.name ?? "";
  const msg = (e.message ?? "").toString();
  const code = e.code ?? e.cause?.code ?? "";
  if (name === "AbortError") return true;
  if (msg.includes("aborted")) return true;
  if (msg.includes("This operation was aborted")) return true;
  if (msg.includes("Connection error")) return true; // Anthropic SDK wrapper
  if (msg.includes("ECONNRESET")) return true;
  if (msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("fetch failed")) return true;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  return false;
}

/**
 * Run `fn` up to `maxAttempts` times, retrying only on isAbortLike errors
 * with exponential backoff (default 600ms × 2^(n-1)).
 */
export async function retryAbort<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseBackoffMs ?? 600;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !isAbortLike(err)) break;
      const backoff = base * Math.pow(2, attempt - 1);
      opts.onRetry?.(attempt, err, backoff);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
