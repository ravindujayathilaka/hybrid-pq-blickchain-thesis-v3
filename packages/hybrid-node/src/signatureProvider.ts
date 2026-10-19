import {
  canonicalJson,
  eccGenerateKeyPair,
  eccSign,
  eccVerify,
  pqGenerateKeyPair,
  pqSign,
  pqVerify,
  sha256Hex,
  SignatureProvider,
  SignResult,
  Transaction,
  TransactionPayload,
  VerifyResult,
} from '@thesis/shared';

const ADDRESS_SEPARATOR = '.';

/**
 * System B — Hybrid Post-Quantum: every transaction carries *two*
 * independent signatures, ECC (secp256k1) and ML-DSA-65 (FIPS 204 /
 * CRYSTALS-Dilithium). A transaction is valid only if **both** signatures
 * verify; if either is missing, forged, or fails, the transaction is
 * rejected. `sign`/`verify` time each algorithm separately via
 * `performance.now()`, which is what lets the benchmark layer report ECC
 * time, PQ time, and combined/"total" time as distinct series — the core
 * dataset for the ECC-vs-PQ-vs-hybrid comparison in the thesis.
 *
 * Address format: `<eccPublicKeyHex>.<pqPublicKeyHex>` — a simple,
 * self-describing encoding that lets verification recover both public
 * keys from the address alone, with no external key registry needed for
 * this research prototype.
 */
export class HybridSignatureProvider implements SignatureProvider {
  readonly name = 'ECC (secp256k1) + ML-DSA-65 (hybrid)';

  generateIdentity() {
    const ecc = eccGenerateKeyPair();
    const pq = pqGenerateKeyPair();
    return {
      address: `${ecc.publicKeyHex}${ADDRESS_SEPARATOR}${pq.publicKeyHex}`,
      privateMaterial: {
        eccPrivateKey: ecc.privateKeyHex,
        pqSecretKey: pq.secretKeyHex,
      },
    };
  }

  sign(payload: TransactionPayload, privateMaterial: Record<string, string>): SignResult {
    const canonical = canonicalJson(payload);

    const t0 = performance.now();
    const eccSig = eccSign(sha256Hex(canonical), privateMaterial.eccPrivateKey);
    const t1 = performance.now();
    const pqSig = pqSign(canonical, privateMaterial.pqSecretKey);
    const t2 = performance.now();

    return {
      signature: { ecc: eccSig, pq: pqSig },
      timingsMs: { ecc: t1 - t0, pq: t2 - t1, total: t2 - t0 },
    };
  }

  verify(transaction: Transaction): VerifyResult {
    const { id, signature, fromAddress, ...rest } = transaction;
    if (!signature?.ecc || !signature?.pq) {
      return {
        valid: false,
        validityByAlgorithm: { ecc: !!signature?.ecc, pq: !!signature?.pq },
        timingsMs: { ecc: 0, pq: 0, total: 0 },
      };
    }

    const [eccPubKey, pqPubKey] = splitAddress(fromAddress);
    if (!eccPubKey || !pqPubKey) {
      return { valid: false, validityByAlgorithm: { ecc: false, pq: false }, timingsMs: { ecc: 0, pq: 0, total: 0 } };
    }

    const payload: TransactionPayload = { fromAddress, ...rest } as TransactionPayload;
    const canonical = canonicalJson(payload);
    const digest = sha256Hex(canonical);

    const t0 = performance.now();
    const eccValid = eccVerify(signature.ecc, digest, eccPubKey);
    const t1 = performance.now();
    const pqValid = pqVerify(signature.pq, canonical, pqPubKey);
    const t2 = performance.now();

    // Both signatures must independently validate. A single broken or
    // forged signature fails the whole transaction — this is what a
    // "hybrid" scheme means cryptographically: security depends on the
    // strength of the stronger-surviving algorithm, not the weaker one.
    return {
      valid: eccValid && pqValid,
      validityByAlgorithm: { ecc: eccValid, pq: pqValid },
      timingsMs: { ecc: t1 - t0, pq: t2 - t1, total: t2 - t0 },
    };
  }
}

function splitAddress(address: string): [string, string] | [undefined, undefined] {
  const parts = address.split(ADDRESS_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [undefined, undefined];
  return [parts[0], parts[1]];
}
