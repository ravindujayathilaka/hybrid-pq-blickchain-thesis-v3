/**
 * Core domain types shared by both the classical and hybrid nodes.
 *
 * Design note (Strategy pattern): `SignatureProvider` is the single
 * abstraction point where System A (classical) and System B (hybrid PQ)
 * diverge. Every other type, and the entire `Blockchain` engine, is
 * identical between the two systems, which is what makes the eventual
 * benchmark comparison fair — the only independent variable is the
 * cryptographic layer.
 */

export const COINBASE_ADDRESS = 'COINBASE';

/** An unsigned transaction payload — everything that gets hashed and signed. */
export interface TransactionPayload {
  fromAddress: string | typeof COINBASE_ADDRESS;
  toAddress: string;
  amount: number;
  timestamp: number;
  /** Random nonce so two otherwise-identical transactions still hash differently. */
  nonce: string;
}

/** A fully signed transaction, ready to be pooled and mined. */
export interface Transaction extends TransactionPayload {
  id: string;
  /**
   * Opaque, provider-specific signature material. The classical provider
   * stores a single ECC signature; the hybrid provider stores both an ECC
   * and an ML-DSA signature. Only the active `SignatureProvider` knows how
   * to interpret this field — the `Blockchain` engine never inspects it.
   */
  signature: Record<string, string>;
}

export interface BlockData {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  nonce: number;
  difficulty: number;
}

export interface SerializedBlock extends BlockData {
  hash: string;
}

/**
 * Result of signing a transaction. `timingsMs` records wall-clock time
 * spent in *each* underlying algorithm separately (e.g. `{ ecc: 0.41 }`
 * for the classical provider, `{ ecc: 0.41, pq: 3.2, total: 3.61 }` for
 * the hybrid provider) — this is what feeds the "ECC/PQ Signature
 * Generation Time" fields the thesis benchmark needs.
 */
export interface SignResult {
  signature: Record<string, string>;
  timingsMs: Record<string, number>;
}

/** Result of verifying a transaction, with the same per-algorithm timing breakdown. */
export interface VerifyResult {
  valid: boolean;
  /** Per-algorithm validity, where applicable (e.g. `{ ecc: true, pq: false }`). */
  validityByAlgorithm?: Record<string, boolean>;
  timingsMs: Record<string, number>;
}

/**
 * Strategy interface implementing the pluggable cryptographic layer.
 * `classical-node` and `hybrid-node` each provide a concrete implementation;
 * the rest of the system (`Blockchain`, `TransactionPool`, the REST API)
 * is written entirely against this interface and never depends on ECC or
 * ML-DSA directly.
 */
export interface SignatureProvider {
  /** Human-readable name, used in logs and API metadata (e.g. "ECC" or "ECC+ML-DSA-65"). */
  readonly name: string;

  /**
   * Generate a new address plus its private key material. The private key
   * material's shape is provider-specific and must be kept only inside a
   * `Wallet` — it is never persisted on-chain.
   */
  generateIdentity(): { address: string; privateMaterial: Record<string, string> };

  /** Sign a transaction payload, producing the `signature` field plus generation timing. */
  sign(payload: TransactionPayload, privateMaterial: Record<string, string>): SignResult;

  /**
   * Verify a transaction's signature(s) against the sender's address, with
   * verification timing. Must fail closed (`valid: false`) for any
   * malformed input rather than throwing.
   */
  verify(transaction: Transaction): VerifyResult;
}

export interface ChainValidationResult {
  valid: boolean;
  reason?: string;
  blockIndex?: number;
}
