import * as fs from 'fs';
import * as path from 'path';
import { sanitizeLogText } from './sanitize';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogContext {
  flow?: string;
  step?: string;
}

export class Logger {
  private readonly logFilePath: string;
  readonly runId: string;

  constructor(runId: string, projectRoot: string) {
    this.runId = runId;
    const logsDir = path.resolve(projectRoot, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.logFilePath = path.join(logsDir, `${runId}.log`);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  private write(level: LogLevel, rawMessage: string, context?: LogContext): void {
    const timestamp = new Date().toISOString();
    const sanitizedMsg = sanitizeLogText(rawMessage);

    let prefix = `[${timestamp}] [${level}]`;
    if (context?.flow) {
      prefix += ` [Luồng: ${context.flow}]`;
    }
    if (context?.step) {
      prefix += ` [Bước: ${context.step}]`;
    }

    const formattedLine = `${prefix} ${sanitizedMsg}`;

    // 1. Xuất ra console
    if (level === 'ERROR') {
      console.error(formattedLine);
    } else if (level === 'WARN') {
      console.warn(formattedLine);
    } else {
      console.log(formattedLine);
    }

    // 2. Ghi nối vào file log an toàn
    try {
      fs.appendFileSync(this.logFilePath, formattedLine + '\n', 'utf-8');
    } catch (writeErr) {
      console.error(`[CẢNH BÁO] Không thể ghi file log (${this.logFilePath}):`, (writeErr as Error).message);
    }
  }

  info(message: string, context?: LogContext): void {
    this.write('INFO', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('WARN', message, context);
  }

  error(message: string, context?: LogContext, error?: unknown): void {
    let fullMsg = message;
    if (error) {
      const errDetail = error instanceof Error ? error.message : String(error);
      fullMsg += ` | Chi tiết: ${errDetail}`;
    }
    this.write('ERROR', fullMsg, context);
  }

  stepResult(flow: string, step: string, status: 'success' | 'failed' | 'cancelled', detail?: string): void {
    const statusText = status === 'success' ? 'THÀNH CÔNG' : status === 'failed' ? 'THẤT BẠI' : 'ĐÃ HỦY';
    let msg = `Kết quả bước: ${statusText}`;
    if (detail) {
      msg += ` - ${detail}`;
    }
    const level: LogLevel = status === 'success' ? 'INFO' : status === 'failed' ? 'ERROR' : 'WARN';
    this.write(level, msg, { flow, step });
  }
}
