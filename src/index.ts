import { loadConfig, formatSafeConfig, getProjectRoot } from './config';
import { BrowserManager, waitForEnter, BrowserSession, findWorkingProxy } from './browser';
import { getFlowOrThrow } from './flows';
import { runFlow, FlowContext, FlowResult, saveFlowResult } from './runner';
import { generateRunId, Logger, sanitizeUrl, saveEmailToOutputFile } from './utils';
import { WorkerScheduler } from './worker/scheduler';
import { TerminalController } from './terminal/controller';

async function main(): Promise<void> {
  const projectRoot = getProjectRoot();
  const runId = generateRunId();
  const logger = new Logger(runId, projectRoot);

  logger.info(`==========================================`);
  logger.info(`     CHROME AUTOMATION TOOL (WINDOWS)     `);
  logger.info(`==========================================`);
  logger.info(`Run ID: ${runId}`);
  logger.info(`Log file: ${logger.getLogFilePath()}`);

  const abortController = new AbortController();
  let browserManager: BrowserManager | null = null;
  let session: BrowserSession | null = null;
  let flowResult: FlowResult | null = null;
  let scheduler: WorkerScheduler | null = null;
  let terminalController: TerminalController | null = null;
  let isCleaningUp = false;
  let isCancelledByUser = false;

  // Hàm dọn dẹp tài nguyên an toàn (idempotent - gọi nhiều lần không lỗi)
  const cleanup = async (isSigint: boolean = false): Promise<void> => {
    if (isCleaningUp) return;
    isCleaningUp = true;

    if (isSigint) {
      isCancelledByUser = true;
      abortController.abort();
      logger.warn('Nhận tín hiệu dừng (Ctrl+C). Đang ngắt kết nối trình duyệt và dừng các luồng...');
    }

    // Nếu đang chạy chế độ multi-worker scheduler
    if (scheduler) {
      if (terminalController) {
        terminalController.close();
        terminalController = null;
      }
      await scheduler.stopAll();
      scheduler = null;
      logger.info('Đã dừng toàn bộ workers và đóng các Chrome an toàn.');
    }

    // Đóng browser context đơn lẻ (nếu ở chế độ legacy)
    if (browserManager) {
      await browserManager.close();
      browserManager = null;
      session = null;
      logger.info('Đã đóng trình duyệt an toàn.');
    }

    // Nếu bị hủy bởi Ctrl+C, lưu kết quả cancelled nếu chưa kịp lưu
    if (isCancelledByUser && (!flowResult || flowResult.status !== 'cancelled')) {
      flowResult = {
        runId,
        flowName: 'unknown',
        status: 'cancelled',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: 'Người dùng đã hủy thực thi bằng tín hiệu dừng (Ctrl+C).'
      };
      const resultPath = saveFlowResult(runId, flowResult, projectRoot);
      logger.info(`Đã lưu kết quả hủy vào: ${resultPath}`);
    }

    if (isSigint) {
      logger.warn('Kết thúc do người dùng hủy. Thoát với mã trạng thái 130.');
      process.exit(130);
    }
  };

  // Đăng ký bắt sự kiện SIGINT (Ctrl+C)
  process.on('SIGINT', async () => {
    await cleanup(true);
  });

  try {
    // 1. Nạp và kiểm tra cấu hình
    const config = loadConfig(undefined, { exitOnError: false });
    logger.info('Cấu hình đã nạp thành công (đã ẩn các thông tin nhạy cảm):');
    logger.info(JSON.stringify(formatSafeConfig(config), null, 2));

    // 2. Kiểm tra chế độ chạy: Multi-worker Incognito hay Single-flow Legacy
    const isMultiWorker = Boolean(config.jobs && config.jobs.length > 0);

    if (isMultiWorker && config.jobs && config.jobs.length > 0) {
      logger.info(
        `[CHẾ ĐỘ MULTI-WORKER] Khởi động bộ quản lý ${config.jobs.length} jobs với tối đa ${config.maxConcurrency} Chrome đồng thời.`
      );

      scheduler = new WorkerScheduler({
        config,
        runId,
        projectRoot,
        autoCloseOnComplete: false,
        maxConcurrency: config.maxConcurrency
      });

      terminalController = new TerminalController(scheduler);
      terminalController.startListening();

      scheduler.start();
      await scheduler.waitForIdle();

      terminalController.close();
      terminalController = null;

      logger.info('Tất cả các worker trong hàng đợi đã hoàn tất.');
      process.exit(0);
      return;
    }

    // 3. Chế độ đơn lẻ (Legacy persistent runner)
    const flow = getFlowOrThrow(config.flowName);
    logger.info(`Đã chọn luồng: "${flow.name}"`);

    // Đối với flow Muse: Nếu có bật chế độ proxy, trước khi thực hiện kéo mới proxy SG từ API
    const shouldFetchSgProxy =
      config.flowName === 'yopmail-muse' &&
      (config.proxy.enabled || config.initialConnectionMode === 'proxy');

    if (shouldFetchSgProxy) {
      logger.info(`\n===============================================================`);
      logger.info(`[NÂNG CAO PROXY] Chuẩn bị flow Muse: Kéo mới proxy SG từ API ProxyScrape...`);
      try {
        const sgResult = await findWorkingProxy('sg', {
          logger,
          fallbackProxy: config.proxy
        });
        config.proxy = sgResult.proxyConfig;
        config.initialConnectionMode = 'proxy';
        logger.info(
          `✔ [PROXY MẶC ĐỊNH SG] Đã chọn proxy SG hoạt động: ${config.proxy.server} (Nguồn: ${sgResult.source}, đã test ${sgResult.testedCount} proxy).`
        );
      } catch (sgErr) {
        logger.warn(
          `[CẢNH BÁO PROXY SG] Không thể lấy proxy SG: ${(sgErr as Error).message}. Tiếp tục với cấu hình hiện tại.`
        );
        if (!config.proxy.server || !config.proxy.server.trim()) {
          throw new Error(
            `[LỖI PROXY API] Không thể lấy proxy SG từ API ProxyScrape (${(sgErr as Error).message}) và không có proxy server dự phòng. Dừng luồng an toàn.`
          );
        }
      }
      logger.info(`===============================================================\n`);
    }

    browserManager = new BrowserManager(config, undefined, logger);
    const initialMode = browserManager.getConnectionMode();
    logger.info(`Chế độ kết nối ban đầu: "${initialMode}"`);

    logger.info(`Đang khởi chạy Google Chrome...`);
    session = await browserManager.initSession();
    logger.info(`Đã khởi chạy Chrome chính thức từ: ${session.executablePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'}`);

    if (config.incognito) {
      logger.info(`Chế độ trình duyệt: ẨN DANH (Incognito) - Tab ẩn danh không lưu session/profile.`);
    } else {
      logger.info(`Đường dẫn thư mục dữ liệu gốc (userDataDir): ${config.selectedProfile.userDataDir}`);
      logger.info(`Đường dẫn profile đầy đủ (Profile Path): ${config.selectedProfile.fullPath}`);
    }
    logger.info(`Đã mở URL ban đầu: ${sanitizeUrl(config.startUrl)}`);

    const flowContext: FlowContext = {
      page: session.page,
      config,
      runId,
      logger,
      cancellationToken: abortController.signal,
      browserManager
    };

    flowResult = await runFlow(flow, flowContext, projectRoot);

    logger.info('Kết quả thực thi luồng:');
    logger.info(JSON.stringify(flowResult, null, 2));

    // 1. Trường hợp thất bại: Tự đóng trình duyệt ngay lập tức và kết thúc, không chờ Enter
    if (flowResult.status === 'failed') {
      logger.error(
        `[THẤT BẠI] Luồng "${flow.name}" đã thất bại ở bước [${flowResult.failedStep?.id || 'unknown'}]: ${flowResult.error || ''}. Tự động đóng trình duyệt và kết thúc.`
      );
      await cleanup(false);
      process.exit(1);
    }

    // 2. Trường hợp thành công tất cả các bước:
    if (flowResult.status === 'success') {
      // Chỉ khi thành công tất cả các bước mới lưu email vào file output (tránh trường hợp thất bại giữa chừng)
      const finalEmail = (flowContext.data as any)?.emailAddress;
      if (finalEmail) {
        await saveEmailToOutputFile(finalEmail, {
          filePath: config.outputEmailsFile,
          logger
        }).catch(() => {});
      }

      // Khi cấu hình autoCloseOnComplete = true: Tự đóng trình duyệt và kết thúc để phục vụ chạy lặp lại
      if (config.autoCloseOnComplete) {
        logger.info(
          '✔ [HOÀN TẤT THÀNH CÔNG] Toàn bộ các bước đã thành công! Tự động đóng trình duyệt và kết thúc (autoCloseOnComplete = true).'
        );
        await cleanup(false);
        process.exit(0);
      }

      // Mặc định: Chờ người dùng nhấn ENTER để đóng trình duyệt
      if (!isCancelledByUser && !abortController.signal.aborted) {
        await waitForEnter();
      }
    }
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    logger.error(`Đã xảy ra lỗi thực thi: ${errorMsg}`);

    if (!flowResult) {
      flowResult = {
        runId,
        flowName: 'unknown',
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        completedSteps: [],
        error: errorMsg
      };
      saveFlowResult(runId, flowResult, projectRoot);
    }

    await cleanup(false);
    process.exit(1);
  } finally {
    await cleanup(false);
  }

  const finalStatus = (flowResult as FlowResult | null)?.status;
  if (isCancelledByUser || finalStatus === 'cancelled') {
    process.exit(130);
  } else if (finalStatus === 'failed') {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[LỖI KHÔNG XÁC ĐỊNH]', (err as Error).message);
  process.exit(1);
});
