// Shared types for the multi-agent research lab.
//
// The lab has four agent roles plus an orchestrator. Memory is split across a
// shared namespace (verified_claims) that everyone reads + writes, and
// per-agent scratch namespaces that isolate intermediate work. Walrus acts as
// the verifiable-storage layer: every fetched source is content-addressed,
// and every agent's state snapshot is pinned before the next agent picks it
// up so the trace can be replayed deterministically by anyone.

export type AgentRole =
  | "planner"
  | "reader"
  | "critic"
  | "synthesizer";

// Memory namespaces.
//   verified_claims  — shared write/read; the canonical claim graph
//   planner_plan     — planner's decomposition + assignment per question
//   reader_scratch   — each Reader's working notes per source
//   critic_notes     — Critic's flags and challenges
//   synth_outputs    — Synthesizer's drafts and final reports
export type Namespace =
  | "verified_claims"
  | "planner_plan"
  | "reader_scratch"
  | "critic_notes"
  | "synth_outputs";

export const NAMESPACES: Namespace[] = [
  "verified_claims",
  "planner_plan",
  "reader_scratch",
  "critic_notes",
  "synth_outputs",
];

export const NAMESPACE_DESCRIPTIONS: Record<Namespace, string> = {
  verified_claims:
    "Shared by all agents. One memory per atomic claim with the supporting Walrus blob ID(s) and a confidence score. The Critic vetoes here; the Synthesizer reads from here.",
  planner_plan:
    "Planner's decomposition of the research question into sub-questions and per-source assignments.",
  reader_scratch:
    "Per-Reader working notes for one source — quotes pulled, sections summarized, blob IDs of the source bytes. Other agents can recall but rarely write here.",
  critic_notes:
    "Critic's structured challenges to specific claim IDs — what's contested, what's missing, what's hedged.",
  synth_outputs:
    "Synthesizer's drafts and the final report. Each entry references the verified_claims it draws from.",
};

// --- Source readers ---

export type SourceKind = "arxiv" | "wikipedia" | "openalex" | "pubmed" | "github" | "rss";

export interface SourceDocument {
  kind: SourceKind;
  url: string;
  title: string;
  authors?: string[];
  published_at?: string; // ISO 8601 if known
  text: string;
  fetched_at: string; // ISO 8601
}

export interface PinnedSource {
  // The original document, materialized.
  doc: SourceDocument;
  // Walrus blob ID for the canonical bytes used by the Readers (UTF-8 JSON of doc).
  blob_id: string;
  // Aggregator URL where anyone can fetch the bytes.
  aggregator_url: string;
}

// --- Claims ---
//
// Atomic claims are the unit of verifiability. Each claim points to one or
// more source blob IDs that justify it, and may carry a Critic flag.

export interface Claim {
  id: string; // stable id used across agents (e.g., "c-3")
  text: string;
  supporting_blob_ids: string[]; // Walrus blob IDs of sources
  reader_role?: string; // which Reader produced it
  critic_flag?: {
    severity: "info" | "warn" | "block";
    reason: string;
  };
  confidence: number; // 0..1, Reader's self-assessment
}

// --- Agent snapshots ---
//
// Between handoffs we serialize the relevant agent state and pin it to
// Walrus. Downstream agents reference the snapshot blob ID rather than the
// raw structure, so the trace pane can deep-link any step to its bytes.

export interface PlannerSnapshot {
  kind: "planner_snapshot";
  question: string;
  sub_questions: SubQuestion[];
  rationale: string;
  produced_at: string;
}

export interface SubQuestion {
  id: string;
  text: string;
  preferred_sources: SourceKind[];
}

export interface ReaderSnapshot {
  kind: "reader_snapshot";
  reader_id: string;
  sub_question_id: string;
  source: PinnedSource;
  claims: Claim[];
  produced_at: string;
}

export interface CriticSnapshot {
  kind: "critic_snapshot";
  flagged_claim_ids: string[];
  notes: string;
  produced_at: string;
}

export interface SynthesizerSnapshot {
  kind: "synth_snapshot";
  question: string;
  report_markdown: string;
  // Each claim referenced in the report, mapped to its supporting blob IDs.
  claim_index: Array<{ claim_id: string; blob_ids: string[] }>;
  produced_at: string;
}

export type AnySnapshot =
  | PlannerSnapshot
  | ReaderSnapshot
  | CriticSnapshot
  | SynthesizerSnapshot;

// --- Trace events ---

export interface TraceStepEvent {
  type: "trace.step";
  label: string;
  detail?: string;
  agent?: AgentRole;
  ts: number;
}

export interface MemoryReadEvent {
  type: "memory.read";
  namespace: Namespace;
  agent: AgentRole;
  query: string;
  results: Array<{ blob_id: string; text: string; distance: number }>;
  ts: number;
}

export interface MemoryWriteEvent {
  type: "memory.write";
  namespace: Namespace;
  agent: AgentRole;
  text: string;
  blob_id?: string;
  job_id: string;
  status: "submitted" | "done" | "failed";
  ts: number;
}

export interface SourcePinnedEvent {
  type: "source.pinned";
  agent: AgentRole;
  source_kind: SourceKind;
  url: string;
  title: string;
  blob_id: string;
  aggregator_url: string;
  bytes: number;
  // On-chain provenance from @mysten/walrus' writeBlobFlow.
  object_id?: string | null;
  register_digest?: string;
  certify_digest?: string;
  ts: number;
}

export interface SnapshotPinnedEvent {
  type: "snapshot.pinned";
  agent: AgentRole;
  snapshot_kind: AnySnapshot["kind"];
  blob_id: string;
  aggregator_url: string;
  bytes: number;
  encrypted: boolean;
  object_id?: string | null;
  register_digest?: string;
  certify_digest?: string;
  ts: number;
}

export interface ClaimEvent {
  type: "claim.added";
  agent: AgentRole;
  claim: Claim;
  ts: number;
}

export interface ClaimFlaggedEvent {
  type: "claim.flagged";
  agent: AgentRole;
  claim_id: string;
  severity: "info" | "warn" | "block";
  reason: string;
  ts: number;
}

export interface AgentStartEvent {
  type: "agent.start";
  agent: AgentRole;
  reader_id?: string; // for parallel readers
  label: string;
  ts: number;
}

export interface AgentDoneEvent {
  type: "agent.done";
  agent: AgentRole;
  reader_id?: string;
  ts: number;
}

export interface RunUserEvent {
  type: "run.user";
  question: string;
  ts: number;
}

export interface RunFinalEvent {
  type: "run.final";
  report_markdown: string;
  final_snapshot_blob_id: string;
  aggregator_url: string;
  ts: number;
}

export interface RunErrorEvent {
  type: "run.error";
  message: string;
  ts: number;
}

export type AgentEvent =
  | TraceStepEvent
  | MemoryReadEvent
  | MemoryWriteEvent
  | SourcePinnedEvent
  | SnapshotPinnedEvent
  | ClaimEvent
  | ClaimFlaggedEvent
  | AgentStartEvent
  | AgentDoneEvent
  | RunUserEvent
  | RunFinalEvent
  | RunErrorEvent;
