// ============================================
// DENGARKAN — Common: In-Memory System Logger
//
// In-Memory Ring Buffer (max 500 lines)
// Zero disk I/O, zero impact on VPS storage
// Includes Host VPS CPU & RAM Metrics via node:os
// ============================================

import os from 'node:os';

export interface SystemLogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemMetrics {
  // Node.js process metrics
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  uptimeSec: number;

  // VPS host system metrics
  systemTotalMemMb: number;
  systemUsedMemMb: number;
  systemMemPercent: number;
  systemCpuPercent: number;
  systemLoadAvg: number;
  cpuCores: number;
}

const MAX_LOGS = 500;

let lastCpuSnapshot: { idle: number; total: number } | null = null;

function calculateCpuPercent(): number {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }

  if (!lastCpuSnapshot) {
    lastCpuSnapshot = { idle, total };
    return 0;
  }

  const idleDiff = idle - lastCpuSnapshot.idle;
  const totalDiff = total - lastCpuSnapshot.total;
  lastCpuSnapshot = { idle, total };

  if (totalDiff <= 0) return 0;
  const usage = 100 - Math.round((100 * idleDiff) / totalDiff);
  return Math.max(0, Math.min(100, usage));
}

class SystemLogger {
  private buffer: SystemLogEntry[] = [];
  private sequence = 0;

  constructor() {
    this.info('SYSTEM', 'In-memory system logger initialized (Ring Buffer max 500 entries)');
  }

  private addEntry(
    level: 'info' | 'warn' | 'error',
    tag: string,
    message: string,
    details?: Record<string, unknown>
  ): void {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const entry: SystemLogEntry = {
      id: ++this.sequence,
      timestamp,
      level,
      tag: tag.toUpperCase(),
      message,
      ...(details ? { details } : {}),
    };

    this.buffer.push(entry);

    if (this.buffer.length > MAX_LOGS) {
      this.buffer.shift();
    }
  }

  info(tag: string, message: string, details?: Record<string, unknown>): void {
    this.addEntry('info', tag, message, details);
  }

  warn(tag: string, message: string, details?: Record<string, unknown>): void {
    this.addEntry('warn', tag, message, details);
  }

  error(tag: string, message: string, details?: Record<string, unknown>): void {
    this.addEntry('error', tag, message, details);
  }

  getLogs(limit = 500): SystemLogEntry[] {
    if (limit <= 0 || limit >= this.buffer.length) {
      return [...this.buffer];
    }
    return this.buffer.slice(-limit);
  }

  getMetrics(): SystemMetrics {
    const mem = process.memoryUsage();
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);
    const systemTotalMemMb = Math.round(totalMemBytes / 1024 / 1024);
    const systemUsedMemMb = Math.round(usedMemBytes / 1024 / 1024);
    const systemMemPercent = systemTotalMemMb > 0 ? Math.round((systemUsedMemMb / systemTotalMemMb) * 100) : 0;
    const loadAvg = os.loadavg();

    return {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),

      systemTotalMemMb,
      systemUsedMemMb,
      systemMemPercent,
      systemCpuPercent: calculateCpuPercent(),
      systemLoadAvg: Math.round((loadAvg[0] || 0) * 100) / 100,
      cpuCores: os.cpus()?.length || 1,
    };
  }

  clear(): void {
    this.buffer = [];
    this.info('SYSTEM', 'System log buffer cleared');
  }
}

export const systemLog = new SystemLogger();
