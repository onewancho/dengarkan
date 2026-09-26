// ============================================
// DENGARKAN — Common: In-Memory System Logger
//
// In-Memory Ring Buffer (max 500 lines)
// Zero disk I/O, zero impact on VPS storage
// ============================================

export interface SystemLogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemMetrics {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  uptimeSec: number;
}

const MAX_LOGS = 500;

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
    return {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  clear(): void {
    this.buffer = [];
    this.info('SYSTEM', 'System log buffer cleared');
  }
}

export const systemLog = new SystemLogger();
