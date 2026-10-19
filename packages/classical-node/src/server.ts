import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import {
  Blockchain,
  BlockchainType,
  BlockRecord,
  COINBASE_ADDRESS,
  MetricsRecorder,
  ResourceSampler,
  SignatureProvider,
  Transaction,
  TransactionRecord,
  Wallet,
} from '@thesis/shared';
import type { Logger } from 'winston';
import { createPeerManager, PeerManager } from './peers.js';

export interface BuiltServer {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  peerManager: PeerManager;
  resourceSampler: ResourceSampler;
  minedBlockCount: () => number;
}

/**
 * Builds the REST + WebSocket surface for a node. This exact same factory
 * shape (routes, request/response contracts) is reused by `hybrid-node` —
 * only the `Blockchain`/`SignatureProvider` instance passed in differs —
 * so that System A and System B expose byte-identical APIs, as required
 * by the research design for a fair benchmark.
 *
 * Every route that touches a transaction or a block also feeds the
 * `MetricsRecorder`, so `results/<experiment>/transactions.csv` and
 * `blocks.csv` accumulate automatically as the node operates — no
 * separate instrumentation pass is needed on top of normal usage.
 */
export function buildServer(
  chain: Blockchain,
  signatureProvider: SignatureProvider,
  logger: Logger,
  nodeLabel: string,
  peerUrls: string[] = [],
  metrics?: MetricsRecorder
): BuiltServer {
  const blockchainType: BlockchainType = signatureProvider.name.includes('ML-DSA') ? 'Hybrid' : 'Classical';

  const app = express();
  app.use(cors());
  app.use(express.json());

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

  // In-memory wallet registry for demo/benchmark purposes only. A wallet's
  // private key material never leaves this process; only its address
  // (public key material) is ever exposed over the API.
  const wallets = new Map<string, Wallet>();

  // Signing timing is only observable at the moment a *this node's* wallet
  // signs a transaction (an already-signed tx submitted to /transaction was
  // signed elsewhere). Cached here so /mine can attach it to the final
  // transaction record; cleared once consumed.
  const pendingSignTimings = new Map<string, Record<string, number>>();

  let minedBlocks = 0;
  const resourceSampler = new ResourceSampler();
  const peerManager = createPeerManager(chain, peerUrls, nodeLabel, logger, metrics, blockchainType, resourceSampler);

  io.on('connection', (socket) => {
    logger.info('inbound peer connection', { socketId: socket.id });
    peerManager.attachInboundSocket(socket);
  });

  function recordRejectedTransaction(tx: Partial<Transaction>, result: { reason?: string; sizeBytes: number; receivedAt: number; verifiedAt: number; verifyTimingsMs?: Record<string, number>; validityByAlgorithm?: Record<string, boolean> }) {
    if (!metrics) return;
    const sample = resourceSampler.sample();
    const record: TransactionRecord = {
      transactionId: tx.id ?? 'unknown',
      blockchainType,
      nodeId: nodeLabel,
      nodeRole: 'miner', // rejection happened on the node the client submitted directly to
      blockNumber: null,
      createdAt: tx.timestamp ?? result.receivedAt,
      receivedAt: result.receivedAt,
      verifiedAt: result.verifiedAt,
      confirmedAt: null,
      latencyMs: null,
      eccSignGenMs: null,
      pqSignGenMs: null,
      eccVerifyMs: result.verifyTimingsMs?.ecc ?? null,
      pqVerifyMs: result.verifyTimingsMs?.pq ?? null,
      combinedSignGenMs: null,
      combinedVerifyMs: result.verifyTimingsMs?.total ?? null,
      totalSignatureProcessingMs: result.verifyTimingsMs?.total ?? null,
      miningTimeContributionMs: null,
      sizeBytes: result.sizeBytes,
      cpuPercent: sample.cpuPercent,
      memoryMb: sample.memoryMb,
      networkDelayMs: null,
      accepted: false,
      failureReason: result.reason ?? 'UNKNOWN',
      replayAttackDetected: result.reason === 'DUPLICATE_ID',
      signatureValid: result.validityByAlgorithm?.ecc ?? null,
      pqSignatureValid: result.validityByAlgorithm?.pq ?? null,
    };
    metrics.recordTransaction(record);
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      node: nodeLabel,
      signatureScheme: signatureProvider.name,
      chainLength: chain.chain.length,
      pendingTransactions: chain.pool.size(),
      peers: peerManager.getPeerStatus(),
    });
  });

  app.get('/chain', (_req, res) => {
    res.json({
      length: chain.chain.length,
      difficulty: chain.difficulty,
      chain: chain.chain.map((b) => b.toJSON()),
    });
  });

  app.get('/chain/validate', (_req, res) => {
    res.json(chain.isChainValid());
  });

  app.get('/balance/:address', (req, res) => {
    res.json({ address: req.params.address, balance: chain.getBalance(req.params.address) });
  });

  app.get('/pool', (_req, res) => {
    res.json({ size: chain.pool.size(), transactions: chain.pool.all() });
  });

  // Network-level metrics — this is what distinguishes a multi-node
  // benchmark from a single-node one. /peers shows current mesh
  // connectivity; /metrics/propagation shows, per received block, how
  // long it took to arrive from the mining node and how many bytes it was.
  app.get('/peers', (_req, res) => {
    res.json({ node: nodeLabel, peers: peerManager.getPeerStatus() });
  });

  app.get('/metrics/propagation', (_req, res) => {
    res.json({ node: nodeLabel, records: peerManager.getPropagationLog() });
  });

  app.get('/metrics/resources', (_req, res) => {
    res.json({ node: nodeLabel, ...resourceSampler.sample() });
  });

  app.get('/metrics/network', (_req, res) => {
    res.json({
      node: nodeLabel,
      ...peerManager.getBandwidthCounters(),
      ...peerManager.getMessageCounters(),
    });
  });

  // Demo/benchmark convenience endpoint: creates a server-held wallet and
  // returns its id + public address. Real deployments would sign
  // client-side and only ever POST an already-signed transaction to /transaction.
  app.post('/wallet', (_req, res) => {
    const wallet = new Wallet(signatureProvider);
    const id = wallet.address;
    wallets.set(id, wallet);
    res.status(201).json({ walletId: id, address: wallet.address });
  });

  app.post('/wallet/:walletId/transaction', (req: Request, res: Response) => {
    const wallet = wallets.get(String(req.params.walletId));
    if (!wallet) {
      return res.status(404).json({ error: 'Unknown walletId' });
    }
    const { toAddress, amount } = req.body ?? {};
    if (typeof toAddress !== 'string' || typeof amount !== 'number') {
      return res.status(400).json({ error: 'toAddress (string) and amount (number) are required' });
    }
    try {
      const { transaction, signTimingsMs } = wallet.createTransactionWithMetrics(toAddress, amount);
      const result = chain.submitTransaction(transaction);
      if (!result.accepted) {
        recordRejectedTransaction(transaction, result);
        return res.status(422).json({ error: 'Transaction rejected', reason: result.reason });
      }
      pendingSignTimings.set(transaction.id, signTimingsMs); // consumed at mine time
      io.emit('transaction:new', transaction);
      res.status(201).json({ transaction });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Accepts an already-signed transaction directly (used by the benchmark
  // module, which signs off-node to measure signature generation time
  // independently of network/API overhead).
  app.post('/transaction', (req: Request, res: Response) => {
    const tx = req.body as Transaction;
    const result = chain.submitTransaction(tx);
    if (!result.accepted) {
      recordRejectedTransaction(tx, result);
      return res.status(422).json({ error: 'Transaction rejected', reason: result.reason });
    }
    io.emit('transaction:new', tx);
    res.status(201).json({ accepted: true });
  });

  app.post('/mine', (req: Request, res: Response) => {
    const { minerAddress } = req.body ?? {};
    if (typeof minerAddress !== 'string') {
      return res.status(400).json({ error: 'minerAddress (string) is required' });
    }
    const result = chain.minePendingTransactions(minerAddress);
    minedBlocks++;

    logger.info('block mined', {
      index: result.block.index,
      durationMs: result.durationMs,
      attempts: result.attempts,
      transactionCount: result.transactionCount,
    });

    if (metrics) {
      const sample = resourceSampler.sample();
      const perTxMiningShare = result.transactionCount > 0 ? result.durationMs / result.transactionCount : 0;

      for (const { transaction, meta } of result.transactionEntries) {
        if (transaction.fromAddress === COINBASE_ADDRESS) continue; // reward tx isn't user-signed; excluded from tx-level metrics
        const signTimings = pendingSignTimings.get(transaction.id);
        pendingSignTimings.delete(transaction.id);

        const combinedSignGenMs = signTimings?.total ?? null;
        const combinedVerifyMs = meta?.verifyTimingsMs.total ?? null;

        const record: TransactionRecord = {
          transactionId: transaction.id,
          blockchainType,
          nodeId: nodeLabel,
          nodeRole: 'miner',
          blockNumber: result.block.index,
          createdAt: transaction.timestamp,
          receivedAt: meta?.receivedAt ?? transaction.timestamp,
          verifiedAt: meta?.verifiedAt ?? transaction.timestamp,
          confirmedAt: result.block.timestamp,
          latencyMs: result.block.timestamp - transaction.timestamp,
          eccSignGenMs: signTimings?.ecc ?? null,
          pqSignGenMs: signTimings?.pq ?? null,
          eccVerifyMs: meta?.verifyTimingsMs.ecc ?? null,
          pqVerifyMs: meta?.verifyTimingsMs.pq ?? null,
          combinedSignGenMs,
          combinedVerifyMs,
          totalSignatureProcessingMs:
            combinedSignGenMs !== null || combinedVerifyMs !== null
              ? (combinedSignGenMs ?? 0) + (combinedVerifyMs ?? 0)
              : null,
          miningTimeContributionMs: perTxMiningShare,
          sizeBytes: meta?.sizeBytes ?? Buffer.byteLength(JSON.stringify(transaction)),
          cpuPercent: sample.cpuPercent,
          memoryMb: sample.memoryMb,
          networkDelayMs: null, // this IS the mining node; there is no propagation delay to itself
          accepted: true,
          failureReason: null,
          replayAttackDetected: false,
          signatureValid: meta?.validityByAlgorithm?.ecc ?? true,
          pqSignatureValid: meta?.validityByAlgorithm?.pq ?? null,
        };
        metrics.recordTransaction(record);
      }

      const blockRecord: BlockRecord = {
        blockchainType,
        nodeId: nodeLabel,
        blockHeight: result.block.index,
        previousHash: result.block.previousHash,
        currentHash: result.block.hash,
        blockSizeBytes: Buffer.byteLength(JSON.stringify(result.block.toJSON())),
        transactionCount: result.transactionCount,
        miningTimeMs: result.durationMs,
        hashingTimeMs: result.hashingTimeMs,
        validationTimeMs: result.validationTimeMs,
        difficulty: result.block.difficulty,
        nonce: result.block.nonce,
        timestamp: result.block.timestamp,
        cpuPercent: sample.cpuPercent,
        memoryMb: sample.memoryMb,
      };
      metrics.recordBlock(blockRecord);
    }

    io.emit('chain:update', chain.chain.map((b) => b.toJSON()));
    peerManager.broadcastBlock(result.block); // propagate to the P2P network
    res.status(201).json({
      block: result.block.toJSON(),
      durationMs: result.durationMs,
      attempts: result.attempts,
      transactionCount: result.transactionCount,
      hashingTimeMs: result.hashingTimeMs,
      validationTimeMs: result.validationTimeMs,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled request error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, httpServer, io, peerManager, resourceSampler, minedBlockCount: () => minedBlocks };
}
