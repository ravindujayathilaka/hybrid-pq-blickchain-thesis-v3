import { Blockchain, Wallet } from '@thesis/shared';
import { ClassicalSignatureProvider } from '../src/signatureProvider.js';

describe('ClassicalSignatureProvider + Blockchain (System A)', () => {
  function setup(difficulty = 2) {
    const provider = new ClassicalSignatureProvider();
    const chain = new Blockchain(provider, { difficulty });
    const alice = new Wallet(provider);
    const bob = new Wallet(provider);
    return { provider, chain, alice, bob };
  }

  test('genesis block is present and chain starts valid', () => {
    const { chain } = setup();
    expect(chain.chain).toHaveLength(1);
    expect(chain.chain[0].index).toBe(0);
    expect(chain.isChainValid().valid).toBe(true);
  });

  test('a correctly signed transaction is accepted into the pool', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(true);
    expect(chain.pool.size()).toBe(1);
  });

  test('a transaction with a tampered amount (after signing) is rejected', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    tx.amount = 1000; // tamper after signing
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('a forged signature (random bytes, correct sender address) is rejected', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    tx.signature = { ecc: '00'.repeat(64) };
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test("a valid signature from the wrong wallet (impersonation) is rejected", () => {
    const { chain, alice, bob } = setup();
    const mallory = new Wallet(new ClassicalSignatureProvider());
    const tx = mallory.createTransaction(bob.address, 10);
    tx.fromAddress = alice.address; // claim to be alice, but signed by mallory's key
    const result = chain.submitTransaction(tx);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  test('duplicate transaction ids are rejected', () => {
    const { chain, alice, bob } = setup();
    const tx = alice.createTransaction(bob.address, 10);
    expect(chain.submitTransaction(tx).accepted).toBe(true);
    expect(chain.submitTransaction(tx).accepted).toBe(false);
  });

  test('a transaction id that was already mined cannot be replayed after leaving the pool', () => {
    const { chain, alice, bob } = setup(2);
    const tx = alice.createTransaction(bob.address, 10);
    expect(chain.submitTransaction(tx).accepted).toBe(true);
    chain.minePendingTransactions(bob.address); // tx.id leaves the pending pool, now confirmed on-chain

    const replay = chain.submitTransaction(tx); // attacker resubmits the exact same signed transaction
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toBe('DUPLICATE_ID');
  });

  test('non-positive amounts are rejected', () => {
    const { chain, alice, bob } = setup();
    expect(() => alice.createTransaction(bob.address, 0)).toThrow();
    expect(() => alice.createTransaction(bob.address, -5)).toThrow();
  });

  test('mining produces a block satisfying Proof-of-Work and pays the miner', () => {
    const { chain, alice, bob } = setup(3);
    chain.submitTransaction(alice.createTransaction(bob.address, 25));
    const result = chain.minePendingTransactions(bob.address);

    expect(result.block.hash.startsWith('000')).toBe(true);
    expect(result.block.isValid()).toBe(true);
    expect(chain.pool.size()).toBe(0);
    expect(chain.getBalance(bob.address)).toBe(25 + chain.miningReward);
    expect(chain.getBalance(alice.address)).toBe(-25);
    expect(chain.isChainValid().valid).toBe(true);
  });

  test('tampering with a mined block is detected by chain validation', () => {
    const { chain, alice, bob } = setup(2);
    chain.submitTransaction(alice.createTransaction(bob.address, 25));
    chain.minePendingTransactions(bob.address);

    // Attacker mutates a confirmed transaction amount directly on-chain.
    chain.chain[1].transactions[0].amount = 999999;

    const validation = chain.isChainValid();
    expect(validation.valid).toBe(false);
    expect(validation.blockIndex).toBe(1);
  });

  test('replaceChain only accepts a longer, fully valid chain', () => {
    const { chain, alice, bob } = setup(2);
    chain.minePendingTransactions(bob.address);
    const shorterOrEqual = chain.replaceChain([...chain.chain]);
    expect(shorterOrEqual.replaced).toBe(false);
  });
});
