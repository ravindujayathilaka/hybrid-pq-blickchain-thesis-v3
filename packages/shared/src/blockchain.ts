import { randomUUID } from 'node:crypto';
import { Block } from './block.js';
import { TransactionMeta, TransactionPool } from './transactionPool.js';
import { ChainValidationResult, COINBASE_ADDRESS, SignatureProvider, Transaction } from './types.js';

export interface BlockchainOptions {
  difficulty?: number;
  miningReward?: number;
}

export interface MinedTransactionEntry {
  transaction: Transaction;
  /** Pool-side metadata (size, timestamps, verification timing) snapshotted just before mining. Undefined for the coinbase reward transaction. */
  meta?: TransactionMeta;
}

export interface AppendedTransactionEntry {
  transaction: Transaction;
  verifyTimingsMs?: Record<string, number>;
  validityByAlgorithm?: Record<string, boolean>;
}

export interface AppendBlockResult {
  accepted: boolean;
  reason?: string;
  /** Cost of the isValid() hash/PoW check on this receiving node. */
  validationTimeMs?: number;
  /** Per-transaction signature re-verification timing on this receiving node (only when accepted). */
  transactionEntries?: AppendedTransactionEntry[];
}

export interface MineResult {
  block: Block;
  durationMs: number;
  attempts: number;
  transactionCount: number;
  /** Cost of a single SHA-256 hash over the final block content (distinct from total PoW search time). */
  hashingTimeMs: number;
  /** Cost of re-validating the freshly mined block (hash + PoW target check). */
  validationTimeMs: number;
  /** Per-transaction metadata snapshotted before the pool was cleared, for benchmark record assembly. */
  transactionEntries: MinedTransactionEntry[];
}

/**
 * The blockchain engine: chain storage, mining, and validation. This class
 * is intentionally identical for System A and System B — it is constructed
 * with a `SignatureProvider` (Strategy pattern / dependency injection) and
 * never imports ECC or ML-DSA itself. `classical-node` injects an
 * ECC-only provider; `hybrid-node` injects an ECC+ML-DSA dual-signature
 * provider. Everything else — block structure, PoW, chain validation,
 * balances — behaves identically, which is what makes the two systems
 * comparable in the benchmark phase.
 */
export class Blockchain {
  public chain: Block[];
  public readonly difficulty: number;
  public readonly miningReward: number;
  public readonly pool: TransactionPool;

  constructor(
    private readonly signatureProvider: SignatureProvider,
    options: BlockchainOptions = {}
  ) {
    this.difficulty = options.difficulty ?? 4;
    this.miningReward = options.miningReward ?? 50;
    this.chain = [Block.genesis(this.difficulty)];
    this.pool = new TransactionPool(signatureProvider);
  }

  getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  /** Verify and (if valid) enqueue a transaction. Delegates verification to the pool. */
  submitTransaction(tx: Transaction) {
    return this.pool.add(tx);
  }

  /**
   * Mine all currently pending transactions into a new block, plus a
   * coinbase reward transaction to `minerAddress`. Returns timing data
   * used directly by the benchmark module: total mining (PoW search) time,
   * a separately measured single-hash cost, post-mine validation cost, and
   * per-transaction metadata snapshotted from the pool before it's cleared.
   */
  minePendingTransactions(minerAddress: string): MineResult {
    const rewardTx: Transaction = {
      id: randomUUID(),
      fromAddress: COINBASE_ADDRESS,
      toAddress: minerAddress,
      amount: this.miningReward,
      timestamp: Date.now(),
      nonce: randomUUID(),
      signature: { coinbase: 'true' },
    };

    const pendingTxs = this.pool.all();
    // Snapshot metadata BEFORE pool.clear() removes it.
    const transactionEntries: MinedTransactionEntry[] = [
      ...pendingTxs.map((transaction) => ({ transaction, meta: this.pool.getMeta(transaction.id) })),
      { transaction: rewardTx, meta: undefined },
    ];

    const transactions = [...pendingTxs, rewardTx];
    const previous = this.getLatestBlock();
    const block = new Block({
      index: previous.index + 1,
      timestamp: Date.now(),
      transactions,
      previousHash: previous.hash,
      nonce: 0,
      difficulty: this.difficulty,
    });

    const { durationMs, attempts } = block.mine();

    const hashStart = performance.now();
    block.computeHash();
    const hashingTimeMs = performance.now() - hashStart;

    const validateStart = performance.now();
    block.isValid();
    const validationTimeMs = performance.now() - validateStart;

    this.chain.push(block);
    this.pool.clear(transactions.map((t) => t.id));

    return {
      block,
      durationMs,
      attempts,
      transactionCount: transactions.length,
      hashingTimeMs,
      validationTimeMs,
      transactionEntries,
    };
  }

  /**
   * Fast path for P2P block propagation: validate and append a single
   * block received from a peer, without re-validating the entire chain.
   * This is what real nodes do — `replaceChain` (full re-validation) is
   * reserved for larger resyncs (a node that fell behind by more than one
   * block). Returns a reason on rejection so the caller can log/measure it,
   * plus per-transaction verification timing on ACCEPT so the receiving
   * node can log its own transaction/block records (not just the miner).
   */
  appendReceivedBlock(block: Block): AppendBlockResult {
    const latest = this.getLatestBlock();

    if (block.index !== latest.index + 1) {
      return { accepted: false, reason: 'NOT_NEXT_INDEX' };
    }
    if (block.previousHash !== latest.hash) {
      return { accepted: false, reason: 'PREVHASH_MISMATCH' };
    }

    const validateStart = performance.now();
    const isValid = block.isValid();
    const validationTimeMs = performance.now() - validateStart;
    if (!isValid) {
      return { accepted: false, reason: 'INVALID_HASH_OR_POW', validationTimeMs };
    }

    const transactionEntries: AppendedTransactionEntry[] = [];
    for (const tx of block.transactions) {
      if (tx.fromAddress === COINBASE_ADDRESS) continue;
      const verifyResult = this.signatureProvider.verify(tx);
      if (!verifyResult.valid) {
        return { accepted: false, reason: `INVALID_SIGNATURE:${tx.id}`, validationTimeMs };
      }
      transactionEntries.push({
        transaction: tx,
        verifyTimingsMs: verifyResult.timingsMs,
        validityByAlgorithm: verifyResult.validityByAlgorithm,
      });
    }

    this.chain.push(block);
    this.pool.clear(block.transactions.map((t) => t.id));
    return { accepted: true, validationTimeMs, transactionEntries };
  }

  /** Sum confirmed incoming minus outgoing amounts for an address across the whole chain. */
  getBalance(address: string): number {
    let balance = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.fromAddress === address) balance -= tx.amount;
        if (tx.toAddress === address) balance += tx.amount;
      }
    }
    return balance;
  }

  /**
   * Full chain validation: hash linkage, PoW target, block hash integrity,
   * and every non-coinbase transaction's signature. Genesis (index 0) is
   * exempt from PoW/signature checks since it is a fixed starting point,
   * not a mined block.
   */
  isChainValid(chain: Block[] = this.chain): ChainValidationResult {
    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];

      if (i === 0) continue; // genesis: fixed, not mined, no transactions to verify

      if (block.hash !== block.computeHash()) {
        return { valid: false, reason: 'Block hash does not match recomputed hash', blockIndex: i };
      }
      if (!block.hash.startsWith('0'.repeat(block.difficulty))) {
        return { valid: false, reason: 'Block does not satisfy Proof-of-Work difficulty', blockIndex: i };
      }
      if (block.previousHash !== chain[i - 1].hash) {
        return { valid: false, reason: 'Broken previousHash linkage', blockIndex: i };
      }
      for (const tx of block.transactions) {
        if (tx.fromAddress === COINBASE_ADDRESS) continue; // reward transactions are not user-signed
        if (!this.signatureProvider.verify(tx).valid) {
          return { valid: false, reason: `Invalid signature on transaction ${tx.id}`, blockIndex: i };
        }
      }
    }
    return { valid: true };
  }

  /**
   * Basic longest-valid-chain replacement, used by node synchronization.
   * Accepts an incoming chain only if it is longer and fully valid.
   */
  replaceChain(incoming: Block[]): { replaced: boolean; reason?: string } {
    if (incoming.length <= this.chain.length) {
      return { replaced: false, reason: 'Incoming chain is not longer than the current chain' };
    }
    const result = this.isChainValid(incoming);
    if (!result.valid) {
      return { replaced: false, reason: result.reason };
    }
    this.chain = incoming;
    return { replaced: true };
  }
}
