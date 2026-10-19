import { randomUUID } from 'node:crypto';
import { SignatureProvider, Transaction, TransactionPayload } from './types.js';

export interface CreateTransactionMetrics {
  transaction: Transaction;
  signTimingsMs: Record<string, number>;
  sizeBytes: number;
}

/**
 * A Wallet is a thin, provider-agnostic holder of key material. It never
 * touches ECC or ML-DSA directly — it delegates to whichever
 * `SignatureProvider` it was constructed with, which is what lets the same
 * `Wallet` class serve both the classical and hybrid nodes unchanged.
 */
export class Wallet {
  public readonly address: string;
  private readonly privateMaterial: Record<string, string>;
  private readonly provider: SignatureProvider;

  constructor(provider: SignatureProvider) {
    this.provider = provider;
    const identity = provider.generateIdentity();
    this.address = identity.address;
    this.privateMaterial = identity.privateMaterial;
  }

  /**
   * Build and sign a new transaction spending from this wallet's address,
   * returning signing timing and payload size alongside it — used by the
   * benchmark layer to populate per-transaction metric records.
   */
  createTransactionWithMetrics(toAddress: string, amount: number): CreateTransactionMetrics {
    if (amount <= 0) {
      throw new Error('Transaction amount must be positive');
    }
    const payload: TransactionPayload = {
      fromAddress: this.address,
      toAddress,
      amount,
      timestamp: Date.now(),
      nonce: randomUUID(),
    };
    const { signature, timingsMs } = this.provider.sign(payload, this.privateMaterial);
    const transaction: Transaction = {
      ...payload,
      id: randomUUID(),
      signature,
    };
    return {
      transaction,
      signTimingsMs: timingsMs,
      sizeBytes: Buffer.byteLength(JSON.stringify(transaction)),
    };
  }

  /** Convenience wrapper around `createTransactionWithMetrics` for callers that don't need timing data. */
  createTransaction(toAddress: string, amount: number): Transaction {
    return this.createTransactionWithMetrics(toAddress, amount).transaction;
  }
}
