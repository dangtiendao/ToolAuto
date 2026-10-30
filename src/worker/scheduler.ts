import { AppConfig } from '../config/types';
import { JobConfig, WorkerStatus } from './types';
import { WorkerInstance } from './worker';

export interface SchedulerOptions {
  config: AppConfig;
  runId: string;
  projectRoot: string;
  autoCloseOnComplete?: boolean;
  maxConcurrency?: number;
}

/**
 * WorkerScheduler:
 * - Điều phối hàng đợi và giới hạn số lượng worker chạy đồng thời (mặc định tối đa maxConcurrency = 2).
 * - Chỉ chạy tối đa maxConcurrency worker đang giữ Chrome cùng lúc.
 * - Các job còn lại nằm trong hàng đợi chờ cấp slot.
 * - Worker đang chờ người dùng (awaiting-human) hoặc completed (chưa đóng Chrome) VẪN CHIẾM SLOT.
 * - Chỉ cấp slot mới khi Chrome của worker trước ĐÃ ĐÓNG HOÀN TOÀN.
 * - Lỗi ở một job không làm hủy các job khác.
 * - Không tự động retry job thất bại.
 */
export class WorkerScheduler {
  private readonly config: AppConfig;
  private readonly runId: string;
  private readonly projectRoot: string;
  private readonly maxConcurrency: number;
  private readonly autoCloseOnComplete: boolean;

  private queuedJobs: JobConfig[] = [];
  private activeWorkers: Map<string, WorkerInstance> = new Map();
  private allWorkers: Map<string, WorkerInstance> = new Map();
  private workerCounter: number = 0;
  private isStopped: boolean = false;
  private idleResolvers: Array<() => void> = [];

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.runId = options.runId;
    this.projectRoot = options.projectRoot;
    this.maxConcurrency = options.maxConcurrency || options.config.maxConcurrency || 2;
    this.autoCloseOnComplete = options.autoCloseOnComplete || false;

    if (this.maxConcurrency < 1 || !Number.isInteger(this.maxConcurrency)) {
      throw new Error(`[LỖI CẤU HÌNH] maxConcurrency phải là số nguyên dương (nhận được: ${this.maxConcurrency}).`);
    }

    if (options.config.jobs && options.config.jobs.length > 0) {
      this.queuedJobs = [...options.config.jobs];
    }
  }

  public getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  public getQueuedJobs(): JobConfig[] {
    return [...this.queuedJobs];
  }

  public getActiveWorkers(): WorkerInstance[] {
    return Array.from(this.activeWorkers.values());
  }

  public getAllWorkers(): WorkerInstance[] {
    return Array.from(this.allWorkers.values());
  }

  public getWorker(workerId: string): WorkerInstance | undefined {
    return this.allWorkers.get(workerId);
  }

  /**
   * Bắt đầu điều phối hàng đợi.
   */
  public start(): void {
    if (this.isStopped) return;
    this.dispatchNext();
  }

  /**
   * Chờ cho đến khi tất cả các job trong hàng đợi hoàn tất và tất cả các Chrome đã đóng.
   */
  public waitForIdle(): Promise<void> {
    if (this.queuedJobs.length === 0 && this.activeWorkers.size === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private checkIdle(): void {
    if (this.queuedJobs.length === 0 && this.activeWorkers.size === 0) {
      const resolvers = [...this.idleResolvers];
      this.idleResolvers = [];
      resolvers.forEach((r) => r());
    }
  }

  /**
   * Điều phối job tiếp theo khi có slot trống.
   */
  private dispatchNext(): void {
    if (this.isStopped) return;

    while (this.activeWorkers.size < this.maxConcurrency && this.queuedJobs.length > 0) {
      const job = this.queuedJobs.shift()!;
      this.workerCounter++;
      const workerId = `worker-${this.workerCounter}`;

      const worker = new WorkerInstance({
        workerId,
        runId: this.runId,
        job,
        config: this.config,
        projectRoot: this.projectRoot,
        autoCloseOnComplete: this.autoCloseOnComplete,
        onStatusChange: (w, status) => this.handleWorkerStatusChange(w, status)
      });

      this.activeWorkers.set(workerId, worker);
      this.allWorkers.set(workerId, worker);

      console.log(`[SCHEDULER] Cấp slot cho worker [${workerId}] (Job: "${job.id}", Luồng: "${job.flowName}"). Slot đang dùng: ${this.activeWorkers.size}/${this.maxConcurrency}`);

      // Bắt đầu thực thi worker (bất đồng bộ, không dùng Promise.all không giới hạn)
      worker.start().catch((err) => {
        console.error(`[SCHEDULER] Worker [${workerId}] gặp lỗi:`, (err as Error).message);
      });
    }

    this.checkIdle();
  }

  /**
   * Theo dõi trạng thái worker.
   * Chỉ khi worker đạt trạng thái 'closed' (Chrome đã đóng hoàn toàn) mới giải phóng slot.
   */
  private handleWorkerStatusChange(worker: WorkerInstance, status: WorkerStatus): void {
    if (status === 'closed') {
      if (this.activeWorkers.has(worker.workerId)) {
        this.activeWorkers.delete(worker.workerId);
        console.log(`[SCHEDULER] Worker [${worker.workerId}] đã đóng Chrome. Giải phóng 1 slot. Slot đang dùng: ${this.activeWorkers.size}/${this.maxConcurrency}`);
        // Cấp slot mới cho job tiếp theo trong hàng đợi
        this.dispatchNext();
      }
    }
  }

  /**
   * Resume một worker đang ở trạng thái awaiting-human.
   */
  public resumeWorker(workerId: string): boolean {
    const worker = this.getWorker(workerId);
    if (!worker) {
      return false;
    }
    return worker.resume();
  }

  /**
   * Dừng một worker cụ thể.
   */
  public async stopWorker(workerId: string): Promise<boolean> {
    const worker = this.getWorker(workerId);
    if (!worker) {
      return false;
    }
    await worker.stop();
    return true;
  }

  /**
   * Đóng Chrome của một worker đã completed hoặc failed để giải phóng slot.
   */
  public async closeWorker(workerId: string): Promise<boolean> {
    const worker = this.getWorker(workerId);
    if (!worker) {
      return false;
    }
    await worker.close();
    return true;
  }

  /**
   * Dừng toàn bộ hệ thống (Ctrl+C hoặc lệnh stop-all):
   * - Hủy toàn bộ job còn lại trong hàng đợi.
   * - Dừng toàn bộ các worker đang hoạt động.
   * - Đóng toàn bộ Chrome do công cụ quản lý.
   */
  public async stopAll(): Promise<void> {
    this.isStopped = true;

    // Hủy các job chưa kịp chạy
    const remainingCount = this.queuedJobs.length;
    this.queuedJobs = [];
    if (remainingCount > 0) {
      console.log(`[SCHEDULER] Đã hủy ${remainingCount} job đang chờ trong hàng đợi.`);
    }

    // Dừng tất cả worker đang mở Chrome
    const active = Array.from(this.activeWorkers.values());
    console.log(`[SCHEDULER] Đang dừng ${active.length} worker đang chạy...`);
    await Promise.all(active.map((w) => w.stop().catch(() => {})));

    this.checkIdle();
  }
}
