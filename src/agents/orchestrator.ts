// Orchestrator: planner → parallel readers → critic → synthesizer.
//
// Each agent's state snapshot is pinned to Walrus before the next agent
// picks it up. The orchestrator itself never holds the canonical state in
// memory between phases — it always references the snapshot blob ids, so a
// crash mid-run can be resumed (in principle) from the trace alone.

import Anthropic from "@anthropic-ai/sdk";
import type { EventBus } from "../events.ts";
import type { MemoryClient } from "../memory.ts";
import type { SnapshotStore } from "../snapshots.ts";
import type {
  Claim,
  ReaderSnapshot,
  SourceKind,
} from "../types.ts";
import { runPlanner } from "./planner.ts";
import { runReader } from "./reader.ts";
import { runCritic } from "./critic.ts";
import { runSynthesizer } from "./synthesizer.ts";
import { SUPPORTED_KINDS } from "../readers/index.ts";

export interface OrchestratorDeps {
  anthropic: Anthropic;
  model: string;
  memory: MemoryClient;
  snapshots: SnapshotStore;
  bus: EventBus;
}

export interface OrchestratorInput {
  question: string;
  enabledSources?: SourceKind[];
  hints?: Partial<Record<SourceKind, string>>;
  // Optional cap on parallel readers — usually equals sub-question count.
  maxReaders?: number;
}

export interface OrchestratorOutput {
  planner_blob_id: string;
  reader_blob_ids: string[];
  critic_blob_id: string;
  synthesizer_blob_id: string;
  final_report: string;
  claim_index: Array<{ claim_id: string; blob_ids: string[] }>;
}

export async function runResearchLab(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
): Promise<OrchestratorOutput> {
  const enabled = input.enabledSources ?? SUPPORTED_KINDS;
  const maxReaders = input.maxReaders ?? 6;

  deps.bus.emit({ type: "run.user", question: input.question, ts: Date.now() });

  // 1. Planner
  const planner = await runPlanner(deps, {
    question: input.question,
    enabledSources: enabled,
    hints: input.hints,
  });

  // 2. Parallel Readers — one per sub-question, capped.
  const subs = planner.snapshot.sub_questions.slice(0, maxReaders);
  let nextClaimId = 1;
  const readerInputs = subs.map((sq, i) => {
    const starting = nextClaimId;
    // Reserve up to 6 ids per reader; keeps ids stable even if some readers
    // produce fewer or zero claims.
    nextClaimId += 6;
    return {
      reader_id: `reader-${i + 1}`,
      sub_question: sq,
      hints: input.hints,
      starting_claim_id: starting,
    };
  });

  deps.bus.emit({
    type: "trace.step",
    label: `Dispatching ${readerInputs.length} parallel Readers`,
    ts: Date.now(),
  });
  const readerResults = await Promise.all(
    readerInputs.map((ri) => runReader(deps, ri).catch((err) => {
      deps.bus.emit({
        type: "trace.step",
        agent: "reader",
        label: `Reader ${ri.reader_id} failed`,
        detail: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
      return null;
    })),
  );
  const readerSnapshots: ReaderSnapshot[] = [];
  const readerBlobIds: string[] = [];
  const allClaims: Claim[] = [];
  for (const r of readerResults) {
    if (!r) continue;
    readerSnapshots.push(r.snapshot);
    readerBlobIds.push(r.blob_id);
    allClaims.push(...r.claims);
  }
  if (allClaims.length === 0) {
    const dispatched = readerInputs.length;
    const succeeded = readerResults.filter((r) => r !== null).length;
    const errored = dispatched - succeeded;
    const empty = succeeded; // succeeded but produced 0 claims (since allClaims is empty)
    throw new Error(
      `All ${dispatched} Reader(s) failed to produce claims (${errored} errored, ${empty} returned no usable source). ` +
        `Common causes: insufficient SUI/WAL balance on the funding wallet, upload-relay unavailable, ` +
        `or all source APIs returned no matches for the sub-questions. ` +
        `Check the trace pane for the specific failure on each Reader.`,
    );
  }

  // 3. Critic
  const critic = await runCritic(deps, {
    question: input.question,
    claims: allClaims,
  });

  // 4. Synthesizer
  const synth = await runSynthesizer(deps, {
    question: input.question,
    claims: allClaims, // Critic flags were written in place
    critic_notes: critic.snapshot.notes,
  });

  deps.bus.emit({
    type: "run.final",
    report_markdown: synth.snapshot.report_markdown,
    final_snapshot_blob_id: synth.blob_id,
    aggregator_url: synth.aggregator_url,
    ts: Date.now(),
  });

  return {
    planner_blob_id: planner.blob_id,
    reader_blob_ids: readerBlobIds,
    critic_blob_id: critic.blob_id,
    synthesizer_blob_id: synth.blob_id,
    final_report: synth.snapshot.report_markdown,
    claim_index: synth.snapshot.claim_index,
  };
}
