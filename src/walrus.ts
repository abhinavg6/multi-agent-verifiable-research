// Walrus client built on @mysten/walrus' WalrusClient.
//
// IMPORTANT — we use the upload-relay path, NOT a publisher:
//   - Publisher: anonymous HTTP PUT; publisher's keypair signs + pays WAL.
//     Production-viable only when you run/control the publisher.
//   - Upload-relay (what we use): CLIENT's keypair signs register + certify
//     and pays WAL; relay only handles encoding + sliver distribution and
//     takes a small on-chain SUI tip to compensate for that work.
//
//   The upload-relay path is the right call for "verifiable AI": every blob
//   is provably attributed to the lab's known address via the on-chain
//   register/certify digests. So we need a funded keypair that pays:
//     - SUI gas on the register + certify transactions
//     - WAL on the storage cost
//     - a small SUI tip to the public-good upload-relay (capped by uploadTipMaxMist)
//
//   Aggregator reads are anonymous HTTP — no keypair needed.
//
// Flow (mirrors MemWal's sidecar; see MemWal/services/server/scripts/walrus-upload.ts):
//   1. encode      — Red Stuff erasure-code the bytes, locally
//   2. register    — Sui txn that creates the Blob object on-chain
//   3. upload      — push the encoded slivers through the upload-relay
//   4. certify     — Sui txn that finalizes durability
//
// We use writeBlobFlow rather than the one-shot writeBlob() because the
// stateful flow lets us sign register and certify with the same keypair we
// supplied; one-shot is more brittle when shared addresses are involved.

import { WalrusClient as WalrusSdk } from "@mysten/walrus";
import type { SuiContext, SuiNetwork } from "./sui-context.ts";
import type { EventBus } from "./events.ts";

export interface WalrusConfig {
  network: SuiNetwork;
  aggregatorUrl: string;
  uploadRelayUrl: string;
  // Storage duration in epochs. ~14 days/epoch on mainnet.
  epochs: number;
  // Cap on the relay tip we'll send (in MIST = 1e-9 SUI). 1e7 = 0.01 SUI.
  uploadTipMaxMist: number;
}

export interface WalrusPutResult {
  blobId: string;
  objectId: string | null;
  registerDigest: string;
  certifyDigest: string;
}

export class WalrusClient {
  private readonly sdk: WalrusSdk;

  // Sui owned-object equivocation prevention.
  //
  // Sui locks owned objects (gas coins, WAL coins, freshly-minted Blob
  // objects) per transaction the moment that transaction is submitted to
  // validators. Two concurrent writeBlobFlow runs from the same keypair
  // — which is exactly what happens when readers run in parallel — will
  // routinely pick the same SUI gas coin (or WAL coin) via the SDK's
  // auto-selection, submit competing transactions, and the validator
  // committee rejects one with "Object … already locked by a different
  // transaction".
  //
  // Cleanest fix at this scale: serialize the on-chain part. Source
  // fetching, LLM calls, and source-text decoding stay parallel; only the
  // four-step writeBlobFlow (encode → register → upload → certify) goes
  // through this mutex so register+certify pairs commit back-to-back from
  // a stable coin set.
  //
  // For higher Walrus throughput, split your SUI gas + WAL into N coins
  // and run N WalrusClient instances each pinned to a disjoint coin set.
  // Out of scope for the sample.
  private inflightChain: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;

  constructor(
    private readonly cfg: WalrusConfig,
    private readonly sui: SuiContext,
  ) {
    this.sdk = new WalrusSdk({
      network: cfg.network,
      // SDK accepts the JSON-RPC client; cast loosens the version-shifty type.
      suiClient: sui.suiClient as any,
      uploadRelay: {
        host: cfg.uploadRelayUrl,
        sendTip: { max: cfg.uploadTipMaxMist },
      },
    });
  }

  /** The aggregator URL anyone can hit to fetch the bytes. */
  aggregatorUrlFor(blobId: string): string {
    return `${this.cfg.aggregatorUrl.replace(/\/$/, "")}/v1/blobs/${blobId}`;
  }

  /**
   * Pin raw bytes. Pays SUI gas + WAL + relay tip from the configured
   * keypair. Serialized within this WalrusClient instance to prevent
   * Sui object-lock equivocation across parallel callers.
   *
   * Pass an optional bus to surface queue-depth events in the trace pane.
   */
  async put(data: Uint8Array, bus?: EventBus): Promise<WalrusPutResult> {
    this.queueDepth += 1;
    const ahead = this.queueDepth - 1;
    if (ahead > 0 && bus) {
      bus.emit({
        type: "trace.step",
        label: `Queued behind ${ahead} Walrus upload${ahead === 1 ? "" : "s"} (Sui equivocation prevention)`,
        ts: Date.now(),
      });
    }
    const pending = this.inflightChain.then(() => this.runFlow(data));
    // Don't break the chain on errors — the next caller still gets a turn.
    this.inflightChain = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await pending;
    } finally {
      this.queueDepth -= 1;
    }
  }

  private async runFlow(data: Uint8Array): Promise<WalrusPutResult> {
    try {
      const flow = this.sdk.writeBlobFlow({ blob: data });

      // 1. Encode (no signing).
      await flow.encode();

      // 2. Register on Sui — sender = signer = owner avoids mismatch errors
      //    when the Blob object is shared across addresses.
      const ownerAddress = this.sui.address;
      const registerTx = flow.register({
        epochs: this.cfg.epochs,
        owner: ownerAddress,
        deletable: true,
      });
      const registerResult = await this.sui.suiClient.signAndExecuteTransaction({
        signer: this.sui.keypair,
        transaction: registerTx,
      });

      // 3. Upload encoded slivers to the relay.
      await flow.upload({ digest: registerResult.digest });

      // 4. Certify on Sui — the durability finalizer.
      const certifyTx = flow.certify();
      const certifyResult = await this.sui.suiClient.signAndExecuteTransaction({
        signer: this.sui.keypair,
        transaction: certifyTx,
      });

      const blob = await flow.getBlob();
      const objectId =
        (blob as any)?.blobObject?.id?.id ??
        (blob as any)?.blobObject?.id ??
        null;
      return {
        blobId: blob.blobId,
        objectId: typeof objectId === "string" ? objectId : null,
        registerDigest: registerResult.digest,
        certifyDigest: certifyResult.digest,
      };
    } catch (err) {
      // Specifically annotate the equivocation case so the user knows
      // it's not a "retry the same call" situation — the lock needs to
      // clear before another transaction can reuse those coins.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("already locked by a different transaction") ||
        msg.includes("Transaction status expired")
      ) {
        throw new Error(
          `Walrus upload failed due to Sui object-lock equivocation. This means another transaction from the same keypair (likely a parallel run, or a hung process from a previous run) has the gas/WAL coin locked. ` +
            `If only one lab instance is running, wait ~30 seconds for the lock to clear, then retry. ` +
            `If multiple are running, stop the others. ` +
            `Original error: ${msg}`,
        );
      }
      throw err;
    }
  }

  /** Fetch bytes from the aggregator. No auth, no keypair. */
  async get(blobId: string): Promise<Uint8Array> {
    const resp = await fetch(this.aggregatorUrlFor(blobId));
    if (!resp.ok) {
      throw new Error(`Walrus GET failed (${resp.status}): ${await resp.text()}`);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }
}
