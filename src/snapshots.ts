// Snapshot store: pins agent state to Walrus (optionally Seal-encrypted)
// between handoffs so each downstream agent picks up its predecessor's work
// from a verifiable, content-addressed blob rather than from in-memory state.
//
// This is the "verifiable AI" hero: the trace pane can deep-link any agent
// step to the exact bytes that step produced.

import type { EventBus } from "./events.ts";
import type {
  AgentRole,
  AnySnapshot,
  PinnedSource,
  SourceDocument,
} from "./types.ts";
import { WalrusClient } from "./walrus.ts";
import { SealWrapper } from "./seal.ts";

export interface PinnedSnapshot<T extends AnySnapshot = AnySnapshot> {
  blob_id: string;
  aggregator_url: string;
  bytes: number;
  encrypted: boolean;
  snapshot: T;
}

export class SnapshotStore {
  constructor(
    private readonly walrus: WalrusClient,
    private readonly seal: SealWrapper,
  ) {}

  async pinSource(
    agent: AgentRole,
    doc: SourceDocument,
    bus?: EventBus,
  ): Promise<PinnedSource> {
    // Source bytes are public — never encrypted, even when LAB_ENABLE_SEAL=true.
    // The whole point is that anyone can re-fetch and verify them.
    const text = JSON.stringify(doc);
    const bytes = new TextEncoder().encode(text);
    const result = await this.walrus.put(bytes, bus);
    const aggregator_url = this.walrus.aggregatorUrlFor(result.blobId);
    bus?.emit({
      type: "source.pinned",
      agent,
      source_kind: doc.kind,
      url: doc.url,
      title: doc.title,
      blob_id: result.blobId,
      aggregator_url,
      bytes: bytes.byteLength,
      object_id: result.objectId,
      register_digest: result.registerDigest,
      certify_digest: result.certifyDigest,
      ts: Date.now(),
    });
    return { doc, blob_id: result.blobId, aggregator_url };
  }

  async pinSnapshot<T extends AnySnapshot>(
    agent: AgentRole,
    snapshot: T,
    bus?: EventBus,
  ): Promise<PinnedSnapshot<T>> {
    const text = JSON.stringify(snapshot);
    const plaintext = new TextEncoder().encode(text);
    const wrapped = await this.seal.wrap(plaintext, {
      namespace: "snapshots",
      agent,
      suffix: snapshot.kind,
    });
    const result = await this.walrus.put(wrapped.bytes, bus);
    const aggregator_url = this.walrus.aggregatorUrlFor(result.blobId);
    bus?.emit({
      type: "snapshot.pinned",
      agent,
      snapshot_kind: snapshot.kind,
      blob_id: result.blobId,
      aggregator_url,
      bytes: wrapped.bytes.byteLength,
      encrypted: wrapped.encrypted,
      object_id: result.objectId,
      register_digest: result.registerDigest,
      certify_digest: result.certifyDigest,
      ts: Date.now(),
    });
    return {
      blob_id: result.blobId,
      aggregator_url,
      bytes: wrapped.bytes.byteLength,
      encrypted: wrapped.encrypted,
      snapshot,
    };
  }
}
