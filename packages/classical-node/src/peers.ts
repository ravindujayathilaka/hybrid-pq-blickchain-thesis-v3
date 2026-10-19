import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { Socket as ServerSocket } from 'socket.io';
import {
  Block,
  Blockchain,
  BlockchainType,
  BlockRecord,
  COINBASE_ADDRESS,
  MetricsRecorder,
  ResourceSampler,
  SerializedBlock,
  TransactionRecord,
} from '@thesis/shared';
import type { Logger } from 'winston';

export interface PropagationRecord {
  blockIndex: number;
  fromNode: string;
  toNode: string;
  sentAt: number;
  receivedAt: number;
  propagationMs: number;
  blockBytes: number;
  accepted: boolean;
  reason?: string;
}

interface BlockAnnouncePayload {
  block: SerializedBlock;
  fromNode: string;
  sentAt: number;
}

interface PendingSync {
  triggeredAt: number;
  chainLengthBefore: number;
  peerLabel: string;
}

export interface PeerManager {
  /** Opens outbound connections to every configured peer. Call once at startup. */
  connectToPeers(): void;
  /** Wires the gossip protocol onto a socket accepted by our own Socket.IO server. */
  attachInboundSocket(socket: ServerSocket): void;
  /** Send a freshly mined block to every connected peer and record the send time. */
  broadcastBlock(block: Block): void;
  getPeerStatus(): { url: string; connected: boolean }[];
  getPropagationLog(): PropagationRecord[];
  /** Cumulative bytes sent/received via block gossip since process start — used to derive bytes/sec. */
  getBandwidthCounters(): { totalBytesSent: number; totalBytesReceived: number };
  /** Cumulative P2P message counts since process start (spec Section 4: "Message count"). */
  getMessageCounters(): { messagesSent: number; messagesReceived: number };
}

/**
 * Real (if minimal) P2P gossip: nodes connect directly to every peer listed
 * in their `PEERS` config (full mesh for a small experimental network).
 * When a node mines a block it broadcasts `block:announce` with a send
 * timestamp; every receiving peer records how long propagation took and
 * how many bytes the block was, AND writes its own transaction/block
 * metric records (nodeRole: 'receiver') — so `transactions.csv` reflects
 * every node's view of the network, not just the miner's, and
 * `networkDelayMs` can actually be populated. Blocks that arrive out of
 * order (the receiver fell behind by more than one block) trigger a full
 * chain-resync request, timed for the "average synchronization time"
 * metric (spec Section 4).
 */
export function createPeerManager(
  chain: Blockchain,
  peerUrls: string[],
  nodeLabel: string,
  logger: Logger,
  metrics?: MetricsRecorder,
  blockchainType?: BlockchainType,
  resourceSampler?: ResourceSampler
): PeerManager {
  const outboundSockets = new Map<string, ClientSocket>();
  const peerLabelBySocket = new Map<ClientSocket | ServerSocket, string>();
  const pendingSyncs = new Map<ClientSocket | ServerSocket, PendingSync>();
  const propagationLog: PropagationRecord[] = [];
  const seenBlockHashes = new Set<string>();
  let totalBytesSent = 0;
  let totalBytesReceived = 0;
  let messagesSent = 0;
  let messagesReceived = 0;

  function rememberSeen(hash: string) {
    seenBlockHashes.add(hash);
    if (seenBlockHashes.size > 2000) {
      const oldest = seenBlockHashes.values().next().value;
      if (oldest) seenBlockHashes.delete(oldest);
    }
  }

  function recordReceivedTransactions(
    block: Block,
    propagationMs: number,
    validationTimeMs: number,
    transactionEntries: NonNullable<ReturnType<Blockchain['appendReceivedBlock']>['transactionEntries']>
  ) {
    if (!metrics || !blockchainType) return;
    const sample = resourceSampler?.sample();
    for (const { transaction, verifyTimingsMs, validityByAlgorithm } of transactionEntries) {
      const record: TransactionRecord = {
        transactionId: transaction.id,
        blockchainType,
        nodeId: nodeLabel,
        nodeRole: 'receiver',
        blockNumber: block.index,
        createdAt: transaction.timestamp,
        receivedAt: Date.now(),
        verifiedAt: Date.now(),
        confirmedAt: block.timestamp,
        latencyMs: block.timestamp - transaction.timestamp,
        eccSignGenMs: null, // this node did not generate the signature; only the originating wallet knows that timing
        pqSignGenMs: null,
        eccVerifyMs: verifyTimingsMs?.ecc ?? null,
        pqVerifyMs: verifyTimingsMs?.pq ?? null,
        combinedSignGenMs: null,
        combinedVerifyMs: verifyTimingsMs?.total ?? null,
        totalSignatureProcessingMs: verifyTimingsMs?.total ?? null,
        miningTimeContributionMs: null,
        sizeBytes: Buffer.byteLength(JSON.stringify(transaction)),
        cpuPercent: sample?.cpuPercent ?? null,
        memoryMb: sample?.memoryMb ?? null,
        networkDelayMs: propagationMs,
        accepted: true,
        failureReason: null,
        replayAttackDetected: false,
        signatureValid: validityByAlgorithm?.ecc ?? true,
        pqSignatureValid: validityByAlgorithm?.pq ?? null,
      };
      metrics.recordTransaction(record);
    }

    const blockRecord: BlockRecord = {
      blockchainType,
      nodeId: nodeLabel,
      blockHeight: block.index,
      previousHash: block.previousHash,
      currentHash: block.hash,
      blockSizeBytes: Buffer.byteLength(JSON.stringify(block.toJSON())),
      transactionCount: block.transactions.length,
      miningTimeMs: 0, // this node did not mine it — only the miner's own record has real mining time
      hashingTimeMs: 0,
      validationTimeMs,
      difficulty: block.difficulty,
      nonce: block.nonce,
      timestamp: block.timestamp,
      cpuPercent: sample?.cpuPercent ?? null,
      memoryMb: sample?.memoryMb ?? null,
    };
    metrics.recordBlock(blockRecord);
  }

  function handleIncomingBlock(payload: BlockAnnouncePayload, respondTo: ClientSocket | ServerSocket) {
    messagesReceived++;
    const receivedAt = Date.now();
    if (seenBlockHashes.has(payload.block.hash)) return; // duplicate delivery, already processed
    rememberSeen(payload.block.hash);

    const block = Block.fromJSON(payload.block);
    const blockBytes = Buffer.byteLength(JSON.stringify(payload.block));
    totalBytesReceived += blockBytes;
    const propagationMs = receivedAt - payload.sentAt;
    const result = chain.appendReceivedBlock(block);

    propagationLog.push({
      blockIndex: block.index,
      fromNode: payload.fromNode,
      toNode: nodeLabel,
      sentAt: payload.sentAt,
      receivedAt,
      propagationMs,
      blockBytes,
      accepted: result.accepted,
      reason: result.reason,
    });

    if (metrics && blockchainType) {
      metrics.recordNetworkEvent({
        blockchainType,
        fromNode: payload.fromNode,
        toNode: nodeLabel,
        blockIndex: block.index,
        propagationMs,
        blockBytes,
        accepted: result.accepted,
        reason: result.reason ?? null,
        timestamp: receivedAt,
      });
    }

    if (result.accepted) {
      logger.info('block accepted from peer', { index: block.index, from: payload.fromNode, propagationMs, blockBytes });
      if (result.transactionEntries) {
        recordReceivedTransactions(block, propagationMs, result.validationTimeMs ?? 0, result.transactionEntries);
      }
      broadcastBlock(block); // gossip onward; seenBlockHashes prevents storms
    } else if (result.reason === 'NOT_NEXT_INDEX') {
      logger.warn('behind peer by >1 block, requesting full chain resync', { from: payload.fromNode });
      const peerLabel = peerLabelBySocket.get(respondTo) ?? 'unknown-peer';
      pendingSyncs.set(respondTo, { triggeredAt: Date.now(), chainLengthBefore: chain.chain.length, peerLabel });
      respondTo.emit('chain:request');
      messagesSent++;
    } else {
      logger.warn('rejected block from peer', { index: block.index, from: payload.fromNode, reason: result.reason });
    }
  }

  function wireCommonHandlers(socket: ClientSocket | ServerSocket) {
    socket.on('block:announce', (payload: BlockAnnouncePayload) => handleIncomingBlock(payload, socket));

    socket.on('chain:request', () => {
      messagesReceived++;
      socket.emit('chain:response', chain.chain.map((b) => b.toJSON()));
      messagesSent++;
    });

    socket.on('chain:response', (chainJson: SerializedBlock[]) => {
      messagesReceived++;
      const incoming = chainJson.map((b) => Block.fromJSON(b));
      const result = chain.replaceChain(incoming);
      const pending = pendingSyncs.get(socket);
      pendingSyncs.delete(socket);

      if (result.replaced) {
        logger.info('resynced full chain from peer', { newLength: incoming.length });
        if (pending && metrics && blockchainType) {
          const completedAt = Date.now();
          metrics.recordSyncEvent({
            blockchainType,
            nodeId: nodeLabel,
            peerUrl: pending.peerLabel,
            triggeredAt: pending.triggeredAt,
            completedAt,
            syncDurationMs: completedAt - pending.triggeredAt,
            chainLengthBefore: pending.chainLengthBefore,
            chainLengthAfter: incoming.length,
          });
        }
      }
    });
  }

  function connectToPeers() {
    for (const url of peerUrls) {
      const socket = ioClient(url, { reconnection: true, reconnectionDelay: 1000 });
      outboundSockets.set(url, socket);
      peerLabelBySocket.set(socket, url);
      socket.on('connect', () => logger.info('connected to peer', { peer: url }));
      socket.on('disconnect', () => logger.warn('disconnected from peer', { peer: url }));
      wireCommonHandlers(socket);
    }
  }

  function attachInboundSocket(socket: ServerSocket) {
    peerLabelBySocket.set(socket, `inbound:${socket.id}`);
    wireCommonHandlers(socket);
  }

  function broadcastBlock(block: Block) {
    rememberSeen(block.hash);
    const payload: BlockAnnouncePayload = { block: block.toJSON(), fromNode: nodeLabel, sentAt: Date.now() };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload.block));
    for (const socket of outboundSockets.values()) {
      if (socket.connected) {
        socket.emit('block:announce', payload);
        messagesSent++;
        totalBytesSent += payloadBytes;
      }
    }
  }

  function getBandwidthCounters() {
    return { totalBytesSent, totalBytesReceived };
  }

  function getMessageCounters() {
    return { messagesSent, messagesReceived };
  }

  function getPeerStatus() {
    return Array.from(outboundSockets.entries()).map(([url, socket]) => ({ url, connected: socket.connected }));
  }

  function getPropagationLog() {
    return propagationLog;
  }

  return {
    connectToPeers,
    attachInboundSocket,
    broadcastBlock,
    getPeerStatus,
    getPropagationLog,
    getBandwidthCounters,
    getMessageCounters,
  };
}
