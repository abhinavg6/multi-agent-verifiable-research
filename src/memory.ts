// MemWal wrapper for the research lab.
//
// Memory is split across five namespaces (see types.ts). The shared
// `verified_claims` namespace is what makes the multi-agent pattern useful:
// the Critic veto-writes here, the Synthesizer reads here. Per-agent scratch
// spaces let Readers think out loud without polluting the shared graph.
//
// Every read and write is mirrored to the EventBus so the UI can show
// exactly what each agent is touching.

import { MemWal } from "@mysten-incubation/memwal";
import type { EventBus } from "./events.ts";
import type { AgentRole, Namespace } from "./types.ts";
import { NAMESPACES } from "./types.ts";
import { retryAbort } from "./retry.ts";

export interface MemoryClientConfig {
  accountId: string;
  delegateKey: string;
  serverUrl: string;
}

export interface RecallHit {
  blob_id: string;
  text: string;
  distance: number;
}

export class MemoryClient {
  private memwal: MemWal;

  constructor(config: MemoryClientConfig) {
    this.memwal = MemWal.create({
      key: config.delegateKey,
      accountId: config.accountId,
      serverUrl: config.serverUrl,
      // Default; we override per call.
      namespace: "verified_claims",
    });
  }

  async health() {
    return this.memwal.health();
  }

  async recall(
    namespace: Namespace,
    agent: AgentRole,
    query: string,
    limit: number,
    bus?: EventBus,
  ): Promise<RecallHit[]> {
    // Wrap in retryAbort — MemWal calls go through undici fetch and can
    // hit transient TCP drops just like the LLM calls do.
    const result = await retryAbort(
      () => this.memwal.recall(query, limit, namespace),
      {
        onRetry: (attempt, err, backoffMs) => {
          const detail = err instanceof Error ? err.message : String(err);
          bus?.emit({
            type: "trace.step",
            agent,
            label: `memwal recall (${namespace}): aborted, retry ${attempt} in ${backoffMs}ms`,
            detail: detail.slice(0, 140),
            ts: Date.now(),
          });
        },
      },
    );
    const results = result.results ?? [];
    bus?.emit({
      type: "memory.read",
      namespace,
      agent,
      query,
      results,
      ts: Date.now(),
    });
    return results;
  }

  /**
   * Persist a memory and wait for it to land. The published SDK (0.0.2)
   * blocks until the memory is embedded → SEAL'd → uploaded → indexed, so
   * by the time this resolves the next agent's recall will see it.
   */
  async remember(
    namespace: Namespace,
    agent: AgentRole,
    text: string,
    bus?: EventBus,
  ): Promise<{ id: string; blob_id: string }> {
    const correlationId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    bus?.emit({
      type: "memory.write",
      namespace,
      agent,
      text,
      job_id: correlationId,
      status: "submitted",
      ts: Date.now(),
    });
    try {
      const result = await retryAbort(
        () => this.memwal.remember(text, namespace),
        {
          onRetry: (attempt, err, backoffMs) => {
            const detail = err instanceof Error ? err.message : String(err);
            bus?.emit({
              type: "trace.step",
              agent,
              label: `memwal remember (${namespace}): aborted, retry ${attempt} in ${backoffMs}ms`,
              detail: detail.slice(0, 140),
              ts: Date.now(),
            });
          },
        },
      );
      bus?.emit({
        type: "memory.write",
        namespace,
        agent,
        text,
        blob_id: result.blob_id,
        job_id: correlationId,
        status: "done",
        ts: Date.now(),
      });
      return { id: result.id, blob_id: result.blob_id };
    } catch (err) {
      bus?.emit({
        type: "memory.write",
        namespace,
        agent,
        text,
        job_id: correlationId,
        status: "failed",
        ts: Date.now(),
      });
      throw err;
    }
  }

  /**
   * Pull a small slice from each namespace — used by the Synthesizer at the
   * end of a run as a final cross-agent grounding pass.
   */
  async groundingAcross(
    agent: AgentRole,
    query: string,
    perNamespaceLimit: number,
    bus?: EventBus,
  ): Promise<Record<Namespace, RecallHit[]>> {
    const out: Partial<Record<Namespace, RecallHit[]>> = {};
    await Promise.all(
      NAMESPACES.map(async (ns) => {
        try {
          out[ns] = await this.recall(ns, agent, query, perNamespaceLimit, bus);
        } catch {
          out[ns] = [];
        }
      }),
    );
    return out as Record<Namespace, RecallHit[]>;
  }
}
