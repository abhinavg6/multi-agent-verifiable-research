// Tiny helpers for calling Claude with structured outputs.
//
// Two extras on top of the bare SDK:
//   1. Retry on AbortError + transient network errors. The Anthropic SDK's
//      built-in retry policy only covers HTTP 408/409/429/5xx — it does
//      NOT retry on AbortError (which the underlying undici fetch throws
//      when a TCP connection drops mid-stream or the upstream times out).
//      That's the most common failure mode in practice, so we layer our
//      own retry on top: 3 attempts, exponential backoff, and a tight
//      90s timeout so we fail fast rather than hanging on the SDK's
//      10-minute default.
//   2. JSON-out parsing: every agent in this lab returns structured data,
//      so we ask the model for JSON in the system prompt and best-effort
//      parse the first balanced object out of the text response.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { AgentRole } from "../types.ts";

export interface LlmCallArgs {
  anthropic: Anthropic;
  model: string;
  system: string;
  user: string;
  max_tokens?: number;
  // Trace integration — pass the bus to surface retry attempts in the UI.
  bus?: EventBus;
  agent?: AgentRole;
  // Short label shown in retry trace events, e.g. "planner", "reader-2".
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

export async function callForJSON<T>(args: LlmCallArgs): Promise<T> {
  const text = await callRaw(args, "json");
  return parseJSONBestEffort<T>(text);
}

export async function callForText(args: LlmCallArgs): Promise<string> {
  return callRaw(args, "text");
}

async function callRaw(args: LlmCallArgs, mode: "json" | "text"): Promise<string> {
  const system =
    mode === "json"
      ? args.system + "\n\nRespond with a single JSON object. No prose, no markdown fences."
      : args.system;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await args.anthropic.messages.create(
        {
          model: args.model,
          max_tokens: args.max_tokens ?? 2048,
          system,
          messages: [{ role: "user", content: args.user }],
        },
        {
          // Tight per-attempt timeout. The SDK default is 10 minutes which
          // is too forgiving — for these short calls, anything past ~90s
          // is a stalled connection we should retry rather than wait on.
          timeout: DEFAULT_TIMEOUT_MS,
          // The SDK does its own retries on 5xx/429; let it.
          maxRetries: 2,
        },
      );
      return resp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS || !isRetriable(err)) break;

      const backoffMs = 600 * Math.pow(2, attempt - 1); // 600, 1200, 2400…
      const detail = err instanceof Error ? err.message : String(err);
      args.bus?.emit({
        type: "trace.step",
        agent: args.agent,
        label: `${args.label ?? "LLM"}: call aborted, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoffMs}ms`,
        detail: detail.slice(0, 140),
        ts: Date.now(),
      });
      await sleep(backoffMs);
    }
  }
  // Re-throw with friendlier context for the user-facing error pane.
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `LLM call failed${args.label ? ` (${args.label})` : ""} after ${MAX_ATTEMPTS} attempts: ${detail}`,
  );
}

/**
 * AbortError, ECONNRESET, ETIMEDOUT, "aborted" — the failure modes worth
 * retrying. We deliberately don't retry on 4xx (other than 408/409/429,
 * which the SDK already handles): those are usually our fault, not the
 * network's.
 */
function isRetriable(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: any };
  const name = e.name ?? "";
  const msg = e.message ?? "";
  const code = e.code ?? e.cause?.code ?? "";
  if (name === "AbortError") return true;
  if (msg.includes("aborted")) return true;
  if (msg.includes("This operation was aborted")) return true;
  if (msg.includes("ECONNRESET")) return true;
  if (msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("fetch failed")) return true;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJSONBestEffort<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]) as T;
      } catch {
        // fall through
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        // fall through
      }
    }
    throw new Error(`Could not parse JSON from model output: ${trimmed.slice(0, 200)}…`);
  }
}
