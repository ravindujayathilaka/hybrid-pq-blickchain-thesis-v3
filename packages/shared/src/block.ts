import { canonicalJson, sha256Hex } from './crypto/hash.js';
import { BlockData, SerializedBlock, Transaction } from './types.js';

/**
 * A single block. Hashing and Proof-of-Work are identical across System A
 * and System B — cryptographic divergence is confined to the transaction
 * signature layer, not block hashing, so mining performance comparisons
 * measure signature-layer overhead specifically (larger PQ signatures ->
 * larger blocks -> more hashing work per PoW attempt) rather than an
 * apples-to-oranges hashing algorithm difference.
 */
export class Block implements BlockData {
  public index: number;
  public timestamp: number;
  public transactions: Transaction[];
  public previousHash: string;
  public nonce: number;
  public difficulty: number;
  public hash: string;

  constructor(data: BlockData) {
    this.index = data.index;
    this.timestamp = data.timestamp;
    this.transactions = data.transactions;
    this.previousHash = data.previousHash;
    this.nonce = data.nonce;
    this.difficulty = data.difficulty;
    this.hash = this.computeHash();
  }

  /**
   * Deterministic content hash over the full block: index, timestamp,
   * every transaction's *complete* content (not just its id/signature —
   * hashing only those fields would let amount/address/timestamp
   * tampering slip past a hash-only check like `isValid()`, relying
   * entirely on a separate signature re-verification pass to catch it),
   * previousHash, nonce, and difficulty.
   *
   * Always recomputes the transaction digest fresh from the current
   * `this.transactions` state, so it correctly detects in-place tampering
   * (e.g. `block.transactions[0].amount = X` after the fact). NOT used in
   * `mine()`'s hot loop — see there for why.
   */
  computeHash(): string {
    return this.computeHashWithDigest(Block.computeTransactionDigest(this.transactions));
  }

  private computeHashWithDigest(transactionDigest: string): string {
    return sha256Hex(
      `${this.index}:${this.timestamp}:${transactionDigest}:${this.previousHash}:${this.nonce}:${this.difficulty}`
    );
  }

  private static computeTransactionDigest(transactions: Transaction[]): string {
    // Hash each transaction individually, then hash the concatenation of
    // those hashes — a simple Merkle-style reduction producing a compact,
    // FIXED-SIZE (64 hex char) digest regardless of transaction count or
    // size. This matters for `mine()`'s hot loop: hashing a small,
    // constant-size header per PoW attempt is fast; re-hashing potentially
    // many KB of raw transaction JSON on every one of ~65,000 attempts
    // (proportionally worse for the hybrid system's much larger ML-DSA
    // signatures) is not, and was the actual cause of "mining never
    // finishes" on larger/slower machines.
    const txHashes = transactions.map((t) => sha256Hex(canonicalJson(t)));
    return sha256Hex(txHashes.join('|'));
  }

  /**
   * Proof-of-Work: increment nonce until the hash has `difficulty` leading
   * hex zeros. Returns mining duration in milliseconds for benchmarking.
   *
   * Performance note: the transaction-content digest (a canonical-JSON
   * serialization of every transaction) is computed ONCE before the loop,
   * not on every nonce attempt. Mining only mutates `nonce`, never
   * `transactions`, so the digest is safely reusable across the entire
   * search — recomputing it per-attempt would multiply the serialization
   * cost by tens of thousands of PoW attempts for no correctness benefit.
   */
  mine(): { durationMs: number; attempts: number } {
    const target = '0'.repeat(this.difficulty);
    const start = performance.now();
    let attempts = 0;
    const transactionDigest = Block.computeTransactionDigest(this.transactions);

    this.hash = this.computeHashWithDigest(transactionDigest);
    while (!this.hash.startsWith(target)) {
      this.nonce++;
      attempts++;
      this.hash = this.computeHashWithDigest(transactionDigest);
    }
    return { durationMs: performance.now() - start, attempts };
  }

  /** Re-derive the hash and confirm it matches the stored one and meets difficulty. */
  isValid(): boolean {
    if (this.hash !== this.computeHash()) return false;
    if (!this.hash.startsWith('0'.repeat(this.difficulty))) return false;
    return true;
  }

  toJSON(): SerializedBlock {
    return {
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      nonce: this.nonce,
      difficulty: this.difficulty,
      hash: this.hash,
    };
  }

  static fromJSON(data: SerializedBlock): Block {
    const block = new Block({
      index: data.index,
      timestamp: data.timestamp,
      transactions: data.transactions,
      previousHash: data.previousHash,
      nonce: data.nonce,
      difficulty: data.difficulty,
    });
    // Respect the transmitted hash rather than recomputing, so a corrupted
    // hash can still be caught explicitly by isValid() during chain validation.
    block.hash = data.hash;
    return block;
  }

  static genesis(difficulty: number): Block {
    return new Block({
      index: 0,
      timestamp: Date.UTC(2026, 0, 1),
      transactions: [],
      previousHash: '0'.repeat(64),
      nonce: 0,
      difficulty,
    });
  }
}
