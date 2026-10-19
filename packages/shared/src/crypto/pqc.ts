import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Post-quantum signature primitives using ML-DSA-65 (FIPS 204, formerly
 * CRYSTALS-Dilithium), standardized by NIST in August 2024. ML-DSA-65
 * targets NIST security category 3 (roughly equivalent to AES-192),
 * which is the commonly recommended default for production use.
 *
 * This is the signature scheme added in System B (hybrid). It is used
 * *in addition to* — never instead of — the classical ECC signature so
 * that a transaction is only valid if both signatures verify.
 */

export interface PqKeyPair {
  secretKeyHex: string;
  publicKeyHex: string;
}

/** Generate a fresh ML-DSA-65 key pair, hex-encoded. */
export function pqGenerateKeyPair(): PqKeyPair {
  const { secretKey, publicKey } = ml_dsa65.keygen();
  return {
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

/** Sign an arbitrary UTF-8 message string with ML-DSA-65. */
export function pqSign(message: string, secretKeyHex: string): string {
  const sig = ml_dsa65.sign(utf8ToBytes(message), hexToBytes(secretKeyHex));
  return bytesToHex(sig);
}

/** Verify an ML-DSA-65 signature against a UTF-8 message and public key. */
export function pqVerify(signatureHex: string, message: string, publicKeyHex: string): boolean {
  try {
    return ml_dsa65.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
