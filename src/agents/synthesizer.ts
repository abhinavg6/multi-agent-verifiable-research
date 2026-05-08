// Synthesizer agent.
// Reads from verified_claims + critic_notes, drops "block" claims, hedges
// "warn" claims, and writes a markdown report. Every paragraph cites the
// claim ids it draws from; the UI maps each claim id to its Walrus blob ID.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { MemoryClient } from "../memory.ts";
import type { SnapshotStore } from "../snapshots.ts";
import type { Claim, SynthesizerSnapshot } from "../types.ts";
import { callForText } from "./llm.ts";

export interface SynthesizerInput {
  question: string;
  claims: Claim[];
  critic_notes: string;
}

export interface SynthesizerOutput {
  snapshot: SynthesizerSnapshot;
  blob_id: string;
  aggregator_url: string;
}

const SYNTH_SYSTEM = `You are the Synthesizer in a verifiable research lab.

You will see the user's question, a list of atomic claims with claim ids and source blob ids, and a Critic's notes. Write a concise markdown report.

Rules:
- Cite claim ids inline like "[c-3]" wherever a claim is used. The UI will turn each [c-id] into a clickable link to the source bytes.
- DROP any claim with critic severity "block" entirely. Do not mention it.
- Hedge any claim with critic severity "warn" appropriately ("evidence is mixed", "limited to X cohort", etc.).
- Stay under ~400 words. No bullet lists unless the question demands them.
- Open with a one-paragraph direct answer, then 2-4 supporting paragraphs.
- Do not invent claims. Every factual statement must be backed by a [c-id].`;

export async function runSynthesizer(
  deps: {
    anthropic: Anthropic;
    model: string;
    memory: MemoryClient;
    snapshots: SnapshotStore;
    bus: EventBus;
  },
  input: SynthesizerInput,
): Promise<SynthesizerOutput> {
  const { anthropic, model, memory, snapshots, bus } = deps;
  bus.emit({ type: "agent.start", agent: "synthesizer", label: "Synthesizer: writing report", ts: Date.now() });

  // Cross-namespace grounding for the report — pulls a few hits from each
  // namespace into the prompt so the model sees the full memory landscape.
  await memory.groundingAcross("synthesizer", input.question, 3, bus);

  const usable = input.claims.filter((c) => c.critic_flag?.severity !== "block");
  const claimsBlock = usable
    .map(
      (c) =>
        `[${c.id}] (conf=${c.confidence.toFixed(2)}${c.critic_flag ? `, critic=${c.critic_flag.severity}: ${c.critic_flag.reason}` : ""}, sources=${c.supporting_blob_ids.join(",")}) ${c.text}`,
    )
    .join("\n");

  const userPrompt = [
    `<question>${input.question}</question>`,
    `<claims>`,
    claimsBlock,
    `</claims>`,
    `<critic-notes>${input.critic_notes || "(none)"}</critic-notes>`,
  ].join("\n\n");

  bus.emit({ type: "trace.step", agent: "synthesizer", label: "Calling Claude (synthesizer)", ts: Date.now() });
  const report = await callForText({
    anthropic,
    model,
    system: SYNTH_SYSTEM,
    user: userPrompt,
    max_tokens: 1500,
    bus,
    agent: "synthesizer",
    label: "synthesizer",
  });

  // Build a claim_id → blob_ids index for the UI.
  const claim_index = usable.map((c) => ({ claim_id: c.id, blob_ids: c.supporting_blob_ids }));

  const snapshot: SynthesizerSnapshot = {
    kind: "synth_snapshot",
    question: input.question,
    report_markdown: report.trim(),
    claim_index,
    produced_at: new Date().toISOString(),
  };
  const pinned = await snapshots.pinSnapshot("synthesizer", snapshot, bus);

  // Persist a final-report pointer so future runs can recall this answer.
  await memory.remember(
    "synth_outputs",
    "synthesizer",
    `Final report for "${input.question}" (snapshot: ${pinned.blob_id}). Used ${usable.length} claims.`,
    bus,
  );

  bus.emit({ type: "agent.done", agent: "synthesizer", ts: Date.now() });
  return {
    snapshot,
    blob_id: pinned.blob_id,
    aggregator_url: pinned.aggregator_url,
  };
}
