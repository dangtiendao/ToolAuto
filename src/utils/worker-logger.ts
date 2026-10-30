import * as fs from 'fs';
import * as path from 'path';
import { sanitizeLogText } from './sanitize';
import { LogLevel } from './logger';
import { WorkerResult } from '../worker/types';

export interface WorkerLoggerOptions {
  runId: string;
  workerId: string;
  jobId: string;
  flowName: string;
  projectRoot: string;
}

/**
 * Logger riêng biệt cho từng Worker:
 * - Ghi log vào file logs/<runId>/<workerId>.log.
 * - Lưu kết quả vào logs/<runId>/<workerId>.result.json.
 * - Mỗi dòng log có đầy đủ: timestamp, workerId, jobId, flowName, stepName, status.
 * - Tuyệt đối không ghi thông tin nhạy cảm (OTP, mật khẩu, cookie, token, số điện thoại đầy đủ, DOM).
 */
export class WorkerLogger {
  readonly runId: string;
  readonly workerId: string;
  readonly jobId: string;
  readonly flowName: string;
  private readonly projectRoot: string;
  private readonly logFilePath: string;
  private currentStepName: string = '-';

  constructor(options: WorkerLoggerOptions) {
    this.runId = options.runId;
    this.workerId = options.workerId;
    this.jobId = options.jobId;
    this.flowName = options.flowName;
    this.projectRoot = options.projectRoot;

    const runLogsDir = path.resolve(this.projectRoot, 'logs', this.runId);
    if (!fs.existsSync(runLogsDir)) {
      fs.mkdirSync(runLogsDir, { recursive: true });
    }
    this.logFilePath = path.join(runLogsDir, `${this.workerId}.log`);
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public setCurrentStep(stepName: string): void {
    this.currentStepName = stepName || '-';
  }

  private write(level: LogLevel, rawMessage: string, stepName?: string, statusText?: string): void {
    const timestamp = new Date().toISOString();
    const sanitizedMsg = sanitizeLogText(rawMessage);
    const step = stepName || this.currentStepName || '-';
    const status = statusText || level;

    // Định dạng bắt buộc: timestamp, workerId, jobId, flowName, stepName, status
    const formattedLine = `[${timestamp}] [${this.workerId}] [${this.jobId}] [${this.flowName}] [${step}] [${status}] ${sanitizedMsg}`;

    if (level === 'ERROR') {
      console.error(formattedLine);
    } else if (level === 'WARN') {
      console.warn(formattedLine);
    } else {
      console.log(formattedLine);
    }

    try {
      fs.appendFileSync(this.logFilePath, formattedLine + '\n', 'utf-8');
    } catch (writeErr) {
      console.error(
        `[CẢNH BÁO] Không thể ghi file log worker (${this.logFilePath}):`,
        (writeErr as Error).message
      );
    }
  }

  public info(message: string, stepName?: string): void {
    this.write('INFO', message, stepName, 'INFO');
  }

  public warn(message: string, stepName?: string): void {
    this.write('WARN', message, stepName, 'WARN');
  }

  public error(message: string, stepName?: string, error?: unknown): void {
    let fullMsg = message;
    if (error) {
      const errDetail = error instanceof Error ? error.message : String(error);
      fullMsg += ` | Chi tiết: ${errDetail}`;
    }
    this.write('ERROR', fullMsg, stepName, 'ERROR');
  }

  public stepResult(
    stepName: string,
    status: 'success' | 'failed' | 'cancelled',
    detail?: string
  ): void {
    const statusText = status === 'success' ? 'THÀNH CÔNG' : status === 'failed' ? 'THẤT BẠI' : 'ĐÃ HỦY';
    let msg = `Kết quả bước: ${statusText}`;
    if (detail) {
      msg += ` - ${detail}`;
    }
    const level: LogLevel = status === 'success' ? 'INFO' : status === 'failed' ? 'ERROR' : 'WARN';
    this.write(level, msg, stepName, statusText);
  }

  /**
   * Lưu kết quả worker ra file JSON riêng biệt: logs/<runId>/<workerId>.result.json
   */
  public saveResult(result: WorkerResult): string {
    const runLogsDir = path.resolve(this.projectRoot, 'logs', this.runId);
    if (!fs.existsSync(runLogsDir)) {
      fs.mkdirSync(runLogsDir, { recursive: true });
    }
    const resultFilePath = path.join(runLogsDir, `${this.workerId}.result.json`);
    fs.writeFileSync(resultFilePath, JSON.stringify(result, null, 2), 'utf-8');
    return resultFilePath;
  }
}
