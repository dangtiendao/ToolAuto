import { loadConfig, formatSafeConfig, getProjectRoot } from './config';
import { BrowserManager, waitForEnter, BrowserSession } from './browser';
import { getFlowOrThrow } from './flows';
import { runFlow, FlowContext, FlowResult, saveFlowResult } from './runner';
import { generateRunId, Logger, sanitizeUrl } from './utils';

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
  let isCleaningUp = false;
  let isCancelledByUser = false;

  // Hàm dọn dẹp tài nguyên an toàn (idempotent - gọi nhiều lần không lỗi)
  const cleanup = async (isSigint: boolean = false): Promise<void> => {
    if (isCleaningUp) return;
    isCleaningUp = true;

    if (isSigint) {
      isCancelledByUser = true;
      abortController.abort();
      logger.warn('Nhận tín hiệu dừng (Ctrl+C). Đang ngắt kết nối trình duyệt và hủy luồng...');
    }

    // Đóng browser context an toàn qua BrowserManager
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

    // 2. Tra cứu luồng trong Registry
    const flow = getFlowOrThrow(config.flowName);
    logger.info(`Đã chọn luồng: "${flow.name}"`);

    // 3. Khởi tạo Trình quản lý trình duyệt (BrowserManager)
    browserManager = new BrowserManager(config, undefined, logger);
    const initialMode = browserManager.getConnectionMode();
    logger.info(`Chế độ kết nối ban đầu: "${initialMode}"`);

    // 4. Khởi chạy Google Chrome theo cấu hình đã chọn
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
    logger.info(
      '(Lưu ý: Mở trang thành công xác nhận kết nối mạng/proxy tới URL ban đầu hoạt động, không phải là xác minh IP đầu ra).'
    );

    // 5. Chuẩn bị Context và thực thi luồng
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

    // 6. Nếu không bị hủy, chờ người dùng nhấn Enter để đóng Chrome
    if (!isCancelledByUser && !abortController.signal.aborted) {
      await waitForEnter();
    }
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    logger.error(`Đã xảy ra lỗi thực thi: ${errorMsg}`);

    // Lưu kết quả lỗi nếu chưa có flowResult
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

  // 7. Phân loại mã thoát theo quy định
  if (isCancelledByUser || flowResult?.status === 'cancelled') {
    process.exit(130);
  } else if (flowResult?.status === 'failed') {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[LỖI KHÔNG XÁC ĐỊNH]', (err as Error).message);
  process.exit(1);
});
