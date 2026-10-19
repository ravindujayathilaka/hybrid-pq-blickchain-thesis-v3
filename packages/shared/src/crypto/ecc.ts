import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Elliptic-curve (secp256k1 ECDSA) primitives — the "classical" signature
 * scheme, identical to the curve used by Bitcoin/Ethereum wallets. This is
 * the sole signature mechanism in System A (classical) and forms one half
 * of the dual signature in System B (hybrid post-quantum).
 */

export interface EccKeyPair {
  privateKeyHex: string;
  publicKeyHex: string;
}

/** Generate a fresh secp256k1 key pair, hex-encoded. */
export function eccGenerateKeyPair(): EccKeyPair {
  const { secretKey, publicKey } = secp256k1.keygen();
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

/** Sign a 32-byte message digest, returning a compact-format hex signature. */
export function eccSign(messageHashHex: string, privateKeyHex: string): string {
  const sig = secp256k1.sign(hexToBytes(messageHashHex), hexToBytes(privateKeyHex), {
    format: 'compact',
  });
  return bytesToHex(sig);
}

/** Verify a compact-format hex signature against a message digest and public key. */
export function eccVerify(
  signatureHex: string,
  messageHashHex: string,
  publicKeyHex: string
): boolean {
  try {
    return secp256k1.verify(hexToBytes(signatureHex), hexToBytes(messageHashHex), hexToBytes(publicKeyHex), {
      format: 'compact',
    });
  } catch {
    // Malformed hex / point-not-on-curve / wrong lengths all fail closed.
    return false;
  }
}
