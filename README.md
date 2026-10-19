# Hybrid Post-Quantum Blockchain Thesis Prototype

**Design and Evaluation of a Hybrid Post-Quantum Secure Blockchain Architecture and Migration Framework**

Two blockchain systems with byte-identical APIs and behaviour, differing **only** in their
cryptographic signature layer, built as the experimental prototype for a comparative Master's
thesis.

| | System A — `classical-node` | System B — `hybrid-node` |
|---|---|---|
| Signature scheme | ECC (secp256k1 ECDSA) | ECC (secp256k1) **+** ML-DSA-65 (FIPS 204 / CRYSTALS-Dilithium) |
| Validity rule | ECC signature must verify | **Both** signatures must independently verify |
| Address format | `<eccPublicKeyHex>` | `<eccPublicKeyHex>.<pqPublicKeyHex>` |
| Port (default) | 4001 | 4002 |

## Why this architecture is a fair comparison

Both nodes are built from the exact same `Blockchain`, `Block`, `Wallet`, and `TransactionPool`
classes in `packages/shared`. The **only** place the two systems diverge is their
`SignatureProvider` implementation (`packages/classical-node/src/signatureProvider.ts` vs
`packages/hybrid-node/src/signatureProvider.ts`) — a Strategy pattern injected into the shared
`Blockchain` engine at construction time. Block hashing, Proof-of-Work, chain validation, and the
REST/WebSocket API are identical line-for-line, which isolates the experimental variable to the
cryptographic layer as required by the research design.

## Project structure

```
project/
├── package.json                 # npm workspaces root
├── tsconfig.base.json
├── start-network.sh              # launches 3-node classical + 3-node hybrid mesh
├── stop-network.sh
├── run-experiment.sh             # full pipeline: network + workload + attacks + analysis
├── scripts/
│   ├── workload-generator.mjs    # configurable-concurrency transaction load + TPS calc
│   └── attack-simulator.mjs      # all 9 required security attack types
├── analysis/                     # Python: statistics, comparison, t-tests, graphs, report
│   ├── common.py, descriptive_stats.py, comparative.py, t_test.py, graphs.py,
│   │   report_generator.py, run_analysis.py
│   └── requirements.txt
├── packages/
│   ├── shared/                  # Block, Blockchain, Wallet, TransactionPool, crypto primitives
│   │   └── src/
│   │       ├── crypto/
│   │       │   ├── hash.ts      # SHA-256 + canonical JSON hashing
│   │       │   ├── ecc.ts       # secp256k1 ECDSA (classical)
│   │       │   └── pqc.ts       # ML-DSA-65 (post-quantum)
│   │       ├── metrics/
│   │       │   ├── types.ts     # TransactionRecord, BlockRecord, NodeSampleRecord, NetworkRecord
│   │       │   ├── resourceSampler.ts  # CPU/memory sampling
│   │       │   └── recorder.ts  # CSV + JSON writer
│   │       ├── types.ts         # SignatureProvider strategy interface
│   │       ├── block.ts         # Block + Proof-of-Work mining
│   │       ├── blockchain.ts    # Chain engine (mining, validation, balances, sync)
│   │       ├── wallet.ts
│   │       └── transactionPool.ts
│   ├── classical-node/          # System A
│   │   └── src/
│   │       ├── signatureProvider.ts   # ECC-only, with timing
│   │       ├── peers.ts               # P2P gossip: block propagation, resync
│   │       ├── server.ts              # Express + Socket.IO API
│   │       ├── logger.ts              # Winston
│   │       └── index.ts               # entry point + node-level sampling loop
│   └── hybrid-node/              # System B
│       └── src/
│           ├── signatureProvider.ts   # ECC + ML-DSA-65 dual signature, with timing
│           ├── peers.ts               # identical shape to classical-node
│           ├── server.ts              # identical shape to classical-node
│           ├── logger.ts
│           └── index.ts
```

## Technology stack

- **Node.js 20+**, **TypeScript 5.9** (strict mode, native ESM/`NodeNext`)
- **Express 5** + **Socket.IO 4** (REST API + peer chain sync)
- **@noble/curves** — secp256k1 ECDSA (audited, pure JS/TS)
- **@noble/post-quantum** — ML-DSA-65, NIST FIPS 204 (audited, pure JS/TS)
- **@noble/hashes** — SHA-256
- **Winston** — structured logging
- **Jest + ts-jest** — unit/integration tests

All dependency versions are pinned exactly in each `package.json` (checked against the live npm
registry at build time — see version table below).

## Setup

```bash
npm install        # installs all three workspace packages
npm run build       # compiles shared, classical-node, hybrid-node
npm test             # runs the full test suite (28 tests, all passing)
```

Run a node individually:

```bash
npm run classical:dev   # http://localhost:4001, ts-node dev server with hot reload
npm run hybrid:dev      # http://localhost:4002
```

Or run the compiled build directly:

```bash
node packages/classical-node/dist/index.js   # PORT=4001 DIFFICULTY=4 by default
node packages/hybrid-node/dist/index.js      # PORT=4002 DIFFICULTY=4 by default
```

Environment variables (both nodes): `PORT`, `DIFFICULTY` (PoW leading-zero count),
`NODE_LABEL` (log/health label).

## REST API (identical on both nodes)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Node status, active signature scheme, chain length |
| `GET` | `/chain` | Full chain, JSON-serialized |
| `GET` | `/chain/validate` | Runs full chain validation (hash linkage, PoW, all signatures) |
| `GET` | `/balance/:address` | Confirmed balance for an address |
| `GET` | `/pool` | Pending (unmined) transactions |
| `POST` | `/wallet` | Creates a server-held demo wallet, returns its address |
| `POST` | `/wallet/:walletId/transaction` | Signs and submits a transaction from that wallet |
| `POST` | `/transaction` | Submits an already-signed transaction (used by the benchmark module) |
| `POST` | `/mine` | Mines all pending transactions into a new block; returns timing data |

`POST /mine` and the mining pipeline return `durationMs` and `attempts` directly — these are the
raw measurements the benchmark module aggregates into TPS, mining-time, and verification-time
comparisons between System A and System B. Benchmark clients can pass `summaryOnly: true` in the
`/mine` request body to receive only the block index, timestamp, hash, previous hash, and transaction
count instead of downloading the entire transaction payload. The workload generator uses this mode.

### Large-workload networking safeguards

- The Socket.IO `chain:update` event now sends the chain length and latest-block summary, not the
  complete chain after every mined block. Clients that need the full history should request `GET /chain`.
- Peer catch-up uses bounded five-block `chain:response` chunks and validates/appends each block in
  sequence. It no longer serializes the full chain into one message, which could exceed Socket.IO's
  default message limit with ML-DSA-sized hybrid transactions.
- These changes keep the benchmark's measured blockchain and signature behaviour intact while
  avoiding repeated full-history serialization and transfer as the chain grows.
- Network startup first stops stale node processes that belong to this project, checks that all
  six ports are free, and waits until every expected node answers `/health` before a workload starts.
  It never kills an unrelated process that is holding one of those ports. The experiment runner
  also stops the network on errors or interruption, preventing orphan hybrid nodes from causing
  `EADDRINUSE` on ports 4012/4022 during the next 50,000-transaction run.

## What's implemented vs. what's next

**Implemented and tested:**
- Both blockchain systems: PoW mining, chain validation, transaction pool, wallets, REST + WebSocket API
- ECC and ML-DSA-65 signature providers, dependency-injected via the `SignatureProvider` strategy, each timing its own signing/verification separately
- **Real P2P networking**: nodes form a full-mesh gossip network, propagate mined blocks with measured propagation delay and byte size, and resync via a fast single-block-append path with full-chain fallback for larger gaps
- **Full data-collection instrumentation** (thesis spec Sections 1–5), including every field the spec lists:
  - Every transaction gets a record from **every node that sees it** — the mining node (`nodeRole: 'miner'`) *and* every peer that receives it via P2P (`nodeRole: 'receiver'`), which is what makes `networkDelayMs` (the block's real propagation time to that node) actually populated rather than always null
  - Combined ECC+PQ signing/verification time (`combinedSignGenMs`, `combinedVerifyMs`) tracked as explicit fields, not just derivable from the individual ECC/PQ fields
  - P2P message counts (`messagesSent`/`messagesReceived`) and bandwidth rate (correctly computed as a **delta** between samples, not a running cumulative total) in the per-second node monitoring
  - Full-chain resynchronization events (a node falling more than one block behind and catching up) timed and logged to `sync.csv` — "average synchronization time" from spec Section 4
- **Workload generator** (`scripts/workload-generator.mjs`): configurable-concurrency transaction load, automatic mining, TPS/confirmation-rate/success-rate calculation, an explicit `--mode sequential|parallel` switch, and `--ratePerSec` for an adjustable transaction rate independent of concurrency
- **Security attack suite** (`scripts/attack-simulator.mjs`): all 9 required attack types, using the system's own signing/hashing code to craft realistic attacks
- **Python analysis pipeline** (`analysis/`): `summary.csv` (concise per-system rollup), full descriptive statistics (mean/median/min/max/variance/stddev/95% CI) across every metric including signature/verification/sync timing, Classical-vs-Hybrid comparative dataset, automatic significance testing (Welch's t-test or Mann-Whitney U depending on normality), 12 chart types (PNG/SVG/PDF), and a final auto-generated Markdown report
- **54 passing tests**: 37 TypeScript (unit/integration, including regression tests for two real bugs found during development — see below) + 17 Python (`analysis/tests/`, covering descriptive stats, comparative logic, t-test selection, and the summary rollup)
- One-command full experiment runner: `./run-experiment.sh [count] [concurrency]`

**Not yet built:**
- Docker/Prometheus/Grafana monitoring stack, Azure deployment
- LaTeX table generation (CSV/Markdown tables are produced; LaTeX conversion is a small additional step if needed)
- Disk usage in `nodes.csv` is an approximation (size of this node's own metrics output directory, not a true OS-level disk usage reading), documented in code comments in `packages/*/src/index.ts`

**Real bugs found and fixed along the way** — worth knowing about for your methodology section:
1. `Block.computeHash()` originally only hashed each transaction's `id` and `signature`, not its full content. Full chain validation still caught amount-tampering (via a separate signature re-verification pass), but the faster single-block integrity check (`Block.isValid()`, used in P2P propagation) did not. Fixed to hash complete transaction content — then this fix itself introduced a severe performance regression (re-serializing the full transaction set on every one of ~65,000 PoW attempts), which was fixed by caching a compact Merkle-style digest once per block instead.
2. A confirmed transaction's ID stopped being tracked for replay detection once it left the pending pool, so the exact same signed transaction could be replayed and re-mined after confirmation. Fixed with a persistent `confirmedIds` set in `TransactionPool`.

Both have regression tests; see `packages/shared/tests/crypto.test.ts` and `packages/classical-node/tests/blockchain.test.ts`.

**A gap in the folder structure vs. the spec's example, documented deliberately:** the spec's example folder structure shows one flat `results/experiment_001/` directory; this implementation nests `classical/` and `hybrid/` subfolders underneath, because 3 nodes per system need to share one output location (each writes complete, un-siloed CSVs distinguished by `nodeId`) while the two *systems* need to stay separate for the comparative analysis to work. `summary.csv`, `statistics.csv`, `comparative.csv`, `t_test_results.csv`, `graphs/`, and `report.md` all still live at the experiment root, exactly as the spec shows.

## Running a full experiment

```bash
./run-experiment.sh              # 1000 tx per system, concurrency 10
./run-experiment.sh 10000 25     # 10,000 tx per system, concurrency 25
./run-experiment.sh 50000 50     # 50,000 tx per system, concurrency 50
```

This starts the 6-node network (3 classical + 3 hybrid), drives the workload, runs the attack suite, stops the network, and runs the full Python analysis pipeline. Output lands in `results/<experiment_id>/`:

```
results/run_2026-07-30T.../
├── classical/
│   ├── transactions.csv, transactions.json   # written by EVERY node that sees each tx (miner + receivers)
│   ├── blocks.csv, blocks.json
│   ├── nodes.csv, nodes.json                  # 1s samples: CPU, memory, bandwidth, message counts, queue depth
│   ├── network.csv, network.json              # per-block propagation events
│   ├── sync.csv, sync.json                    # full-chain resync events (average synchronization time)
│   ├── benchmark.csv
│   └── attacks.csv
├── hybrid/
│   └── (same files)
├── summary.csv              # concise per-system rollup
├── statistics.csv          # descriptive stats per metric per system
├── comparative.csv         # Classical vs Hybrid, difference, % change
├── t_test_results.csv      # significance testing per metric
├── graphs/                 # 12 chart types, each as .png/.svg/.pdf
└── report.md                # full assembled experimental report
```

First-time Python setup: `pip install -r analysis/requirements.txt --break-system-packages` (or use a virtualenv).

Python analysis unit tests: `cd analysis && python3 -m unittest discover -s tests -v`.

### Running pieces individually

```bash
EXPERIMENT_ID=my_run ./start-network.sh      # start the 6-node mesh
node scripts/workload-generator.mjs --url=http://localhost:4001 --system=classical --count=1000 --concurrency=10 --experimentDir=results/my_run/classical
node scripts/attack-simulator.mjs --url=http://localhost:4001 --system=classical --experimentDir=results/my_run/classical
./stop-network.sh
python3 analysis/run_analysis.py --experimentDir results/my_run
```

## Key dependency versions

| Package | Version |
|---|---|
| typescript | 5.9.3 |
| express | 5.2.1 |
| socket.io | 4.8.3 |
| @noble/curves | 2.2.0 |
| @noble/hashes | 2.2.0 |
| @noble/post-quantum | 0.6.1 |
| winston | 3.19.0 |
| jest / ts-jest | 30.4.2 / 29.4.11 |
