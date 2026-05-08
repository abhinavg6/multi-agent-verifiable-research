// Light shims for the bits of @mysten/seal we touch from seal.ts.
// Kept out of types.ts so the rest of the codebase doesn't have to think
// about Seal at all when LAB_ENABLE_SEAL=false.

export interface SealEncryptResult {
  encryptedObject: ArrayBufferLike | Uint8Array;
}

export interface SealClientLike {
  encrypt(args: {
    threshold: number;
    packageId: string;
    id: string;
    data: Uint8Array;
  }): Promise<SealEncryptResult>;
}

export interface SealPolicy {
  namespace: string;
  agent: string;
  suffix?: string;
}
