import fs from 'node:fs';
import path from 'node:path';
import { BlockRecord, NetworkRecord, NodeSampleRecord, SyncRecord, TransactionRecord } from './types.js';

/**
 * Writes benchmark data to `results/<experimentDir>/{transactions,blocks,nodes,network}.{csv,json}`.
 *
 * CSV is appended synchronously per-record — durable even if the process
 * crashes mid-experiment. JSON is buffered in memory as a proper array and
 * flushed (a) every `autoFlushEvery` records per file and (b) on `close()`,
 * which trades a little durability for avoiding an O(n^2) rewrite-the-whole-file
 * cost on every single record at 10k-50k transaction scale.
 */
export class MetricsRecorder {
  private readonly jsonBuffers = new Map<string, unknown[]>();
  private readonly csvHeaderWritten = new Set<string>();
  private readonly autoFlushEvery = 500;

  constructor(public readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  recordTransaction(record: TransactionRecord): void {
    this.append('transactions', record as unknown as Record<string, unknown>);
  }

  recordBlock(record: BlockRecord): void {
    this.append('blocks', record as unknown as Record<string, unknown>);
  }

  recordNodeSample(record: NodeSampleRecord): void {
    this.append('nodes', record as unknown as Record<string, unknown>);
  }

  recordNetworkEvent(record: NetworkRecord): void {
    this.append('network', record as unknown as Record<string, unknown>);
  }

  recordSyncEvent(record: SyncRecord): void {
    this.append('sync', record as unknown as Record<string, unknown>);
  }

  private append(fileBaseName: string, record: Record<string, unknown>): void {
    this.appendCsv(fileBaseName, record);

    const arr = this.jsonBuffers.get(fileBaseName) ?? [];
    arr.push(record);
    this.jsonBuffers.set(fileBaseName, arr);
    if (arr.length % this.autoFlushEvery === 0) {
      this.flushJsonFile(fileBaseName);
    }
  }

  private appendCsv(fileBaseName: string, record: Record<string, unknown>): void {
    const csvPath = path.join(this.dir, `${fileBaseName}.csv`);
    const keys = Object.keys(record);

    if (!this.csvHeaderWritten.has(fileBaseName)) {
      const alreadyExists = fs.existsSync(csvPath) && fs.statSync(csvPath).size > 0;
      if (!alreadyExists) {
        fs.appendFileSync(csvPath, keys.join(',') + '\n');
      }
      this.csvHeaderWritten.add(fileBaseName);
    }

    const row = keys.map((k) => csvEscape(record[k])).join(',');
    fs.appendFileSync(csvPath, row + '\n');
  }

  private flushJsonFile(fileBaseName: string): void {
    const arr = this.jsonBuffers.get(fileBaseName);
    if (!arr) return;
    fs.writeFileSync(path.join(this.dir, `${fileBaseName}.json`), JSON.stringify(arr, null, 2));
  }

  /** Flush all buffered JSON files. Call periodically for long-running nodes and always on shutdown. */
  flush(): void {
    for (const name of this.jsonBuffers.keys()) {
      this.flushJsonFile(name);
    }
  }

  close(): void {
    this.flush();
  }
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
