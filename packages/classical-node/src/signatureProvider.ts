import {
  eccGenerateKeyPair,
  eccSign,
  eccVerify,
  sha256OfObject,
  SignatureProvider,
  SignResult,
  Transaction,
  TransactionPayload,
  VerifyResult,
} from '@thesis/shared';

/**
 * System A — Classical: signs and verifies transactions using ECC
 * (secp256k1 ECDSA) only. This is the control group in the thesis
 * comparison; `hybrid-node`'s provider has an identical shape but adds a
 * second, post-quantum signature. Both `sign` and `verify` measure their
 * own wall-clock time via `performance.now()` so the benchmark layer can
 * report ECC generation/verification time without re-instrumenting from
 * the outside.
 */
export class ClassicalSignatureProvider implements SignatureProvider {
  readonly name = 'ECC (secp256k1)';

  generateIdentity() {
    const { privateKeyHex, publicKeyHex } = eccGenerateKeyPair();
    return {
      address: publicKeyHex,
      privateMaterial: { eccPrivateKey: privateKeyHex },
    };
  }

  sign(payload: TransactionPayload, privateMaterial: Record<string, string>): SignResult {
    const digest = sha256OfObject(payload);
    const start = performance.now();
    const eccSig = eccSign(digest, privateMaterial.eccPrivateKey);
    const eccMs = performance.now() - start;
    return { signature: { ecc: eccSig }, timingsMs: { ecc: eccMs, total: eccMs } };
  }

  verify(transaction: Transaction): VerifyResult {
    const { id, signature, ...payload } = transaction;
    if (!signature?.ecc) {
      return { valid: false, validityByAlgorithm: { ecc: false }, timingsMs: { ecc: 0, total: 0 } };
    }
    const digest = sha256OfObject(payload);
    const start = performance.now();
    const valid = eccVerify(signature.ecc, digest, transaction.fromAddress);
    const eccMs = performance.now() - start;
    return { valid, validityByAlgorithm: { ecc: valid }, timingsMs: { ecc: eccMs, total: eccMs } };
  }
}
