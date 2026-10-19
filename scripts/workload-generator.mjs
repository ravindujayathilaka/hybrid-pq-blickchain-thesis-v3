#!/usr/bin/env node
/**
 * Workload generator (thesis spec Sections 6 & 7): drives N transactions
 * against a running node at a configurable concurrency, periodically
 * triggers mining to confirm them, and reports throughput/success metrics.
 * Identical logic is used against both systems — only the target URL
 * changes — so the resulting benchmark.csv rows are directly comparable.
 *
 * Usage:
 *   node scripts/workload-generator.mjs \
 *     --url http://localhost:4001 \
 *     --system classical \
 *     --count 1000 \
 *     --mode parallel \
 *     --concurrency 20 \
 *     --ratePerSec 50 \
 *     --mineEvery 50 \
 *     --walletPoolSize 20 \
 *     --experimentDir results/my_run/classical
 *
 * --mode sequential forces concurrency=1 (one transaction fully completes
 * before the next starts). --mode parallel (default) uses --concurrency
 * concurrent workers. --ratePerSec, if set, caps the aggregate dispatch
 * rate to that many tx/sec regardless of concurrency (0/unset = unthrottled).
 *
 * Appends one summary row to <experimentDir>/benchmark.csv and writes the
 * full JSON summary to <experimentDir>/benchmark_<timestamp>.json.
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return {
    url: args.url ?? 'http://localhost:4001',
    system: args.system ?? 'classical',
    count: Number(args.count ?? 1000),
    concurrency: args.mode === 'sequential' ? 1 : Number(args.concurrency ?? 10),
    mode: args.mode === 'sequential' ? 'sequential' : 'parallel',
    // Adjustable transaction rate (spec Section 7): caps the aggregate dispatch
    // rate across all workers to this many tx/sec, independent of concurrency.
    // 0 (default) means unthrottled — dispatch as fast as concurrency allows.
    ratePerSec: Number(args.ratePerSec ?? 0),
    mineEvery: Number(args.mineEvery ?? 50),
    walletPoolSize: Number(args.walletPoolSize ?? 20),
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
      console.error(`[workload] request to ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${reason}`);
      if (isLastAttempt) {
        throw new Error(
          `Request to ${url} failed after ${retries + 1} attempts (${reason}). ` +
          `Is the node still running? Check its log file (logs/<node>.stdout.log) for crashes, ` +
          `and check system CPU/memory (top/htop) — mining briefly saturates CPU on the mining node.`
        );
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // backoff before retry
    }
  }
}

async function createWallet(baseUrl) {
  const { body } = await postJson(`${baseUrl}/wallet`, {});
  return body.walletId;
}

async function mine(baseUrl, minerAddress) {
  // The workload only needs the block timestamp for interval metrics. Avoid
  // returning every large hybrid transaction/signature in the HTTP response.
  const { body } = await postJson(
    `${baseUrl}/mine`,
    { minerAddress, summaryOnly: true },
    { timeoutMs: 60000, retries: 1 }
  );
  return body;
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

  console.log(
    `[workload] system=${cfg.system} url=${cfg.url} count=${cfg.count} mode=${cfg.mode} ` +
    `concurrency=${cfg.concurrency}${cfg.ratePerSec > 0 ? ` rateLimit=${cfg.ratePerSec}/s` : ''}`
  );

  // Rate limiter (spec Section 7's "Adjustable transaction rate"): gates the
  // aggregate dispatch rate across every worker to cfg.ratePerSec tx/sec,
  // independent of how many workers (concurrency) are running. A no-op when
  // ratePerSec is 0 (unthrottled).
  let nextAllowedTime = Date.now();
  const rateIntervalMs = cfg.ratePerSec > 0 ? 1000 / cfg.ratePerSec : 0;
  async function throttle() {
    if (rateIntervalMs <= 0) return;
    const now = Date.now();
    const waitUntil = Math.max(now, nextAllowedTime);
    nextAllowedTime = waitUntil + rateIntervalMs;
    const delay = waitUntil - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  console.log(`[workload] creating ${cfg.walletPoolSize} wallets...`);
  const wallets = [];
  for (let i = 0; i < cfg.walletPoolSize; i++) {
    wallets.push(await createWallet(cfg.url));
  }
  const minerAddress = wallets[0];

  let accepted = 0;
  let rejected = 0;
  let dispatched = 0;
  let minedBlocks = 0;
  const blockTimestamps = [];
  const startedAt = Date.now();

  async function submitOne() {
    await throttle();
    const sender = wallets[Math.floor(Math.random() * wallets.length)];
    let receiver = wallets[Math.floor(Math.random() * wallets.length)];
    while (receiver === sender) receiver = wallets[Math.floor(Math.random() * wallets.length)];

    const { ok, body } = await postJson(`${cfg.url}/wallet/${sender}/transaction`, {
      toAddress: receiver,
      amount: 1,
    });
    if (ok) accepted++;
    else rejected++;
    dispatched++;

    if (accepted > 0 && accepted % cfg.mineEvery === 0) {
      const result = await mine(cfg.url, minerAddress);
      if (result?.block) {
        minedBlocks++;
        blockTimestamps.push(result.block.timestamp);
      }
    }
  }

  // Simple bounded-concurrency worker pool.
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < cfg.count) {
      nextIndex++;
      await submitOne();
      if (nextIndex % Math.max(1, Math.floor(cfg.count / 20)) === 0) {
        process.stdout.write(`\r[workload] progress: ${nextIndex}/${cfg.count}`);
      }
    }
  }
  const workers = Array.from({ length: cfg.concurrency }, () => worker());
  await Promise.all(workers);
  process.stdout.write('\n');

  // Final mine to confirm any remaining pending transactions.
  const finalMine = await mine(cfg.url, minerAddress);
  if (finalMine?.block) {
    minedBlocks++;
    blockTimestamps.push(finalMine.block.timestamp);
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const tps = accepted / elapsedSec;
  const confirmationRate = cfg.count > 0 ? accepted / cfg.count : 0;
  const successRate = confirmationRate;
  const failedTransactionRate = cfg.count > 0 ? rejected / cfg.count : 0;
  const blocksPerMinute = minedBlocks / (elapsedSec / 60);

  let avgBlockIntervalMs = null;
  if (blockTimestamps.length > 1) {
    const intervals = [];
    for (let i = 1; i < blockTimestamps.length; i++) {
      intervals.push(blockTimestamps[i] - blockTimestamps[i - 1]);
    }
    avgBlockIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  }

  const summary = {
    system: cfg.system,
    url: cfg.url,
    requestedCount: cfg.count,
    mode: cfg.mode,
    concurrency: cfg.concurrency,
    ratePerSec: cfg.ratePerSec || null,
    accepted,
    rejected,
    minedBlocks,
    elapsedSec,
    tps,
    blocksPerMinute,
    avgBlockIntervalMs,
    confirmationRate,
    successRate,
    failedTransactionRate,
    timestamp: new Date().toISOString(),
  };

  console.log('[workload] summary:', JSON.stringify(summary, null, 2));

  appendCsvRow(path.join(cfg.experimentDir, 'benchmark.csv'), summary);
  fs.writeFileSync(
    path.join(cfg.experimentDir, `benchmark_${Date.now()}.json`),
    JSON.stringify(summary, null, 2)
  );
}

main().catch((err) => {
  console.error('[workload] fatal error:', err);
  process.exit(1);
});
