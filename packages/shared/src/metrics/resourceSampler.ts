/**
 * Samples this process's own CPU and memory usage. Used both for the
 * periodic (default 1s) node-health log and for ad-hoc snapshots attached
 * to individual transaction/block records.
 *
 * CPU percent is computed as (CPU time consumed since the last sample) /
 * (wall-clock time elapsed since the last sample) * 100 — i.e. percent of
 * one core. Calling `sample()` resets the internal baseline, so successive
 * calls report usage for the window between them, regardless of what
 * triggered each call.
 */
export interface ResourceSample {
  cpuPercent: number;
  memoryMb: number;
}

export class ResourceSampler {
  private lastCpuUsage: NodeJS.CpuUsage = process.cpuUsage();
  private lastSampleAt: bigint = process.hrtime.bigint();

  sample(): ResourceSample {
    const cpuDelta = process.cpuUsage(this.lastCpuUsage);
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - this.lastSampleAt) / 1e6;

    this.lastCpuUsage = process.cpuUsage();
    this.lastSampleAt = now;

    const cpuMicros = cpuDelta.user + cpuDelta.system;
    const cpuPercent = elapsedMs > 0 ? (cpuMicros / 1000 / elapsedMs) * 100 : 0;

    const memoryMb = process.memoryUsage().rss / (1024 * 1024);

    return { cpuPercent, memoryMb };
  }
}
