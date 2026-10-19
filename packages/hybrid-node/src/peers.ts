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

interface ChainRequestPayload {
  /** Array index of the first block the requester is missing. */
  fromIndex?: number;
}

interface ChainResponseChunk {
  startIndex: number;
  totalLength: number;
  blocks: SerializedBlock[];
  hasMore: boolean;
}

// Hybrid blocks are substantially larger than classical blocks because each
// transaction includes ML-DSA key/signature material. Keep each sync packet
// bounded instead of trying to send the full chain as one Socket.IO message.
const CHAIN_SYNC_BATCH_SIZE = 5;

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

  function requestChainChunk(socket: ClientSocket | ServerSocket) {
    socket.emit('chain:request', { fromIndex: chain.chain.length } satisfies ChainRequestPayload);
    messagesSent++;
  }

  function finishSync(socket: ClientSocket | ServerSocket) {
    const pending = pendingSyncs.get(socket);
    pendingSyncs.delete(socket);
    if (!pending) return;

    const completedAt = Date.now();
    const chainLengthAfter = chain.chain.length;
    if (chainLengthAfter > pending.chainLengthBefore) {
      logger.info('resynced chain from peer', { newLength: chainLengthAfter });
      if (metrics && blockchainType) {
        metrics.recordSyncEvent({
          blockchainType,
          nodeId: nodeLabel,
          peerUrl: pending.peerLabel,
          triggeredAt: pending.triggeredAt,
          completedAt,
          syncDurationMs: completedAt - pending.triggeredAt,
          chainLengthBefore: pending.chainLengthBefore,
          chainLengthAfter,
        });
      }
    }
  }

  function handleIncomingBlock(payload: BlockAnnouncePayload, respondTo: ClientSocket | ServerSocket) {
    messagesReceived++;
    const receivedAt = Date.now();
    const blockIndex = payload.block.index;

    // Ignore blocks already present in our chain. Do not ignore a previously
    // observed future block solely because it is in seenBlockHashes: that block
    // may have arrived out of order and still need to be fetched during sync.
    if (blockIndex < chain.chain.length) {
      rememberSeen(payload.block.hash);
      return;
    }
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
      logger.warn('behind peer, requesting chunked chain resync', { from: payload.fromNode, requestedFromIndex: chain.chain.length });
      // Avoid issuing a new request for every out-of-order announce while the
      // current peer is already supplying missing blocks in bounded chunks.
      if (!pendingSyncs.has(respondTo)) {
        pendingSyncs.set(respondTo, {
          triggeredAt: Date.now(),
          chainLengthBefore: chain.chain.length,
          peerLabel: peerLabelBySocket.get(respondTo) ?? 'unknown-peer',
        });
        requestChainChunk(respondTo);
      }
    } else {
      logger.warn('rejected block from peer', { index: block.index, from: payload.fromNode, reason: result.reason });
    }
  }

  function wireCommonHandlers(socket: ClientSocket | ServerSocket) {
    socket.on('block:announce', (payload: BlockAnnouncePayload) => handleIncomingBlock(payload, socket));

    socket.on('chain:request', (request?: ChainRequestPayload) => {
      messagesReceived++;
      const requestedIndex = Number.isSafeInteger(request?.fromIndex)
        ? Math.max(0, request!.fromIndex as number)
        : 0;
      const startIndex = Math.min(requestedIndex, chain.chain.length);
      const endIndex = Math.min(startIndex + CHAIN_SYNC_BATCH_SIZE, chain.chain.length);
      const blocks = chain.chain.slice(startIndex, endIndex).map((b) => b.toJSON());
      const response: ChainResponseChunk = {
        startIndex,
        totalLength: chain.chain.length,
        blocks,
        hasMore: endIndex < chain.chain.length,
      };
      totalBytesSent += Buffer.byteLength(JSON.stringify(blocks));
      socket.emit('chain:response', response);
      messagesSent++;
    });

    socket.on('chain:response', (response: ChainResponseChunk | SerializedBlock[]) => {
      messagesReceived++;

      // Backward compatibility with an older node version that responds with
      // one full-chain array. New nodes always use bounded chunk responses.
      if (Array.isArray(response)) {
        const incoming = response.map((b) => Block.fromJSON(b));
        const result = chain.replaceChain(incoming);
        if (result.replaced) {
          for (const block of incoming) rememberSeen(block.hash);
          finishSync(socket);
        } else {
          pendingSyncs.delete(socket);
        }
        return;
      }

      if (!response || !Array.isArray(response.blocks)) {
        logger.warn('received malformed chain sync response');
        pendingSyncs.delete(socket);
        return;
      }

      totalBytesReceived += Buffer.byteLength(JSON.stringify(response.blocks));
      let failed = false;
      for (const serializedBlock of response.blocks) {
        // Another peer may have delivered a block while this sync response was
        // in flight. Skip it if already appended, but never append across a gap.
        if (serializedBlock.index < chain.chain.length) {
          rememberSeen(serializedBlock.hash);
          continue;
        }
        if (serializedBlock.index !== chain.chain.length) {
          logger.warn('chain sync chunk has a gap', {
            expectedIndex: chain.chain.length,
            receivedIndex: serializedBlock.index,
          });
          failed = true;
          break;
        }

        const block = Block.fromJSON(serializedBlock);
        const appendResult = chain.appendReceivedBlock(block);
        if (!appendResult.accepted) {
          logger.warn('chain sync block rejected', {
            index: block.index,
            reason: appendResult.reason,
          });
          failed = true;
          break;
        }
        rememberSeen(block.hash);
      }

      if (failed) {
        pendingSyncs.delete(socket);
        return;
      }

      const stillBehind = response.hasMore || response.totalLength > chain.chain.length;
      if (stillBehind && response.blocks.length > 0) {
        requestChainChunk(socket);
        return;
      }

      finishSync(socket);
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
