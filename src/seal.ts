// Optional Seal encryption layer for agent state snapshots.
//
// Source bytes from public APIs are NEVER encrypted — they were already
// public, and encrypting them would only weaken the verifiable-citation
// story. Snapshots are the units that benefit from privacy when the lab is
// run against sensitive questions where the *plan*, *critic notes*, and
// *report* shouldn't be world-readable even if the cited sources are.
//
// When LAB_ENABLE_SEAL=true:
//   - Snapshots are encrypted via @mysten/seal against the configured
//     policy package + threshold key servers
//   - Policy id is scoped by (namespace, agent role, snapshot kind) so a
//     delegate authorized for one agent's snapshots cannot decrypt another's
//   - Uses the same SuiContext as the Walrus uploader — one keypair, one
//     gas cost story
//
// When LAB_ENABLE_SEAL=false (default): wrap() is a pass-through. The lab
// runs end-to-end on Walrus alone with no Seal install required.

import type { SealClientLike, SealPolicy } from "./types-seal.ts";
import type { SuiContext } from "./sui-context.ts";

export interface SealConfig {
  enabled: boolean;
  packageId?: string;
  threshold: number;
  // Optional override; defaults shipped with @mysten/seal.
  keyServerObjectIds?: string[];
}

const DEFAULT_KEY_SERVERS: Record<string, string[]> = {
  mainnet: [
    "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6",
    "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10",
  ],
  testnet: [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
  ],
};

export class SealWrapper {
  private clientPromise: Promise<SealClientLike | null> | null = null;

  constructor(
    private readonly cfg: SealConfig,
    private readonly sui: SuiContext,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async wrap(plaintext: Uint8Array, policy: SealPolicy): Promise<{ bytes: Uint8Array; encrypted: boolean }> {
    if (!this.cfg.enabled) {
      return { bytes: plaintext, encrypted: false };
    }
    if (!this.cfg.packageId) {
      throw new Error(
        "SealWrapper: LAB_ENABLE_SEAL=true but SEAL_PACKAGE_ID is missing. " +
          "Set the package id of a deployed seal_approve module (or unset LAB_ENABLE_SEAL).",
      );
    }
    const seal = await this.getClient();
    if (!seal) {
      throw new Error(
        "SealWrapper: @mysten/seal failed to load. Run `npm i @mysten/seal` to enable encryption.",
      );
    }
    const id = buildPolicyId(policy);
    const result = await seal.encrypt({
      threshold: this.cfg.threshold,
      packageId: this.cfg.packageId,
      id,
      data: plaintext,
    });
    const enc = result.encryptedObject;
    const bytes = enc instanceof Uint8Array ? enc : new Uint8Array(enc as ArrayBuffer);
    return { bytes, encrypted: true };
  }

  private async getClient(): Promise<SealClientLike | null> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async (): Promise<SealClientLike | null> => {
      try {
        // @ts-ignore — optional dep
        const { SealClient } = await import("@mysten/seal");
        const keyServers =
          this.cfg.keyServerObjectIds ??
          DEFAULT_KEY_SERVERS[this.sui.network] ??
          [];
        if (keyServers.length === 0) {
          throw new Error(`No SEAL key servers configured for ${this.sui.network}`);
        }
        return new SealClient({
          suiClient: this.sui.suiClient as any,
          serverConfigs: keyServers.map((id) => ({ objectId: id, weight: 1 })),
          verifyKeyServers: true,
        });
      } catch {
        return null;
      }
    })();
    return this.clientPromise;
  }
}

function buildPolicyId(policy: SealPolicy): string {
  const text = `${policy.namespace}|${policy.agent}|${policy.suffix ?? ""}`;
  return bytesToHex(new TextEncoder().encode(text));
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
