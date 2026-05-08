// Shared Sui keypair + JSON-RPC client used by Walrus uploads and Seal.
//
// One funded keypair backs the whole lab. It's the address that:
//   - pays SUI gas for the register + certify transactions on every blob
//   - holds the WAL coin balance the storage cost is charged from
//   - holds the Sui balance the upload-relay tip is charged from
//
// Aggregator GETs (read path) are still anonymous HTTP — no keypair needed
// to fetch a blob anyone has pinned.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

export type SuiNetwork = "mainnet" | "testnet";

export class SuiContext {
  readonly suiClient: SuiJsonRpcClient;
  readonly keypair: Ed25519Keypair;
  readonly network: SuiNetwork;
  readonly address: string;

  constructor(network: SuiNetwork, suiPrivateKeyBech32: string) {
    this.network = network;
    const { secretKey } = decodeSuiPrivateKey(suiPrivateKeyBech32);
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    this.suiClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(network),
      network,
    });
    this.address = this.keypair.toSuiAddress();
  }

  /** Cheap balance check used at startup for friendlier errors. */
  async balances(): Promise<{ sui_mist: bigint; wal_mist: bigint | null }> {
    const sui = await this.suiClient.getBalance({
      owner: this.address,
      coinType: "0x2::sui::SUI",
    });
    let wal: bigint | null = null;
    try {
      const walType =
        this.network === "mainnet"
          ? // WAL on mainnet — Walrus protocol's own token
            "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL"
          : "0x8190b041122eb492bf63cb464476bd68c6b7e570a4079645a8b28732b6197a82::wal::WAL";
      const balance = await this.suiClient.getBalance({
        owner: this.address,
        coinType: walType,
      });
      wal = BigInt(balance.totalBalance);
    } catch {
      // WAL coin type can change across testnet rotations; not finding it is
      // not fatal — uploads will fail with a clearer error if WAL is short.
      wal = null;
    }
    return {
      sui_mist: BigInt(sui.totalBalance),
      wal_mist: wal,
    };
  }
}
