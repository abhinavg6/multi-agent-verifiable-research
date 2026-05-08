# Multi-Agent Verifiable Research Lab

A small, self-contained research workflow that turns a free-text question into a citation-grounded report — built on Anthropic Claude for reasoning, **MemWal** for memory, **Walrus** for verifiable storage, and (optionally) **Seal** for snapshot encryption.

Every fetched source is content-addressed on Walrus, every per-agent state snapshot is pinned before the next agent picks it up, and every claim in the final report is a clickable citation that resolves to the exact bytes on the public-good Walrus aggregator. The trace pane shows the whole orchestration in real time.

## Architecture

```
                                 ┌──────────────────────────────┐
       user question  ───────▶   │           Planner            │
                                 │  decompose into N sub-Qs     │
                                 │  pin plan snapshot to Walrus │
                                 └─────────────┬────────────────┘
                                               │  (Walrus blob)
                  ┌────────────────────────────┼────────────────────────────┐
                  ▼                            ▼                            ▼
       ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
       │     Reader 1       │       │     Reader 2       │  ...  │     Reader N       │
       │  fetch one source  │       │  fetch one source  │       │  fetch one source  │
       │  pin source bytes  │       │  pin source bytes  │       │  pin source bytes  │
       │  extract claims    │       │  extract claims    │       │  extract claims    │
       │  pin reader snap.  │       │  pin reader snap.  │       │  pin reader snap.  │
       └─────────┬──────────┘       └─────────┬──────────┘       └─────────┬──────────┘
                 │                            │                            │
                 └────────────────────────────┼────────────────────────────┘
                                              │  (claims → MemWal/verified_claims)
                                              ▼
                                  ┌────────────────────────────┐
                                  │           Critic           │
                                  │  challenge each claim      │
                                  │  block / warn / info       │
                                  │  pin critic snapshot       │
                                  └─────────────┬──────────────┘
                                                │  (flags → MemWal/critic_notes)
                                                ▼
                                  ┌────────────────────────────┐
                                  │        Synthesizer         │
                                  │  drop blocks, hedge warns  │
                                  │  write report w/ [c-id]    │
                                  │  pin final snapshot        │
                                  └────────────────────────────┘
```

## The agents

**Planner.** Receives the user's question and the list of enabled source kinds. Decomposes the question into 2–5 self-contained sub-questions, each with an ordered list of preferred sources. Diversifies sources across sub-questions so the final report draws on multiple kinds of evidence. Pins its plan snapshot to Walrus and a one-line index entry into `MemWal/planner_plan`.

**Readers (parallel).** One per sub-question. Each Reader walks the planner's preferred-source list, fetches candidate documents, picks the best, and pins the source bytes to Walrus as a content-addressed blob. It then asks Claude to extract 2–6 atomic, self-contained claims from the source — each claim citing the source blob ID and carrying a confidence score. Each claim is written into the shared `MemWal/verified_claims` namespace; a per-reader working note goes into `MemWal/reader_scratch`. Finally the Reader pins its own state snapshot (sub-question + source + claims) to Walrus.

Sources supported (all free, no auth): **arXiv**, **Wikipedia**, **OpenAlex**, **Europe PMC**, **GitHub README**, **arbitrary RSS**.

**Critic.** Reads the full claim set from `MemWal/verified_claims` and adversarially challenges it. For each problem claim it emits a flag:

- `block` — materially wrong or unsupported by the cited source. Synthesizer drops it.
- `warn` — needs hedging or caveat (uncertainty, scope, freshness). Synthesizer hedges it.
- `info` — useful context but doesn't change the verdict. Used sparingly.

Flags get written into `MemWal/critic_notes` and stamped onto the in-flight claim records. The Critic pins a snapshot with the flagged claim ids and a one-paragraph overall observation.

**Synthesizer.** Reads from `MemWal/verified_claims` + `MemWal/critic_notes`, drops every `block` claim, hedges every `warn` claim, and writes a concise markdown report. Every factual sentence carries an inline `[c-id]` citation. The UI turns each `[c-id]` into a clickable link to the Walrus blob that justifies it. The final snapshot — question, report, claim-id → blob-id index — is pinned to Walrus and indexed in `MemWal/synth_outputs`.

## Orchestration

The orchestrator never holds canonical state in memory between phases. After each phase it pins a Walrus snapshot and lets the next phase pick up by reference. The flow:

1. **Planner** runs. Plan snapshot is pinned. Sub-questions get split into reader inputs with disjoint claim-id ranges (`c-1…c-6`, `c-7…c-12`, …) so claim ids stay stable across parallel readers.
2. **Readers** are dispatched via `Promise.all`. Source fetching, source-byte pinning, claim extraction, and per-reader snapshot pinning all happen concurrently across readers. If a Reader fails (no source matched, source API down, etc.) it's skipped; the run only aborts if **every** Reader returns empty.
3. **Critic** runs once over the union of all readers' claims. It writes flags into the shared namespace so the Synthesizer sees them on recall.
4. **Synthesizer** runs last. Cross-namespace grounding pulls a few hits from each MemWal namespace into context. The output report and snapshot are pinned, and a `run.final` event is emitted with the report markdown + final snapshot blob id for the UI.

Every step emits trace events on a per-run event bus that the SSE handler streams to the browser, so the UI shows what each agent is doing in real time.

## Memory: MemWal

The lab uses **plain `MemWal` mode** (managed relayer), not `MemWalManual`. The relayer covers gas for memory ops, so the memory path needs nothing but two credentials. Five namespaces:

| Namespace          | Owner          | Purpose                                                           |
| ------------------ | -------------- | ----------------------------------------------------------------- |
| `verified_claims`  | shared         | Atomic claims with their supporting Walrus blob IDs.              |
| `planner_plan`     | Planner        | Decomposition + sub-question assignments per question.            |
| `reader_scratch`   | Readers        | Per-reader source picks and working notes.                        |
| `critic_notes`     | Critic         | Flagged claims with severity + reason.                            |
| `synth_outputs`    | Synthesizer    | Final-report pointers (snapshot blob IDs).                        |

The shared `verified_claims` namespace is the multi-agent collaboration point: the Critic vetoes here, the Synthesizer reads here, and future runs can recall prior verified claims for related questions. Per-agent namespaces let agents think out loud without polluting the shared graph.

## Verifiable storage: Walrus

Two kinds of bytes get pinned to Walrus:

1. **Source bytes** — every fetched source document is JSON-serialized and pinned. Always plaintext, even with Seal enabled, because the value is making the citation publicly verifiable.
2. **Agent snapshots** — planner, every reader, critic, synthesizer. Optionally Seal-encrypted.

Each pin uses `@mysten/walrus`'s `writeBlobFlow` (encode → register → upload → certify). The lab emits a `source.pinned` or `snapshot.pinned` event with the Walrus blob ID, the public aggregator URL, and the on-chain object id + register/certify transaction digests, so the trace pane can deep-link the full audit trail.

The aggregator (read path) is anonymous — anyone can fetch any pinned blob from `https://aggregator.walrus-mainnet.walrus.space/v1/blobs/{id}` without a keypair. So the citation-verification side of the demo stays fully public.

## Optional encryption: Seal

When `LAB_ENABLE_SEAL=true`, agent state snapshots are encrypted via `@mysten/seal` before being pinned. Source bytes are never encrypted — they came from public APIs; encrypting them would weaken the verifiable-citation story.

The policy id is scoped by `(namespace, agent role, snapshot kind)` so a delegate authorized for one agent's snapshots cannot decrypt another's. Requires `SEAL_PACKAGE_ID` (a deployed `seal_approve` module) and reuses the same Sui keypair that funds Walrus uploads.

`@mysten/seal` is an `optionalDependencies` entry — leave `LAB_ENABLE_SEAL=false` and it's never loaded.

## Funding for Walrus

Walrus storage isn't free: it's paid in **WAL** by the *uploading* address. The lab uses one funded keypair (`SUI_PRIVATE_KEY`) for all Walrus uploads. That address pays:

- **SUI gas** on the `register` and `certify` transactions of every blob
- **WAL** on the storage cost (proportional to size × epochs)
- A small **SUI tip** to the public-good upload-relay for encoding + sliver distribution

`/api/health` reports the funding address and live SUI / WAL balances so you can spot a drained wallet before kicking off a run.

How to fund:

- **Mainnet** — buy WAL on any exchange that supports it, or buy SUI and swap to WAL. Export the bech32 private key (`suiprivkey1…`) into `SUI_PRIVATE_KEY`. About 0.5 SUI + 1 WAL covers many runs (gas dominates over storage at this scale).
- **Testnet** — set `SUI_NETWORK=testnet` and switch the aggregator/upload-relay URLs to their `*-testnet.walrus.space` variants. SUI faucet at <https://faucet.sui.io>; WAL via `walrus get-wal`.

The MemWal *memory* path is funded separately by the MemWal managed relayer — the keypair only pays for Walrus pins.

> **One caveat.** Walrus uploads from the same keypair are serialized within the lab process (a small mutex around `WalrusClient.put`). This is to avoid Sui's owned-object equivocation guard, which rejects parallel transactions from the same address that race on the same gas/WAL coin. Reader source-fetching and Claude calls stay parallel; only the on-chain part of the upload is serial. For higher throughput, pre-split your SUI/WAL into N coins and run N `WalrusClient` instances on disjoint coin sets.

## Setup & run

```bash
git clone https://github.com/abhinavg6/multi-agent-verifiable-research.git
cd multi-agent-verifiable-research
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY, MEMWAL_ACCOUNT_ID, MEMWAL_DELEGATE_KEY, SUI_PRIVATE_KEY
npm run dev
```

Then open <http://localhost:3040>.

### Required env

| Var                      | Where to get it                                                        |
| ------------------------ | ---------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | <https://console.anthropic.com>                                        |
| `MEMWAL_ACCOUNT_ID`      | <https://memwal.ai> — create a MemWalAccount, copy the obj id          |
| `MEMWAL_DELEGATE_KEY`    | Generate at memwal.ai when you create the account                      |
| `SUI_PRIVATE_KEY`        | Bech32 `suiprivkey1…` — funds Walrus uploads. See "Funding" above.     |

### Optional env

| Var                            | Default                                                |
| ------------------------------ | ------------------------------------------------------ |
| `SUI_NETWORK`                  | `mainnet`                                              |
| `MEMWAL_SERVER_URL`            | `https://relayer.memwal.ai`                            |
| `WALRUS_AGGREGATOR_URL`        | `https://aggregator.walrus-mainnet.walrus.space`       |
| `WALRUS_UPLOAD_RELAY_URL`      | `https://upload-relay.mainnet.walrus.space`            |
| `WALRUS_EPOCHS`                | `50` (~ 2 years on mainnet)                            |
| `WALRUS_UPLOAD_TIP_MAX_MIST`   | `10000000` (0.01 SUI cap on relay tip)                 |
| `LAB_ENABLE_SEAL`              | `false`                                                |
| `SEAL_PACKAGE_ID`              | (required if Seal is on)                               |
| `SEAL_THRESHOLD`               | `2`                                                    |
| `ANTHROPIC_MODEL`              | `claude-sonnet-4-6`                                    |
| `PORT`                         | `3040`                                                 |

### Try it

A few questions that exercise different source mixes:

- *"What does current evidence say about the gut–brain axis in Parkinson's disease?"*
- *"How have stablecoin reserve disclosures evolved between 2022 and 2025?"*
- *"What are the trade-offs between BFT and DAG-based consensus in modern L1 designs?"*

Toggle between light and dark themes via the icon in the header (preference persists in `localStorage`).

## Layout

```
src/
  server.ts                 # Hono + SSE
  events.ts                 # per-run event bus
  types.ts                  # shared types
  types-seal.ts             # Seal type shims (optional dep)
  sui-context.ts            # shared Sui keypair + JSON-RPC client
  walrus.ts                 # @mysten/walrus client (writeBlobFlow + serial mutex)
  seal.ts                   # optional encrypt-before-pin wrapper
  snapshots.ts              # pinSource + pinSnapshot
  memory.ts                 # MemWal wrapper, namespace + bus aware
  readers/
    index.ts                # source dispatch
    arxiv.ts wikipedia.ts openalex.ts europepmc.ts github_rss.ts
  agents/
    llm.ts                  # JSON / text helpers w/ retry on AbortError
    planner.ts reader.ts critic.ts synthesizer.ts
    orchestrator.ts         # planner → parallel readers → critic → synth
public/
  index.html                # 3-pane UI: run + trace · report · memory + claims
```
