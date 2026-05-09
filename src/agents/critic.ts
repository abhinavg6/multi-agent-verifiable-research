// Critic agent.
// Adversarially reviews the full claim set. For each claim it can:
//   - "info":  add useful context (rare; mostly stays out of the way)
//   - "warn":  challenge but allow into the report with hedging
//   - "block": demand the Synthesizer either drop it or attribute it carefully
//
// The Critic's flags are written to verified_claims so the Synthesizer sees
// them on recall, plus an aggregate snapshot is pinned to Walrus.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { MemoryClient } from "../memory.ts";
import type { SnapshotStore } from "../snapshots.ts";
import type { Claim, CriticSnapshot } from "../types.ts";
import { callForJSON } from "./llm.ts";

export interface CriticInput {
  question: string;
  claims: Claim[];
}

export interface CriticOutput {
  snapshot: CriticSnapshot;
  blob_id: string;
  aggregator_url: string;
  flagged_claims: Claim[]; // claims with critic_flag attached
}

const CRITIC_SYSTEM = `You are the Critic in a verifiable research lab.

You will see the user's research question and a set of atomic claims, each labeled with a claim id and the Reader agent that produced it. Your job is to challenge the set: identify claims that are weakly supported, internally contradictory, dated, methodologically flawed, or overstated.

Output JSON with this exact shape:
{
  "notes": "one paragraph of overall observations about the claim set",
  "flags": [
    {
      "claim_id": "c-3",
      "severity": "warn",
      "reason": "specific, actionable reason (under 30 words)"
    }
  ]
}

Severity rules:
- "block" — only when the claim is materially wrong, fabricated-looking, or unsupported by its cited source. The Synthesizer will drop these.
- "warn"  — needs hedging or caveat in the final report (uncertainty, scope, or freshness).
- "info"  — adds useful context but doesn't change the verdict. Use sparingly.

Rules:
- Don't flag every claim. A clean run should have few flags.
- Don't add new claims. You can only flag existing ones.
- Reference claim_id values exactly as given.`;

export async function runCritic(
  deps: {
    anthropic: Anthropic;
    model: string;
    memory: MemoryClient;
    snapshots: SnapshotStore;
    bus: EventBus;
  },
  input: CriticInput,
): Promise<CriticOutput> {
  const { anthropic, model, memory, snapshots, bus } = deps;
  bus.emit({ type: "agent.start", agent: "critic", label: `Critic: reviewing ${input.claims.length} claims`, ts: Date.now() });

  // Recall reader scratch for additional context (the reader's own confidence
  // markers and source picks live there).
  await memory.recall("reader_scratch", "critic", input.question, 6, bus);

  const claimsBlock = input.claims
    .map(
      (c) =>
        `[${c.id}] (reader=${c.reader_role ?? "?"}, conf=${c.confidence.toFixed(2)}, sources=${c.supporting_blob_ids.length}) ${c.text}`,
    )
    .join("\n");

  const userPrompt = [
    `<question>${input.question}</question>`,
    `<claims>`,
    claimsBlock,
    `</claims>`,
  ].join("\n\n");

  type Raw = {
    notes: string;
    flags: Array<{ claim_id: string; severity: "info" | "warn" | "block"; reason: string }>;
  };

  bus.emit({ type: "trace.step", agent: "critic", label: "Calling Claude (critic)", ts: Date.now() });
  const raw = await callForJSON<Raw>({
    anthropic,
    model,
    system: CRITIC_SYSTEM,
    user: userPrompt,
    max_tokens: 2000,
    bus,
    agent: "critic",
    label: "critic",
  });

  // Apply flags to the claim set in place.
  const byId = new Map(input.claims.map((c) => [c.id, c]));
  const flagged: Claim[] = [];
  for (const f of raw.flags ?? []) {
    const c = byId.get(f.claim_id);
    if (!c) continue;
    c.critic_flag = { severity: f.severity, reason: f.reason };
    flagged.push(c);
    bus.emit({
      type: "claim.flagged",
      agent: "critic",
      claim_id: f.claim_id,
      severity: f.severity,
      reason: f.reason,
      ts: Date.now(),
    });
    // Persist veto/warn into the shared claim graph. Best-effort: the
    // critic_snapshot below is the canonical record, and the Synthesizer
    // sees critic flags in-process via the claim object's critic_flag
    // field rather than via MemWal recall.
    try {
      await memory.remember(
        "critic_notes",
        "critic",
        `[${c.id}] ${f.severity.toUpperCase()}: ${f.reason}`,
        bus,
      );
    } catch (err) {
      bus.emit({
        type: "trace.step",
        agent: "critic",
        label: `Critic: memwal write failed for ${c.id} (continuing)`,
        detail: err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140),
        ts: Date.now(),
      });
    }
  }

  const snapshot: CriticSnapshot = {
    kind: "critic_snapshot",
    flagged_claim_ids: flagged.map((c) => c.id),
    notes: raw.notes ?? "",
    produced_at: new Date().toISOString(),
  };
  const pinned = await snapshots.pinSnapshot("critic", snapshot, bus);

  bus.emit({ type: "agent.done", agent: "critic", ts: Date.now() });
  return {
    snapshot,
    blob_id: pinned.blob_id,
    aggregator_url: pinned.aggregator_url,
    flagged_claims: flagged,
  };
}
