import { SignatureProvider, Transaction } from './types.js';

export type RejectReason =
  | 'INVALID_SIGNATURE'
  | 'DUPLICATE_ID'
  | 'NON_POSITIVE_AMOUNT'
  | 'MISSING_FIELDS';

export interface PoolAddResult {
  accepted: boolean;
  reason?: RejectReason;
  /** Present whenever verification actually ran (even on rejection), for benchmarking. */
  verifyTimingsMs?: Record<string, number>;
  validityByAlgorithm?: Record<string, boolean>;
  sizeBytes: number;
  receivedAt: number;
  verifiedAt: number;
}

/** Metadata retained per accepted transaction, retrievable at mine time to assemble a full metrics record. */
export interface TransactionMeta {
  sizeBytes: number;
  receivedAt: number;
  verifiedAt: number;
  verifyTimingsMs: Record<string, number>;
  validityByAlgorithm?: Record<string, boolean>;
}

/**
 * Holds transactions that have been signature-verified but not yet mined
 * into a block. Rejects malformed, duplicate, or badly-signed transactions
 * up front so the mining step never has to re-validate from scratch.
 *
 * Also retains lightweight metadata (size, timestamps, verification
 * timing) per accepted transaction so that `Blockchain.minePendingTransactions`
 * can assemble a complete benchmark record at confirmation time without
 * re-running verification.
 */
export class TransactionPool {
  private pending: Map<string, Transaction> = new Map();
  private meta: Map<string, TransactionMeta> = new Map();
  /**
   * IDs of transactions that have been mined into a block, retained
   * permanently (for the lifetime of the process) so a previously
   * confirmed transaction can never be replayed/re-accepted once it has
   * left the pending pool. Without this, `pending.has(tx.id)` alone only
   * catches duplicates *before* mining — a real replay-attack gap.
   */
  private confirmedIds: Set<string> = new Set();

  constructor(private readonly signatureProvider: SignatureProvider) {}

  add(tx: Transaction): PoolAddResult {
    const receivedAt = Date.now();
    const sizeBytes = Buffer.byteLength(JSON.stringify(tx ?? {}));

    if (!tx?.id || !tx.fromAddress || !tx.toAddress || !tx.signature) {
      return { accepted: false, reason: 'MISSING_FIELDS', sizeBytes, receivedAt, verifiedAt: Date.now() };
    }
    if (tx.amount <= 0) {
      return { accepted: false, reason: 'NON_POSITIVE_AMOUNT', sizeBytes, receivedAt, verifiedAt: Date.now() };
    }
    if (this.pending.has(tx.id) || this.confirmedIds.has(tx.id)) {
      return { accepted: false, reason: 'DUPLICATE_ID', sizeBytes, receivedAt, verifiedAt: Date.now() };
    }

    const verifyResult = this.signatureProvider.verify(tx);
    const verifiedAt = Date.now();

    if (!verifyResult.valid) {
      return {
        accepted: false,
        reason: 'INVALID_SIGNATURE',
        verifyTimingsMs: verifyResult.timingsMs,
        validityByAlgorithm: verifyResult.validityByAlgorithm,
        sizeBytes,
        receivedAt,
        verifiedAt,
      };
    }

    this.pending.set(tx.id, tx);
    this.meta.set(tx.id, {
      sizeBytes,
      receivedAt,
      verifiedAt,
      verifyTimingsMs: verifyResult.timingsMs,
      validityByAlgorithm: verifyResult.validityByAlgorithm,
    });

    return {
      accepted: true,
      verifyTimingsMs: verifyResult.timingsMs,
      validityByAlgorithm: verifyResult.validityByAlgorithm,
      sizeBytes,
      receivedAt,
      verifiedAt,
    };
  }

  all(): Transaction[] {
    return Array.from(this.pending.values());
  }

  size(): number {
    return this.pending.size;
  }

  getMeta(txId: string): TransactionMeta | undefined {
    return this.meta.get(txId);
  }

  /** Remove transactions from the pending pool and permanently mark them confirmed (replay protection). */
  clear(txIds: string[]): void {
    for (const id of txIds) {
      this.pending.delete(id);
      this.meta.delete(id);
      this.confirmedIds.add(id);
    }
  }

  clearAll(): void {
    this.pending.clear();
    this.meta.clear();
  }
}
