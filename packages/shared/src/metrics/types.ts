/**
 * Record shapes for the benchmark/data-collection layer. These are
 * intentionally identical in structure between the classical and hybrid
 * nodes (only field *values* differ, e.g. `pqSignGenMs` is always `null`
 * for the classical system) — this is what makes `transactions.csv` from
 * both systems directly concatenable/comparable for statistical analysis.
 */

export type BlockchainType = 'Classical' | 'Hybrid';

/** One row per transaction, written once it is confirmed (mined) or rejected. */
export interface TransactionRecord {
  transactionId: string;
  blockchainType: BlockchainType;
  nodeId: string;
  /** 'miner' for the node that mined the block containing this tx; 'receiver' for a peer that accepted it via P2P propagation. */
  nodeRole: 'miner' | 'receiver';
  blockNumber: number | null;

  createdAt: number; // ms epoch, set when the wallet built the transaction
  receivedAt: number; // ms epoch, when this node's pool accepted it for validation (or received it via P2P)
  verifiedAt: number; // ms epoch, immediately after signature verification
  confirmedAt: number | null; // ms epoch, when included in a mined block (null if rejected/pending)
  latencyMs: number | null; // confirmedAt - createdAt

  eccSignGenMs: number | null;
  pqSignGenMs: number | null; // null for the classical system
  eccVerifyMs: number | null;
  pqVerifyMs: number | null; // null for the classical system
  /** Combined (ECC+PQ) signing time — spec's "Combined signing time"; equals eccSignGenMs alone on the classical system. */
  combinedSignGenMs: number | null;
  /** Combined (ECC+PQ) verification time — spec's "Combined verification time"; equals eccVerifyMs alone on the classical system. */
  combinedVerifyMs: number | null;
  totalSignatureProcessingMs: number | null; // combinedSignGenMs + combinedVerifyMs

  miningTimeContributionMs: number | null; // this tx's even share of its block's total mining time

  sizeBytes: number;
  cpuPercent: number | null;
  memoryMb: number | null;
  networkDelayMs: number | null; // block propagation time from the mining node to THIS node; null on the miner's own record

  accepted: boolean;
  failureReason: string | null;
  replayAttackDetected: boolean;
  signatureValid: boolean | null;
  pqSignatureValid: boolean | null; // null for the classical system
}

/** One row per mined block. */
export interface BlockRecord {
  blockchainType: BlockchainType;
  nodeId: string;
  blockHeight: number;
  previousHash: string;
  currentHash: string;
  blockSizeBytes: number;
  transactionCount: number;
  miningTimeMs: number; // full Proof-of-Work search duration
  hashingTimeMs: number; // cost of a single SHA-256 hash over this block's content
  validationTimeMs: number; // cost of re-validating the block after mining
  difficulty: number;
  nonce: number;
  timestamp: number;
  cpuPercent: number | null;
  memoryMb: number | null;
}

/** One row per periodic (default 1s) node health sample. */
export interface NodeSampleRecord {
  nodeId: string;
  blockchainType: BlockchainType;
  timestamp: number;
  cpuPercent: number;
  memoryMb: number;
  diskUsageMb: number | null;
  networkBandwidthBytesPerSec: number | null;
  activeConnections: number;
  pendingTransactions: number;
  minedBlocks: number;
  verificationQueueLength: number;
  /** Cumulative P2P messages sent/received since process start (block:announce, chain:request, chain:response). */
  messagesSent: number;
  messagesReceived: number;
}

/** One row per full-chain resynchronization (a node that fell behind by more than one block catching back up). */
export interface SyncRecord {
  blockchainType: BlockchainType;
  nodeId: string;
  peerUrl: string;
  triggeredAt: number;
  completedAt: number;
  syncDurationMs: number;
  chainLengthBefore: number;
  chainLengthAfter: number;
}

/** One row per block propagation event observed between two peers. */
export interface NetworkRecord {
  blockchainType: BlockchainType;
  fromNode: string;
  toNode: string;
  blockIndex: number;
  propagationMs: number;
  blockBytes: number;
  accepted: boolean;
  reason: string | null;
  timestamp: number;
}
