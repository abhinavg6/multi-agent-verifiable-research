// Reader agent.
// Each Reader picks one sub-question + one source, fetches candidate
// documents, pins the chosen one to Walrus, then asks Claude to extract
// 2-6 atomic claims, each citing the source blob ID.
//
// Multiple Readers run in parallel (Promise.all in orchestrator). They
// don't share scratch memory across each other intentionally — keeps the
// per-agent namespace story honest.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { MemoryClient } from "../memory.ts";
import type { SnapshotStore } from "../snapshots.ts";
import { searchSources } from "../readers/index.ts";
import type {
  Claim,
  PinnedSource,
  ReaderSnapshot,
  SourceDocument,
  SourceKind,
  SubQuestion,
} from "../types.ts";
import { callForJSON } from "./llm.ts";

export interface ReaderInput {
  reader_id: string; // e.g., "reader-1"
  sub_question: SubQuestion;
  hints?: Partial<Record<SourceKind, string>>;
  starting_claim_id: number; // for stable ids across parallel readers
}

export interface ReaderOutput {
  snapshot: ReaderSnapshot;
  blob_id: string;
  aggregator_url: string;
  claims: Claim[];
}

const READER_SYSTEM = `You are a Reader agent in a verifiable research lab.

You will see ONE source document and ONE sub-question. Extract 2-6 atomic claims that the source supports, with respect to the sub-question.

Output JSON with this exact shape:
{
  "claims": [
    {
      "text": "atomic, self-contained claim — no pronouns, no 'this study'",
      "confidence": 0.0
    }
  ]
}

Rules:
- Each claim must stand on its own without context from the source.
- Claim text is the verifiable assertion only. Do not include "according to..." — the citation is added by the system.
- confidence is 0..1 — your honest read of how strongly the source supports the claim. Don't pad.
- If the source genuinely doesn't address the sub-question, return an empty list. Do not invent claims.
- Quote sparingly. Paraphrase. Stay under ~30 words per claim.`;

export async function runReader(
  deps: {
    anthropic: Anthropic;
    model: string;
    memory: MemoryClient;
    snapshots: SnapshotStore;
    bus: EventBus;
  },
  input: ReaderInput,
): Promise<ReaderOutput | null> {
  const { anthropic, model, memory, snapshots, bus } = deps;
  bus.emit({
    type: "agent.start",
    agent: "reader",
    reader_id: input.reader_id,
    label: `Reader ${input.reader_id}: ${input.sub_question.text}`,
    ts: Date.now(),
  });

  // 1. Pick the first available source kind from the planner's preference.
  let chosen: { kind: SourceKind; doc: SourceDocument } | null = null;
  for (const kind of input.sub_question.preferred_sources) {
    bus.emit({
      type: "trace.step",
      agent: "reader",
      label: `Reader ${input.reader_id}: searching ${kind}`,
      detail: input.sub_question.text,
      ts: Date.now(),
    });
    try {
      const docs = await searchSources({
        query: input.sub_question.text,
        kind,
        hint: input.hints?.[kind],
        maxResults: 3,
      });
      const best = docs.find((d) => d.text && d.text.length > 80);
      if (best) {
        chosen = { kind, doc: best };
        break;
      }
    } catch (err) {
      bus.emit({
        type: "trace.step",
        agent: "reader",
        label: `Reader ${input.reader_id}: ${kind} search failed`,
        detail: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
    }
  }

  if (!chosen) {
    bus.emit({
      type: "trace.step",
      agent: "reader",
      label: `Reader ${input.reader_id}: no usable source`,
      detail: input.sub_question.preferred_sources.join(", "),
      ts: Date.now(),
    });
    bus.emit({ type: "agent.done", agent: "reader", reader_id: input.reader_id, ts: Date.now() });
    return null;
  }

  // 2. Pin the source bytes to Walrus — content addressed.
  bus.emit({
    type: "trace.step",
    agent: "reader",
    label: `Reader ${input.reader_id}: pinning source to Walrus`,
    detail: chosen.doc.title,
    ts: Date.now(),
  });
  const pinnedSource: PinnedSource = await snapshots.pinSource("reader", chosen.doc, bus);

  // 3. Save a working note to reader_scratch (per-agent).
  await memory.remember(
    "reader_scratch",
    "reader",
    `Reader ${input.reader_id} for "${input.sub_question.text}" using ${chosen.kind}: ${chosen.doc.title}. Source blob: ${pinnedSource.blob_id}.`,
    bus,
  );

  // 4. Ask Claude to extract claims grounded in the document.
  bus.emit({
    type: "trace.step",
    agent: "reader",
    label: `Reader ${input.reader_id}: extracting claims`,
    ts: Date.now(),
  });

  const userPrompt = [
    `<sub-question>${input.sub_question.text}</sub-question>`,
    `<source>`,
    `Kind: ${chosen.kind}`,
    `Title: ${chosen.doc.title}`,
    chosen.doc.authors?.length ? `Authors: ${chosen.doc.authors.slice(0, 8).join(", ")}` : "",
    chosen.doc.published_at ? `Published: ${chosen.doc.published_at}` : "",
    `URL: ${chosen.doc.url}`,
    ``,
    chosen.doc.text.slice(0, 6000),
    `</source>`,
  ]
    .filter(Boolean)
    .join("\n");

  type Raw = { claims: Array<{ text: string; confidence: number }> };
  const raw = await callForJSON<Raw>({
    anthropic,
    model,
    system: READER_SYSTEM,
    user: userPrompt,
    max_tokens: 1500,
    bus,
    agent: "reader",
    label: input.reader_id,
  });

  const claims: Claim[] = (raw.claims ?? []).map((c, i) => ({
    id: `c-${input.starting_claim_id + i}`,
    text: c.text,
    supporting_blob_ids: [pinnedSource.blob_id],
    reader_role: input.reader_id,
    confidence: clamp01(c.confidence),
  }));

  // 5. Emit per-claim events and write each to verified_claims (shared).
  for (const claim of claims) {
    bus.emit({ type: "claim.added", agent: "reader", claim, ts: Date.now() });
    await memory.remember(
      "verified_claims",
      "reader",
      `[${claim.id}] (${input.reader_id}, conf=${claim.confidence.toFixed(2)}) ${claim.text} — sources: ${claim.supporting_blob_ids.join(",")}`,
      bus,
    );
  }

  // 6. Pin the Reader snapshot.
  const snapshot: ReaderSnapshot = {
    kind: "reader_snapshot",
    reader_id: input.reader_id,
    sub_question_id: input.sub_question.id,
    source: pinnedSource,
    claims,
    produced_at: new Date().toISOString(),
  };
  const pinned = await snapshots.pinSnapshot("reader", snapshot, bus);

  bus.emit({ type: "agent.done", agent: "reader", reader_id: input.reader_id, ts: Date.now() });
  return {
    snapshot,
    blob_id: pinned.blob_id,
    aggregator_url: pinned.aggregator_url,
    claims,
  };
}

function clamp01(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
