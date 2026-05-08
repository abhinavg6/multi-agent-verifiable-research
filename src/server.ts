// Hono server. Endpoints:
//   GET  /              static UI
//   GET  /api/health    Anthropic + MemWal + Walrus + funding-balance status
//   POST /api/run       { question, enabled_sources?, hints? } → SSE event stream

import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";

import { EventBus } from "./events.ts";
import { MemoryClient } from "./memory.ts";
import { WalrusClient } from "./walrus.ts";
import { SealWrapper } from "./seal.ts";
import { SnapshotStore } from "./snapshots.ts";
import { SuiContext, type SuiNetwork } from "./sui-context.ts";
import { runResearchLab } from "./agents/orchestrator.ts";
import { SUPPORTED_KINDS } from "./readers/index.ts";
import type { SourceKind } from "./types.ts";

const PORT = Number(process.env.PORT ?? 3040);
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    console.error(`Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const ANTHROPIC_API_KEY = requiredEnv("ANTHROPIC_API_KEY");
const MEMWAL_ACCOUNT_ID = requiredEnv("MEMWAL_ACCOUNT_ID");
const MEMWAL_DELEGATE_KEY = requiredEnv("MEMWAL_DELEGATE_KEY");
const MEMWAL_SERVER_URL = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai";

const SUI_PRIVATE_KEY = requiredEnv("SUI_PRIVATE_KEY");
const SUI_NETWORK = (process.env.SUI_NETWORK ?? "mainnet") as SuiNetwork;

const WALRUS_AGGREGATOR_URL =
  process.env.WALRUS_AGGREGATOR_URL ??
  (SUI_NETWORK === "testnet"
    ? "https://aggregator.walrus-testnet.walrus.space"
    : "https://aggregator.walrus-mainnet.walrus.space");
const WALRUS_UPLOAD_RELAY_URL =
  process.env.WALRUS_UPLOAD_RELAY_URL ??
  (SUI_NETWORK === "testnet"
    ? "https://upload-relay.testnet.walrus.space"
    : "https://upload-relay.mainnet.walrus.space");
const WALRUS_EPOCHS = Number(process.env.WALRUS_EPOCHS ?? 50);
const WALRUS_UPLOAD_TIP_MAX_MIST = Number(process.env.WALRUS_UPLOAD_TIP_MAX_MIST ?? 10_000_000);

const SEAL_ENABLED = (process.env.LAB_ENABLE_SEAL ?? "false").toLowerCase() === "true";
const SEAL_PACKAGE_ID = process.env.SEAL_PACKAGE_ID;
const SEAL_THRESHOLD = Number(process.env.SEAL_THRESHOLD ?? 2);

// --- wire it up ---

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const memory = new MemoryClient({
  accountId: MEMWAL_ACCOUNT_ID,
  delegateKey: MEMWAL_DELEGATE_KEY,
  serverUrl: MEMWAL_SERVER_URL,
});

const sui = new SuiContext(SUI_NETWORK, SUI_PRIVATE_KEY);
const walrus = new WalrusClient(
  {
    network: SUI_NETWORK,
    aggregatorUrl: WALRUS_AGGREGATOR_URL,
    uploadRelayUrl: WALRUS_UPLOAD_RELAY_URL,
    epochs: WALRUS_EPOCHS,
    uploadTipMaxMist: WALRUS_UPLOAD_TIP_MAX_MIST,
  },
  sui,
);
const seal = new SealWrapper(
  {
    enabled: SEAL_ENABLED,
    packageId: SEAL_PACKAGE_ID,
    threshold: SEAL_THRESHOLD,
  },
  sui,
);
const snapshots = new SnapshotStore(walrus, seal);

const app = new Hono();

app.get("/api/health", async (c) => {
  // Memory
  let memwalOk = false;
  let memwalError: string | undefined;
  try {
    const h = await memory.health();
    memwalOk = h?.status === "ok" || !!h?.version;
  } catch (err) {
    memwalError = err instanceof Error ? err.message : String(err);
  }

  // Walrus aggregator (read path is anonymous, no keypair).
  let walrusOk = false;
  let walrusError: string | undefined;
  try {
    const r = await fetch(`${WALRUS_AGGREGATOR_URL}/v1/blobs/_health_check_`, { method: "GET" });
    walrusOk = r.status >= 200 && r.status < 600;
  } catch (err) {
    walrusError = err instanceof Error ? err.message : String(err);
  }

  // Funding balance — friendlier than waiting for the first writeBlob to fail.
  let funding: { address: string; sui: string; wal: string | null; error?: string };
  try {
    const balances = await sui.balances();
    funding = {
      address: sui.address,
      sui: (Number(balances.sui_mist) / 1e9).toFixed(4),
      wal: balances.wal_mist == null ? null : (Number(balances.wal_mist) / 1e9).toFixed(4),
    };
  } catch (err) {
    funding = {
      address: sui.address,
      sui: "?",
      wal: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return c.json({
    anthropic: { hasKey: !!ANTHROPIC_API_KEY, model: MODEL },
    memwal: {
      ok: memwalOk,
      error: memwalError,
      serverUrl: MEMWAL_SERVER_URL,
      accountId: MEMWAL_ACCOUNT_ID,
    },
    walrus: {
      ok: walrusOk,
      error: walrusError,
      network: SUI_NETWORK,
      aggregator: WALRUS_AGGREGATOR_URL,
      uploadRelay: WALRUS_UPLOAD_RELAY_URL,
      epochs: WALRUS_EPOCHS,
    },
    funding,
    seal: {
      enabled: SEAL_ENABLED,
      packageId: SEAL_PACKAGE_ID ?? null,
      network: SUI_NETWORK,
      threshold: SEAL_THRESHOLD,
    },
    sources: SUPPORTED_KINDS,
  });
});

app.post("/api/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    question?: string;
    enabled_sources?: SourceKind[];
    hints?: Partial<Record<SourceKind, string>>;
    max_readers?: number;
  };
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "missing 'question'" }, 400);
  const enabled = (body.enabled_sources ?? SUPPORTED_KINDS).filter((k) =>
    SUPPORTED_KINDS.includes(k),
  );

  const bus = new EventBus();

  return streamSSE(c, async (stream) => {
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const flush = async (event: unknown) => {
      if (closed) return;
      await stream.writeSSE({ data: JSON.stringify(event) });
    };

    unsubscribe = bus.subscribe((e) => {
      flush(e).catch(() => {});
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe?.();
      bus.close();
    });

    try {
      await runResearchLab(
        { anthropic, model: MODEL, memory, snapshots, bus },
        {
          question,
          enabledSources: enabled,
          hints: body.hints,
          maxReaders: body.max_readers,
        },
      );
      await flush({ type: "done", ts: Date.now() });
    } catch (err) {
      await flush({
        type: "run.error",
        message: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
    } finally {
      closed = true;
      unsubscribe?.();
      bus.close();
    }
  });
});

const PUBLIC_DIR = path.resolve(process.cwd(), "public");
app.get("/", async (c) => {
  const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
  return c.html(html);
});
app.use("/static/*", serveStatic({ root: "./public" }));

console.log(`\nverifiable-research-lab`);
console.log(`  port: ${PORT}`);
console.log(`  model: ${MODEL}`);
console.log(`  memwal relayer: ${MEMWAL_SERVER_URL}`);
console.log(`  walrus network: ${SUI_NETWORK}`);
console.log(`  walrus aggregator: ${WALRUS_AGGREGATOR_URL}`);
console.log(`  walrus upload relay: ${WALRUS_UPLOAD_RELAY_URL}`);
console.log(`  funding address: ${sui.address}`);
console.log(`  seal: ${SEAL_ENABLED ? "ENABLED" : "disabled"}`);
console.log(`\nopen http://localhost:${PORT}\n`);

serve({ fetch: app.fetch, port: PORT });
