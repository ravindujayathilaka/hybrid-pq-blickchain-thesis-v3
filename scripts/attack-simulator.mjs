#!/usr/bin/env node
/**
 * Security attack simulator (thesis spec Section 8). Crafts each required
 * attack type using the *real* signing/hashing code from the compiled
 * packages (not reimplemented here), fires it at a running node's REST
 * API, and records: attack type, expected result, actual result, detection
 * time, and whether the attack succeeded. Writes one row per attack to
 * <experimentDir>/attacks.csv and attacks.json.
 *
 * Two attacks (Tampered Block, Invalid Hash) are evaluated by fetching a
 * real mined chain from the node and re-validating a locally tampered copy
 * with the exact same `Block` class the node uses — this proves detection
 * capability without needing a "please accept this corrupted block" API
 * endpoint, which no real node would expose.
 *
 * Usage:
 *   node scripts/attack-simulator.mjs --url http://localhost:4001 --system classical --experimentDir results/my_run/classical
 *   node scripts/attack-simulator.mjs --url http://localhost:4002 --system hybrid --experimentDir results/my_run/hybrid
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedDist = path.join(__dirname, '..', 'packages', 'shared', 'dist', 'index.js');
const classicalProviderDist = path.join(__dirname, '..', 'packages', 'classical-node', 'dist', 'signatureProvider.js');
const hybridProviderDist = path.join(__dirname, '..', 'packages', 'hybrid-node', 'dist', 'signatureProvider.js');

const { Wallet, Block } = await import(sharedDist);

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return {
    url: args.url ?? 'http://localhost:4001',
    system: args.system ?? 'classical', // 'classical' | 'hybrid'
    experimentDir: args.experimentDir ?? 'results/adhoc/classical',
  };
}

async function postJson(url, body, { timeoutMs = 15000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, body: json };
    } catch (err) {
      const isLastAttempt = attempt === retries;
      const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message;
      console.error(`[attack] request to ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${reason}`);
      if (isLastAttempt) {
        throw new Error(`Request to ${url} failed after ${retries + 1} attempts (${reason}). Is the node still running?`);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function appendCsvRow(csvPath, record) {
  const keys = Object.keys(record);
  const isNew = !fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0;
  if (isNew) fs.appendFileSync(csvPath, keys.join(',') + '\n');
  fs.appendFileSync(csvPath, keys.map((k) => csvEscape(record[k])).join(',') + '\n');
}

async function main() {
  const cfg = parseArgs();
  fs.mkdirSync(cfg.experimentDir, { recursive: true });

  const isHybrid = cfg.system === 'hybrid';
  const ProviderModule = isHybrid ? await import(hybridProviderDist) : await import(classicalProviderDist);
  const provider = isHybrid ? new ProviderModule.HybridSignatureProvider() : new ProviderModule.ClassicalSignatureProvider();

  const alice = new Wallet(provider);
  const bob = new Wallet(provider);

  const results = [];

  function record(attackType, expected, actual, detectionMs, success, notes = '') {
    results.push({
      attackType,
      expectedResult: expected,
      actualResult: actual,
      detectionTimeMs: detectionMs,
      recoveryTimeMs: 0, // node rejects inline; nothing to "recover" — no corrupted state was ever accepted
      attackSucceeded: success,
      notes,
      timestamp: new Date().toISOString(),
    });
    console.log(`[attack] ${attackType}: expected=${expected} actual=${actual} succeeded=${success}`);
  }

  async function attemptTransaction(tx, attackType, notes = '') {
    const t0 = performance.now();
    const { ok, body } = await postJson(`${cfg.url}/transaction`, tx);
    const detectionMs = performance.now() - t0;
    const actual = ok ? 'ACCEPTED' : `REJECTED:${body.reason ?? body.error ?? 'unknown'}`;
    const attackSucceeded = ok; // if the malicious transaction was accepted, the attack worked
    record(attackType, 'REJECTED', actual, detectionMs, attackSucceeded, notes);
  }

  // 1. Invalid ECC Signature
  {
    const tx = alice.createTransaction(bob.address, 5);
    tx.signature = { ...tx.signature, ecc: '00'.repeat(64) };
    await attemptTransaction(tx, 'Invalid ECC Signature');
  }

  // 2. Invalid PQ Signature (hybrid only)
  if (isHybrid) {
    const tx = alice.createTransaction(bob.address, 5);
    tx.signature = { ...tx.signature, pq: '11'.repeat(200) };
    await attemptTransaction(tx, 'Invalid PQ Signature');
  } else {
    record('Invalid PQ Signature', 'N/A', 'N/A (classical system has no PQ signature)', 0, false, 'Not applicable to System A');
  }

  // 3. Replay Attack: resubmit an already-confirmed transaction
  {
    const tx = alice.createTransaction(bob.address, 5);
    const first = await postJson(`${cfg.url}/transaction`, tx);
    if (first.ok) {
      await postJson(`${cfg.url}/mine`, { minerAddress: bob.address }, { timeoutMs: 60000, retries: 1 }); // confirm it, tx.id leaves the pool
    }
    const t0 = performance.now();
    const { ok, body } = await postJson(`${cfg.url}/transaction`, tx); // replay the same signed tx
    const detectionMs = performance.now() - t0;
    const actual = ok ? 'ACCEPTED' : `REJECTED:${body.reason ?? 'unknown'}`;
    record('Replay Attack', 'REJECTED', actual, detectionMs, ok, 'Resubmission of an already-mined transaction');
  }

  // 4. Duplicate Transaction: submit the same unconfirmed tx twice in a row
  {
    const tx = alice.createTransaction(bob.address, 5);
    await postJson(`${cfg.url}/transaction`, tx);
    const t0 = performance.now();
    const { ok, body } = await postJson(`${cfg.url}/transaction`, tx);
    const detectionMs = performance.now() - t0;
    const actual = ok ? 'ACCEPTED' : `REJECTED:${body.reason ?? 'unknown'}`;
    record('Duplicate Transaction', 'REJECTED', actual, detectionMs, ok, 'Immediate resubmission before mining');
  }

  // 5. Forged Signature: entirely fabricated signature block (not derived from any real signing)
  {
    const tx = alice.createTransaction(bob.address, 5);
    tx.signature = isHybrid
      ? { ecc: 'ab'.repeat(64), pq: 'cd'.repeat(200) }
      : { ecc: 'ab'.repeat(64) };
    await attemptTransaction(tx, 'Forged Signature');
  }

  // 6. Tampered Block: fetch a real mined block, tamper a transaction's amount, re-validate locally
  {
    // Ensure there is at least one mined block to fetch.
    const seedTx = alice.createTransaction(bob.address, 1);
    await postJson(`${cfg.url}/transaction`, seedTx);
    await postJson(`${cfg.url}/mine`, { minerAddress: bob.address }, { timeoutMs: 60000, retries: 1 });

    const chainRes = await fetch(`${cfg.url}/chain`);
    const chainBody = await chainRes.json();
    const targetBlockJson = chainBody.chain[chainBody.chain.length - 1];

    const t0 = performance.now();
    const tampered = Block.fromJSON(JSON.parse(JSON.stringify(targetBlockJson)));
    if (tampered.transactions.length > 0) {
      tampered.transactions[0].amount = 999999999;
    }
    const stillValid = tampered.isValid(); // hash won't match recomputed content -> should be false
    const detectionMs = performance.now() - t0;
    record(
      'Tampered Block',
      'REJECTED',
      stillValid ? 'ACCEPTED (undetected!)' : 'REJECTED:HASH_MISMATCH',
      detectionMs,
      stillValid,
      'Amount field mutated post-hash; validity re-checked with the node\'s own Block.isValid()'
    );
  }

  // 7. Invalid Public Key: signature generated by a real key, but fromAddress swapped for garbage
  {
    const tx = alice.createTransaction(bob.address, 5);
    tx.fromAddress = isHybrid ? 'deadbeef.deadbeef' : 'deadbeef';
    await attemptTransaction(tx, 'Invalid Public Key');
  }

  // 8. Invalid Hash: mined block's hash field corrupted directly (not recomputed)
  {
    const chainRes = await fetch(`${cfg.url}/chain`);
    const chainBody = await chainRes.json();
    const targetBlockJson = chainBody.chain[chainBody.chain.length - 1];

    const t0 = performance.now();
    const tampered = Block.fromJSON(JSON.parse(JSON.stringify(targetBlockJson)));
    tampered.hash = 'f'.repeat(64);
    const stillValid = tampered.isValid();
    const detectionMs = performance.now() - t0;
    record(
      'Invalid Hash',
      'REJECTED',
      stillValid ? 'ACCEPTED (undetected!)' : 'REJECTED:HASH_MISMATCH',
      detectionMs,
      stillValid,
      'Hash field overwritten directly, content unchanged'
    );
  }

  // 9. Double Spending Attempt: replay an already-confirmed transaction to try to re-credit funds.
  // NOTE (limitation, documented for the thesis): this prototype does not enforce account balances
  // or UTXO tracking on submission, so true "insufficient funds" double-spend cannot be tested here.
  // What IS tested and enforced is that the same signed transaction cannot be re-confirmed twice,
  // which is the specific double-spend vector this prototype is exposed to.
  {
    const tx = alice.createTransaction(bob.address, 5);
    const first = await postJson(`${cfg.url}/transaction`, tx);
    if (first.ok) {
      await postJson(`${cfg.url}/mine`, { minerAddress: bob.address }, { timeoutMs: 60000, retries: 1 });
    }
    const t0 = performance.now();
    const { ok, body } = await postJson(`${cfg.url}/transaction`, tx);
    const detectionMs = performance.now() - t0;
    const actual = ok ? 'ACCEPTED' : `REJECTED:${body.reason ?? 'unknown'}`;
    record(
      'Double Spending Attempt',
      'REJECTED',
      actual,
      detectionMs,
      ok,
      'Prototype limitation: tests replay-based double-spend only, not balance-insufficiency double-spend (see README)'
    );
  }

  for (const r of results) {
    appendCsvRow(path.join(cfg.experimentDir, 'attacks.csv'), { system: cfg.system, ...r });
  }
  fs.writeFileSync(
    path.join(cfg.experimentDir, `attacks_${Date.now()}.json`),
    JSON.stringify(results, null, 2)
  );

  const detectedCount = results.filter((r) => !r.attackSucceeded).length;
  console.log(`\n[attack] ${detectedCount}/${results.length} attacks correctly blocked.`);
}

main().catch((err) => {
  console.error('[attack] fatal error:', err);
  process.exit(1);
});
