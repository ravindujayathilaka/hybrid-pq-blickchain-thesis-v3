import fs from 'node:fs';
import path from 'node:path';
import { Blockchain, MetricsRecorder, NodeSampleRecord } from '@thesis/shared';
import { HybridSignatureProvider } from './signatureProvider.js';
import { buildServer } from './server.js';
import { createLogger } from './logger.js';

const PORT = Number(process.env.PORT ?? 4002);
const DIFFICULTY = Number(process.env.DIFFICULTY ?? 4);
const NODE_LABEL = process.env.NODE_LABEL ?? 'hybrid-node';
// Comma-separated list of peer base URLs, e.g. "http://localhost:4011,http://localhost:4021"
const PEERS = (process.env.PEERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Where to write transactions.csv/json, blocks.csv/json, nodes.csv, network.csv, sync.csv.
// Defaults to a fresh timestamped folder so repeated runs don't clobber each other.
const EXPERIMENT_DIR =
  process.env.EXPERIMENT_DIR ?? path.join('results', `experiment_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 1000);

const logger = createLogger(NODE_LABEL);
const signatureProvider = new HybridSignatureProvider();
const chain = new Blockchain(signatureProvider, { difficulty: DIFFICULTY });
const metrics = new MetricsRecorder(EXPERIMENT_DIR);

const { httpServer, io, peerManager, resourceSampler, minedBlockCount } = buildServer(
  chain,
  signatureProvider,
  logger,
  NODE_LABEL,
  PEERS,
  metrics
);

// Node-level continuous monitoring: CPU, memory, disk, bandwidth, connections,
// pending transactions, mined block count, verification queue length, P2P
// message counts. Verification in this architecture is synchronous at
// submission time (no separate async queue), so verificationQueueLength
// mirrors pendingTransactions.
let lastBandwidth = { totalBytesSent: 0, totalBytesReceived: 0, at: Date.now() };

const samplerInterval = setInterval(() => {
  const { cpuPercent, memoryMb } = resourceSampler.sample();
  const bandwidthNow = peerManager.getBandwidthCounters();
  const { messagesSent, messagesReceived } = peerManager.getMessageCounters();
  const diskUsageMb = dirSizeMb(EXPERIMENT_DIR);

  // Bandwidth counters are cumulative since process start; the rate is the
  // DELTA since the last sample divided by the actual elapsed time (not the
  // configured interval, which can drift under load).
  const elapsedSec = (Date.now() - lastBandwidth.at) / 1000;
  const deltaBytes =
    bandwidthNow.totalBytesSent -
    lastBandwidth.totalBytesSent +
    (bandwidthNow.totalBytesReceived - lastBandwidth.totalBytesReceived);
  const bandwidthBytesPerSec = elapsedSec > 0 ? deltaBytes / elapsedSec : 0;
  lastBandwidth = { ...bandwidthNow, at: Date.now() };

  const record: NodeSampleRecord = {
    nodeId: NODE_LABEL,
    blockchainType: 'Hybrid',
    timestamp: Date.now(),
    cpuPercent,
    memoryMb,
    diskUsageMb,
    networkBandwidthBytesPerSec: bandwidthBytesPerSec,
    activeConnections: io.engine.clientsCount,
    pendingTransactions: chain.pool.size(),
    minedBlocks: minedBlockCount(),
    verificationQueueLength: chain.pool.size(),
    messagesSent,
    messagesReceived,
  };
  metrics.recordNodeSample(record);
}, SAMPLE_INTERVAL_MS);

function dirSizeMb(dir: string): number {
  try {
    let total = 0;
    for (const file of fs.readdirSync(dir)) {
      const stat = fs.statSync(path.join(dir, file));
      if (stat.isFile()) total += stat.size;
    }
    return total / (1024 * 1024);
  } catch {
    return 0;
  }
}

function shutdown() {
  logger.info('shutting down, flushing metrics', { experimentDir: EXPERIMENT_DIR });
  clearInterval(samplerInterval);
  metrics.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, () => {
  logger.info(`${NODE_LABEL} listening`, {
    port: PORT,
    signatureScheme: signatureProvider.name,
    difficulty: DIFFICULTY,
    peers: PEERS,
    experimentDir: EXPERIMENT_DIR,
  });
  peerManager.connectToPeers();
});
