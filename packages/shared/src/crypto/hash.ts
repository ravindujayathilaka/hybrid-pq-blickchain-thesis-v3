import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Deterministic SHA-256 hashing utilities used across both the classical
 * and hybrid nodes. Kept in `shared` so that block hashing behaviour is
 * byte-for-byte identical between System A and System B, isolating the
 * experimental variable to the signature layer only.
 */

/** Hash an arbitrary UTF-8 string, returning lowercase hex. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** Hash arbitrary bytes, returning raw digest bytes. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  return sha256(input);
}

/** Hash a canonicalised JS value (stable key order) to hex. */
export function sha256OfObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Produces a canonical JSON string with recursively sorted object keys so
 * that hashing is deterministic regardless of property insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
