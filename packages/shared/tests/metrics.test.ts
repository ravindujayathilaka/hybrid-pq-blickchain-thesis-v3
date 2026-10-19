import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetricsRecorder } from '../src/metrics/recorder.js';
import { ResourceSampler } from '../src/metrics/resourceSampler.js';
import { TransactionRecord, BlockRecord } from '../src/metrics/types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
}

function sampleTxRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: 'tx-1',
    blockchainType: 'Classical',
    nodeId: 'classical-1',
    nodeRole: 'miner',
    blockNumber: 1,
    createdAt: 1000,
    receivedAt: 1001,
    verifiedAt: 1002,
    confirmedAt: 1010,
    latencyMs: 10,
    eccSignGenMs: 0.5,
    pqSignGenMs: null,
    eccVerifyMs: 0.4,
    pqVerifyMs: null,
    combinedSignGenMs: 0.5,
    combinedVerifyMs: 0.4,
    totalSignatureProcessingMs: 0.9,
    miningTimeContributionMs: 5,
    sizeBytes: 300,
    cpuPercent: 12.5,
    memoryMb: 45.2,
    networkDelayMs: null,
    accepted: true,
    failureReason: null,
    replayAttackDetected: false,
    signatureValid: true,
    pqSignatureValid: null,
    ...overrides,
  };
}

function sampleBlockRecord(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockchainType: 'Classical',
    nodeId: 'classical-1',
    blockHeight: 1,
    previousHash: '0'.repeat(64),
    currentHash: 'a'.repeat(64),
    blockSizeBytes: 1200,
    transactionCount: 3,
    miningTimeMs: 120,
    hashingTimeMs: 0.02,
    validationTimeMs: 0.03,
    difficulty: 3,
    nonce: 4821,
    timestamp: Date.now(),
    cpuPercent: 20,
    memoryMb: 50,
    ...overrides,
  };
}

describe('MetricsRecorder', () => {
  test('writes a CSV header once, then one row per record', () => {
    const dir = tmpDir();
    const recorder = new MetricsRecorder(dir);
    recorder.recordTransaction(sampleTxRecord({ transactionId: 'tx-1' }));
    recorder.recordTransaction(sampleTxRecord({ transactionId: 'tx-2' }));

    const csv = fs.readFileSync(path.join(dir, 'transactions.csv'), 'utf-8').trim().split('\n');
    expect(csv).toHaveLength(3); // header + 2 rows
    expect(csv[0]).toContain('transactionId');
    expect(csv[1]).toContain('tx-1');
    expect(csv[2]).toContain('tx-2');
  });

  test('flush() writes a valid JSON array containing all records', () => {
    const dir = tmpDir();
    const recorder = new MetricsRecorder(dir);
    recorder.recordBlock(sampleBlockRecord({ blockHeight: 1 }));
    recorder.recordBlock(sampleBlockRecord({ blockHeight: 2 }));
    recorder.flush();

    const json = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf-8'));
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
    expect(json[0].blockHeight).toBe(1);
    expect(json[1].blockHeight).toBe(2);
  });

  test('CSV-escapes values containing commas, quotes, or newlines', () => {
    const dir = tmpDir();
    const recorder = new MetricsRecorder(dir);
    recorder.recordTransaction(sampleTxRecord({ failureReason: 'bad, "weird" value' }));

    const csv = fs.readFileSync(path.join(dir, 'transactions.csv'), 'utf-8');
    expect(csv).toContain('"bad, ""weird"" value"');
  });

  test('null and undefined values are written as empty CSV cells, not the string "null"', () => {
    const dir = tmpDir();
    const recorder = new MetricsRecorder(dir);
    recorder.recordTransaction(sampleTxRecord({ pqSignGenMs: null, networkDelayMs: null }));

    const csv = fs.readFileSync(path.join(dir, 'transactions.csv'), 'utf-8');
    expect(csv).not.toMatch(/,null,/);
  });

  test('separate record types go to separate files', () => {
    const dir = tmpDir();
    const recorder = new MetricsRecorder(dir);
    recorder.recordTransaction(sampleTxRecord());
    recorder.recordBlock(sampleBlockRecord());
    recorder.flush();

    expect(fs.existsSync(path.join(dir, 'transactions.csv'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'blocks.csv'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'transactions.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'blocks.json'))).toBe(true);
  });
});

describe('ResourceSampler', () => {
  test('sample() returns non-negative CPU percent and positive memory', () => {
    const sampler = new ResourceSampler();
    // Burn a little CPU so the first delta isn't trivially zero.
    let x = 0;
    for (let i = 0; i < 1e6; i++) x += i;

    const result = sampler.sample();
    expect(result.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(result.memoryMb).toBeGreaterThan(0);
  });

  test('successive samples reset the baseline (each call measures its own window)', () => {
    const sampler = new ResourceSampler();
    const first = sampler.sample();
    const second = sampler.sample();
    expect(typeof first.cpuPercent).toBe('number');
    expect(typeof second.cpuPercent).toBe('number');
  });
});
