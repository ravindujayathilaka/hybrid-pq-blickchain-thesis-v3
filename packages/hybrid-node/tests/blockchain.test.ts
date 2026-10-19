import { Blockchain, Wallet } from '@thesis/shared';
import { HybridSignatureProvider } from '../src/signatureProvider.js';

describe('HybridSignatureProvider + Blockchain (System B)', () => {
  function setup(difficulty = 2) {
    const provider = new HybridSignatureProvider();
    const chain = new Blockchain(provider, { difficulty });
    const alice = new Wallet(provider);
    const bob = new Wallet(provider);
    return { provider, chain, alice, bob };
  }

  test('addresses encode both an ECC and an ML-DSA public key', () => {
    const { alice } = setup();
    const parts = alice.address.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0); // ECC pubkey hex
    expect(parts[1].length).toBeGreaterThan(0); // ML-DSA pubkey hex
  });

  test('a transaction signed with both ECC and ML-DSA is accepted', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    expect(tx.signature.ecc).toBeDefined();
    expect(tx.signature.pq).toBeDefined();
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(true);
  });

  test('rejected if the ECC signature alone is stripped/forged (PQ signature still valid)', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    tx.signature.ecc = '00'.repeat(64); // forge only the ECC half
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('rejected if the ML-DSA signature alone is stripped/forged (ECC signature still valid)', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    tx.signature.pq = '00'.repeat(64); // forge only the PQ half
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('rejected if the PQ signature field is missing entirely', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    delete (tx.signature as Record<string, string>).pq;
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('a tampered amount invalidates both signatures at once', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    tx.amount = 999;
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('impersonation with a valid dual signature from the wrong wallet is rejected', () => {
    const { chain, alice, bob } = setup();
    const mallory = new Wallet(new HybridSignatureProvider());
    const tx = mallory.createTransaction(bob.address, 10);
    tx.fromAddress = alice.address;
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('mining produces a block satisfying Proof-of-Work and pays the miner', () => {
    const { chain, alice, bob } = setup(3);
    chain.submitTransaction(alice.createTransaction(bob.address, 25));
    const result = chain.minePendingTransactions(bob.address);

    expect(result.block.hash.startsWith('000')).toBe(true);
    expect(result.block.isValid()).toBe(true);
    expect(chain.getBalance(bob.address)).toBe(25 + chain.miningReward);
    expect(chain.isChainValid().valid).toBe(true);
  });

  test('tampering with a mined block is detected by chain validation', () => {
    const { chain, alice, bob } = setup(2);
    chain.submitTransaction(alice.createTransaction(bob.address, 25));
    chain.minePendingTransactions(bob.address);

    chain.chain[1].transactions[0].signature.pq = '11'.repeat(64);

    const validation = chain.isChainValid();
    expect(validation.valid).toBe(false);
    expect(validation.blockIndex).toBe(1);
  });
});
