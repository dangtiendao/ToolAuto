import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { getChromeExecutablePath, handleLaunchError } from '../browser/common';
import { buildPlaywrightProxy } from '../browser/proxy';
import { ConnectionMode } from '../browser/types';
import { AppConfig, ProxyConfig } from '../config/types';
import { getFlowOrThrow } from '../flows/registry';
import { Flow, FlowContext, FlowResult } from '../runner/types';
import { isCancelled } from '../runner';
import { WorkerLogger } from '../utils/worker-logger';
import { JobConfig, WorkerRuntime, WorkerStatus } from './types';
import { TabManager } from './tab-manager';

export interface WorkerInstanceOptions {
  workerId: string;
  runId: string;
  job: JobConfig;
  config: AppConfig;
  projectRoot: string;
  autoCloseOnComplete?: boolean;
  onStatusChange?: (worker: WorkerInstance, status: WorkerStatus) => void;
}

/**
 * WorkerInstance: Đại diện cho một tiến trình worker độc lập.
 * - Mỗi worker sở hữu 1 Browser Chrome riêng biệt (chromium.launch({ channel: 'chrome', headless: false })).
 * - Mỗi worker sở hữu 1 BrowserContext ẩn danh (incognito) không lưu trữ trên ổ đĩa.
 * - Quản lý các tab TabA, TabB, TabC thông qua TabManager riêng.
 * - Không dùng chung Browser, không nạp/lưu storageState, không chia sẻ bộ nhớ mutable giữa các worker.
 */
export class WorkerInstance {
  readonly workerId: string;
  readonly runId: string;
  readonly job: JobConfig;
  readonly config: AppConfig;
  readonly projectRoot: string;
  readonly logger: WorkerLogger;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: TabManager | null = null;
  private abortController: AbortController = new AbortController();
  private status: WorkerStatus = 'queued';
  private currentStep: string = '-';
  private data: Record<string, unknown> = {};
  private connectionMode: ConnectionMode;
  private resumeCallback: (() => void) | null = null;
  private isCleaningUp: boolean = false;
  private isClosed: boolean = false;
  private autoCloseOnComplete: boolean = false;
  private onStatusChange?: (worker: WorkerInstance, status: WorkerStatus) => void;
  private executionPromise: Promise<void> | null = null;
  private result: FlowResult | null = null;
  private manualCloseDetected: boolean = false;

  constructor(options: WorkerInstanceOptions) {
    this.workerId = options.workerId;
    this.runId = options.runId;
    this.job = options.job;
    this.config = options.config;
    this.projectRoot = options.projectRoot;
    this.autoCloseOnComplete = options.autoCloseOnComplete || false;
    this.onStatusChange = options.onStatusChange;

    this.connectionMode = options.job.connectionMode || 'direct';
    this.data = { ...(options.job.data || {}), jobId: options.job.id };

    this.logger = new WorkerLogger({
      runId: this.runId,
      workerId: this.workerId,
      jobId: this.job.id,
      flowName: this.job.flowName,
      projectRoot: this.projectRoot
    });
  }

  public getStatus(): WorkerStatus {
    return this.status;
  }

  public getCurrentStep(): string {
    return this.currentStep;
  }

  public getConnectionMode(): ConnectionMode {
    return this.connectionMode;
  }

  public getResult(): FlowResult | null {
    return this.result;
  }

  private setStatus(newStatus: WorkerStatus): void {
    this.status = newStatus;
    if (this.onStatusChange) {
      this.onStatusChange(this, newStatus);
    }
  }

  /**
   * Tạo WorkerRuntime cung cấp cho các bước flow.
   */
  public getRuntime(): WorkerRuntime {
    return {
      workerId: this.workerId,
      runId: this.runId,
      jobId: this.job.id,
      flowName: this.job.flowName,
      browser: this.browser,
      context: this.context,
      tabs: this.tabs!,
      connectionMode: this.connectionMode,
      abortController: this.abortController,
      status: this.status,
      currentStep: this.currentStep,
      data: this.data,
      logger: this.logger,
      waitForHuman: (stepName: string, promptMessage?: string) =>
        this.waitForHuman(stepName, promptMessage),
      resume: () => this.resume()
    };
  }

  /**
   * Điểm chờ người dùng thủ công:
   * Giữ Chrome và context mở, không chạy bước tiếp theo, không reload.
   */
  public waitForHuman(stepName: string, promptMessage?: string): Promise<void> {
    this.setStatus('awaiting-human');
    this.currentStep = stepName;
    this.logger.setCurrentStep(stepName);

    const msg = `Worker [${this.workerId}] đang chờ người dùng xử lý tại bước [${stepName}]. ${promptMessage || ''}`;
    this.logger.warn(msg, stepName);
    console.log(`\n===============================================================`);
    console.log(`[CHỜ NGƯỜI DÙNG] Worker: ${this.workerId} | Job: ${this.job.id} | Bước: ${stepName}`);
    if (promptMessage) {
      console.log(`Mô tả: ${promptMessage}`);
    }
    console.log(`Nhập lệnh trên terminal: resume ${this.workerId}`);
    console.log(`===============================================================\n`);

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.resumeCallback = null;
        reject(new Error(`Worker ${this.workerId} đã bị hủy trong khi đang chờ người dùng tại bước [${stepName}].`));
      };

      if (this.abortController.signal.aborted) {
        return onAbort();
      }

      this.abortController.signal.addEventListener('abort', onAbort, { once: true });

      this.resumeCallback = () => {
        this.abortController.signal.removeEventListener('abort', onAbort);
        this.setStatus('running');
        this.resumeCallback = null;
        this.logger.info(`Đã nhận tín hiệu resume cho worker [${this.workerId}]. Tiếp tục kiểm tra lại DOM...`, stepName);
        resolve();
      };
    });
  }

  /**
   * Gửi tín hiệu tiếp tục cho worker đang ở trạng thái awaiting-human.
   */
  public resume(): boolean {
    if (this.status !== 'awaiting-human' || !this.resumeCallback) {
      return false;
    }
    const cb = this.resumeCallback;
    this.resumeCallback = null;
    cb();
    return true;
  }

  /**
   * Khởi chạy Chrome ẩn danh riêng biệt cho worker này.
   */
  private async initBrowser(): Promise<void> {
    const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const launchArgs = ['--incognito'];

    if (this.connectionMode === 'direct') {
      launchArgs.push('--no-proxy-server');
    }

    let proxyOption: { server: string; bypass?: string; username?: string; password?: string } | undefined;
    if (this.connectionMode === 'proxy') {
      const proxyConfig = this.config.proxy;
      if (!proxyConfig || !proxyConfig.server || !proxyConfig.server.trim()) {
        throw new Error(
          `[LỖI KẾT NỐI PROXY] Worker [${this.workerId}] được cấu hình connectionMode="proxy" nhưng "proxy.server" chưa được thiết lập. Dừng ngay lập tức, không fallback.`
        );
      }
      try {
        proxyOption = buildPlaywrightProxy(proxyConfig);
      } catch (proxyErr) {
        throw new Error(
          `[LỖI CẤU HÌNH PROXY] Worker [${this.workerId}] cấu hình proxy không hợp lệ: ${(proxyErr as Error).message}. Dừng ngay lập tức, không fallback.`
        );
      }
    }

    this.logger.info(`Đang khởi chạy Chrome độc lập (chế độ ẩn danh, connectionMode: "${this.connectionMode}")...`);

    try {
      this.browser = await chromium.launch({
        channel: 'chrome',
        executablePath: chromeExe,
        headless: false,
        args: launchArgs,
        proxy: proxyOption
      });
    } catch (err) {
      throw handleLaunchError(err, this.config);
    }

    try {
      this.context = await this.browser.newContext({
        viewport: null,
        proxy: proxyOption
      });
    } catch (err) {
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
      throw handleLaunchError(err, this.config);
    }

    this.context.setDefaultTimeout(this.config.actionTimeoutMs || 15000);
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs || 30000);

    // Bắt sự kiện khi người dùng đóng Chrome thủ công trên màn hình
    this.context.on('close', () => {
      this.manualCloseDetected = true;
      if (this.status === 'running' || this.status === 'awaiting-human' || this.status === 'starting') {
        this.logger.warn(`Trình duyệt của worker [${this.workerId}] đã bị đóng thủ công bởi người dùng.`);
        this.abortController.abort();
      }
    });

    this.tabs = new TabManager({
      workerId: this.workerId,
      context: this.context,
      actionTimeoutMs: this.config.actionTimeoutMs,
      navigationTimeoutMs: this.config.navigationTimeoutMs,
      logger: this.logger
    });
  }

  /**
   * Bắt đầu thực thi luồng được giao cho worker.
   */
  public async start(): Promise<FlowResult> {
    const startedAt = new Date().toISOString();
    const completedSteps: string[] = [];

    this.setStatus('starting');
    this.logger.info(`Khởi động worker cho job [${this.job.id}], luồng: "${this.job.flowName}".`);

    // 1. Kiểm tra luồng trong Registry
    let flow: Flow;
    try {
      flow = getFlowOrThrow(this.job.flowName);
    } catch (flowErr) {
      this.setStatus('failed');
      const errorMsg = (flowErr as Error).message;
      this.logger.error(errorMsg);
      const failedResult: FlowResult = {
        runId: this.runId,
        flowName: this.job.flowName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: errorMsg
      };
      this.result = failedResult;
      this.logger.saveResult({
        workerId: this.workerId,
        jobId: this.job.id,
        runId: this.runId,
        flowName: this.job.flowName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: errorMsg
      });
      await this.cleanup();
      return failedResult;
    }

    // 1.1. Kiểm tra hỗ trợ chạy đồng thời
    if (flow.supportsConcurrency === false && (this.config.maxConcurrency > 1 || (this.config.jobs && this.config.jobs.length > 1))) {
      this.setStatus('failed');
      const errorMsg = `[TỪ CHỐI CHẠY ĐỒNG THỜI] Luồng "${flow.name}" chưa hỗ trợ chạy đồng thời để đảm bảo an toàn nghiệp vụ (OTP/SMS/bảo mật). Vui lòng không chạy đồng thời luồng này.`;
      this.logger.error(errorMsg);
      const failedResult: FlowResult = {
        runId: this.runId,
        flowName: this.job.flowName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: errorMsg
      };
      this.result = failedResult;
      this.logger.saveResult({
        workerId: this.workerId,
        jobId: this.job.id,
        runId: this.runId,
        flowName: this.job.flowName,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: errorMsg
      });
      await this.cleanup();
      return failedResult;
    }

    try {
      // 2. Khởi tạo Chrome ẩn danh riêng cho worker
      await this.initBrowser();
      this.setStatus('running');

      // Tạo một trang mặc định làm context.page nếu flow cần
      const defaultPage = await this.tabs!.createTab('Tab-Default');

      const flowContext: FlowContext = {
        page: defaultPage,
        config: this.config,
        runId: this.runId,
        logger: this.logger as any,
        cancellationToken: this.abortController.signal,
        data: this.data,
        workerId: this.workerId,
        jobId: this.job.id,
        tabManager: this.tabs!,
        runtime: this.getRuntime()
      };

      // 3. Thực thi tuần tự các bước trong flow
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        this.currentStep = step.id;
        this.logger.setCurrentStep(step.id);

        // Kiểm tra tín hiệu hủy trước khi bước bắt đầu
        if (isCancelled(this.abortController.signal)) {
          this.logger.warn(`Worker đã nhận tín hiệu dừng. Bỏ qua bước [${step.id}].`, step.id);
          this.logger.stepResult(step.id, 'cancelled', 'Bị hủy');
          const cancelledResult: FlowResult = {
            runId: this.runId,
            flowName: flow.name,
            status: 'cancelled',
            startedAt,
            finishedAt: new Date().toISOString(),
            completedSteps,
            error: 'Worker đã dừng do nhận được tín hiệu hủy.'
          };
          this.result = cancelledResult;
          this.setStatus('cancelled');
          this.logger.saveResult({
            workerId: this.workerId,
            jobId: this.job.id,
            runId: this.runId,
            flowName: flow.name,
            status: 'cancelled',
            startedAt,
            finishedAt: new Date().toISOString(),
            completedSteps,
            error: 'Bị hủy bởi tín hiệu dừng'
          });
          return cancelledResult;
        }

        this.logger.info(`Bắt đầu thực thi bước: "${step.name}"`, step.id);

        try {
          // Thực thi bước
          await step.execute(flowContext);

          // Kiểm tra xác minh nếu có
          if (step.verify) {
            const verified = await step.verify(flowContext);
            if (!verified) {
              throw new Error(`Điều kiện xác nhận (verify) cho bước "${step.name}" không thỏa mãn.`);
            }
          }

          completedSteps.push(step.id);
          this.logger.stepResult(step.id, 'success', `Hoàn thành bước "${step.name}"`);
        } catch (stepErr) {
          const isAborted = isCancelled(this.abortController.signal);
          const rawMessage = (stepErr as Error).message || String(stepErr);
          const finalStatus: 'cancelled' | 'failed' = isAborted ? 'cancelled' : 'failed';

          this.logger.stepResult(step.id, finalStatus, rawMessage);
          this.logger.error(
            isAborted
              ? `Worker đã bị hủy tại bước [${step.id}].`
              : `Worker dừng ngay lập tức tại bước [${step.id}]. Không tự động thử lại.`,
            step.id
          );

          const endResult: FlowResult = {
            runId: this.runId,
            flowName: flow.name,
            status: finalStatus,
            startedAt,
            finishedAt: new Date().toISOString(),
            completedSteps,
            failedStep: isAborted
              ? undefined
              : {
                  id: step.id,
                  name: step.name
                },
            error: rawMessage
          };

          this.result = endResult;
          this.setStatus(finalStatus);
          this.logger.saveResult({
            workerId: this.workerId,
            jobId: this.job.id,
            runId: this.runId,
            flowName: flow.name,
            status: finalStatus,
            startedAt,
            finishedAt: new Date().toISOString(),
            completedSteps,
            failedStep: isAborted
              ? undefined
              : {
                  id: step.id,
                  name: step.name
                },
            error: rawMessage
          });

          return endResult;
        }
      }

      // Hoàn thành thành công tất cả các bước
      const finishedAt = new Date().toISOString();
      this.logger.info(`Luồng "${flow.name}" của worker ${this.workerId} đã hoàn thành xuất sắc!`);
      const successResult: FlowResult = {
        runId: this.runId,
        flowName: flow.name,
        status: 'success',
        startedAt,
        finishedAt,
        completedSteps
      };
      this.result = successResult;
      this.setStatus('completed');
      this.logger.saveResult({
        workerId: this.workerId,
        jobId: this.job.id,
        runId: this.runId,
        flowName: flow.name,
        status: 'success',
        startedAt,
        finishedAt,
        completedSteps
      });

      return successResult;
    } catch (generalErr) {
      const isAborted = isCancelled(this.abortController.signal);
      const finalStatus: 'cancelled' | 'failed' = isAborted ? 'cancelled' : 'failed';
      const errorMsg = (generalErr as Error).message || String(generalErr);
      this.logger.error(`Lỗi thực thi worker: ${errorMsg}`);
      const failedResult: FlowResult = {
        runId: this.runId,
        flowName: this.job.flowName,
        status: finalStatus,
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps,
        error: errorMsg
      };
      this.result = failedResult;
      this.setStatus(finalStatus);
      this.logger.saveResult({
        workerId: this.workerId,
        jobId: this.job.id,
        runId: this.runId,
        flowName: this.job.flowName,
        status: finalStatus,
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps,
        error: errorMsg
      });
      return failedResult;
    } finally {
      // Nếu được cấu hình tự đóng khi hoàn tất, dọn dẹp ngay
      if (this.autoCloseOnComplete) {
        await this.cleanup();
      }
    }
  }

  /**
   * Dừng worker ngay lập tức và dọn dẹp tài nguyên.
   */
  public async stop(): Promise<void> {
    this.logger.warn(`Nhận lệnh dừng cho worker [${this.workerId}]. Đang ngắt kết nối...`);
    this.abortController.abort();
    if (this.resumeCallback) {
      this.resumeCallback = null;
    }
    this.setStatus('cancelled');
    await this.cleanup();
  }

  /**
   * Đóng Chrome của worker này và giải phóng tài nguyên/slot.
   */
  public async close(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Dọn dẹp tài nguyên (idempotent - an toàn khi gọi nhiều lần).
   * Xóa tham chiếu dữ liệu nhạy cảm.
   */
  public async cleanup(): Promise<void> {
    if (this.isCleaningUp || this.isClosed) {
      return;
    }
    this.isCleaningUp = true;
    this.setStatus('closing');

    try {
      // 1. Đóng các tab
      if (this.tabs) {
        await this.tabs.closeAllTabs().catch(() => {});
        this.tabs = null;
      }

      // 2. Đóng context
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }

      // 3. Đóng browser
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }

      // 4. Xóa tham chiếu dữ liệu nhạy cảm
      for (const key of Object.keys(this.data)) {
        delete this.data[key];
      }

      this.logger.info(`Đã đóng Chrome và giải phóng tài nguyên cho worker [${this.workerId}].`);
    } catch (cleanupErr) {
      this.logger.warn(`Cảnh báo khi dọn dẹp tài nguyên worker [${this.workerId}]: ${(cleanupErr as Error).message}`);
    } finally {
      this.isClosed = true;
      this.isCleaningUp = false;
      this.setStatus('closed');
    }
  }
}
