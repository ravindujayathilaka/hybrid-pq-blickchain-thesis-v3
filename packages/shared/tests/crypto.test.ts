import { eccGenerateKeyPair, eccSign, eccVerify } from '../src/crypto/ecc.js';
import { pqGenerateKeyPair, pqSign, pqVerify } from '../src/crypto/pqc.js';
import { sha256Hex, canonicalJson } from '../src/crypto/hash.js';
import { Block } from '../src/block.js';

describe('ECC (secp256k1) primitives', () => {
  test('sign/verify round-trip succeeds for a matching key pair', () => {
    const { privateKeyHex, publicKeyHex } = eccGenerateKeyPair();
    const digest = sha256Hex('hello world');
    const sig = eccSign(digest, privateKeyHex);
    expect(eccVerify(sig, digest, publicKeyHex)).toBe(true);
  });

  test('verification fails with the wrong public key', () => {
    const a = eccGenerateKeyPair();
    const b = eccGenerateKeyPair();
    const digest = sha256Hex('hello world');
    const sig = eccSign(digest, a.privateKeyHex);
    expect(eccVerify(sig, digest, b.publicKeyHex)).toBe(false);
  });

  test('verification fails gracefully (no throw) on malformed hex input', () => {
    expect(eccVerify('not-hex', 'also-not-hex', 'nope')).toBe(false);
  });
});

describe('ML-DSA-65 (post-quantum) primitives', () => {
  test('sign/verify round-trip succeeds for a matching key pair', () => {
    const { secretKeyHex, publicKeyHex } = pqGenerateKeyPair();
    const sig = pqSign('hello world', secretKeyHex);
    expect(pqVerify(sig, 'hello world', publicKeyHex)).toBe(true);
  });

  test('verification fails if the message changes after signing', () => {
    const { secretKeyHex, publicKeyHex } = pqGenerateKeyPair();
    const sig = pqSign('hello world', secretKeyHex);
    expect(pqVerify(sig, 'goodbye world', publicKeyHex)).toBe(false);
  });

  test('verification fails gracefully (no throw) on malformed hex input', () => {
    expect(pqVerify('zz', 'msg', 'zz')).toBe(false);
  });
});

describe('canonicalJson', () => {
  test('produces identical output regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = canonicalJson({ a: 2, nested: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
  });
});

describe('Block Proof-of-Work', () => {
  test('mine() finds a hash meeting the difficulty target', () => {
    const block = new Block({
      index: 1,
      timestamp: Date.now(),
      transactions: [],
      previousHash: '0'.repeat(64),
      nonce: 0,
      difficulty: 3,
    });
    const { attempts } = block.mine();
    expect(block.hash.startsWith('000')).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(0);
    expect(block.isValid()).toBe(true);
  });

  test('isValid() detects a hash that no longer matches recomputed content', () => {
    const block = new Block({
      index: 1,
      timestamp: Date.now(),
      transactions: [],
      previousHash: '0'.repeat(64),
      nonce: 0,
      difficulty: 1,
    });
    block.mine();
    block.hash = 'f'.repeat(64); // corrupt the stored hash
    expect(block.isValid()).toBe(false);
  });

  test('isValid() alone (no separate signature check) detects transaction field tampering, not just id/signature tampering', () => {
    const block = new Block({
      index: 1,
      timestamp: Date.now(),
      transactions: [
        {
          id: 'tx-1',
          fromAddress: 'alice',
          toAddress: 'bob',
          amount: 10,
          timestamp: Date.now(),
          nonce: 'n1',
          signature: { ecc: 'deadbeef' },
        },
      ],
      previousHash: '0'.repeat(64),
      nonce: 0,
      difficulty: 1,
    });
    block.mine();
    expect(block.isValid()).toBe(true);

    block.transactions[0].amount = 999999; // tamper amount only; id and signature untouched
    expect(block.isValid()).toBe(false);
  });
});
