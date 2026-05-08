// Planner agent.
// Decomposes the user's research question into 2–5 sub-questions and assigns
// preferred sources to each. Snapshot is pinned to Walrus before Readers
// pick it up, so the trace can deep-link the plan that drove this run.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { MemoryClient } from "../memory.ts";
import type { SnapshotStore } from "../snapshots.ts";
import type {
  PlannerSnapshot,
  SourceKind,
  SubQuestion,
} from "../types.ts";
import { callForJSON } from "./llm.ts";

export interface PlannerInput {
  question: string;
  enabledSources: SourceKind[];
  // Optional hints for source-bound readers (e.g. github "owner/repo", rss URL)
  hints?: Partial<Record<SourceKind, string>>;
}

export interface PlannerOutput {
  snapshot: PlannerSnapshot;
  blob_id: string;
  aggregator_url: string;
}

const PLANNER_SYSTEM = `You are the Planner in a multi-agent verifiable research lab.

Your job: take the user's research question and decompose it into 2-5 atomic sub-questions, each of which a single Reader agent can investigate against ONE source. Diversify which source serves which sub-question so the final report draws on multiple kinds of evidence.

Available source kinds: ARXIV (CS/physics/bio papers), WIKIPEDIA (general knowledge), OPENALEX (cross-disciplinary academic), PUBMED (biomedical via Europe PMC), GITHUB (public repo READMEs), RSS (blog/news feed).

Output JSON with this exact shape:
{
  "rationale": "one to three sentences explaining the decomposition strategy",
  "sub_questions": [
    {
      "id": "sq-1",
      "text": "self-contained sub-question",
      "preferred_sources": ["arxiv", "openalex"]
    }
  ]
}

Rules:
- Sub-question text MUST be self-contained — a Reader will see only the sub-question, not the original question.
- preferred_sources is an ordered list (most preferred first). Use only sources from the enabled list provided.
- Don't ask sub-questions that all need the same source — the value of the lab is parallel reads across diverse evidence.
- Keep it to 2-5 sub-questions. Quality > quantity.`;

export async function runPlanner(
  deps: {
    anthropic: Anthropic;
    model: string;
    memory: MemoryClient;
    snapshots: SnapshotStore;
    bus: EventBus;
  },
  input: PlannerInput,
): Promise<PlannerOutput> {
  const { anthropic, model, memory, snapshots, bus } = deps;
  bus.emit({ type: "agent.start", agent: "planner", label: "Planner: decomposing question", ts: Date.now() });

  // Pull any prior planning notes for this question shape (cheap recall).
  const prior = await memory.recall("planner_plan", "planner", input.question, 3, bus);
  const priorBlock =
    prior.length === 0
      ? "<prior-plans>None</prior-plans>"
      : `<prior-plans>\n${prior.map((p) => `- ${p.text}`).join("\n")}\n</prior-plans>`;

  const userPrompt = [
    `<question>${input.question}</question>`,
    `<enabled-sources>${input.enabledSources.join(", ")}</enabled-sources>`,
    priorBlock,
  ].join("\n\n");

  type Raw = {
    rationale: string;
    sub_questions: Array<{ id?: string; text: string; preferred_sources: string[] }>;
  };

  bus.emit({ type: "trace.step", agent: "planner", label: "Calling Claude (planner)", ts: Date.now() });
  const raw = await callForJSON<Raw>({
    anthropic,
    model,
    system: PLANNER_SYSTEM,
    user: userPrompt,
    max_tokens: 1500,
    bus,
    agent: "planner",
    label: "planner",
  });

  const enabled = new Set(input.enabledSources);
  const subs: SubQuestion[] = (raw.sub_questions ?? []).map((s, i) => ({
    id: s.id ?? `sq-${i + 1}`,
    text: s.text,
    preferred_sources: (s.preferred_sources ?? [])
      .map((k) => k.toLowerCase() as SourceKind)
      .filter((k) => enabled.has(k)),
  }));

  if (subs.length === 0) {
    throw new Error("Planner returned no usable sub-questions.");
  }

  const snapshot: PlannerSnapshot = {
    kind: "planner_snapshot",
    question: input.question,
    sub_questions: subs,
    rationale: raw.rationale ?? "",
    produced_at: new Date().toISOString(),
  };

  // Pin plan to Walrus and write a memory pointer in planner_plan.
  bus.emit({ type: "trace.step", agent: "planner", label: "Pinning plan to Walrus", ts: Date.now() });
  const pinned = await snapshots.pinSnapshot("planner", snapshot, bus);

  await memory.remember(
    "planner_plan",
    "planner",
    `Plan for "${input.question}" → ${subs.length} sub-questions. Snapshot blob: ${pinned.blob_id}.`,
    bus,
  );

  bus.emit({ type: "agent.done", agent: "planner", ts: Date.now() });
  return {
    snapshot,
    blob_id: pinned.blob_id,
    aggregator_url: pinned.aggregator_url,
  };
}
