import * as fs from 'fs';
import * as path from 'path';
import { Flow, FlowContext, FlowResult, CancellationToken } from './types';
import { getProjectRoot } from '../config';

/**
 * Kiểm tra xem tín hiệu hủy (AbortSignal hoặc CancellationToken) đã được kích hoạt hay chưa.
 */
export function isCancelled(token?: AbortSignal | CancellationToken): boolean {
  if (!token) return false;
  if ('aborted' in token) return token.aborted;
  if ('isCancelled' in token) return token.isCancelled;
  return false;
}

/**
 * Lưu kết quả thực thi luồng vào logs/<runId>.result.json.
 */
export function saveFlowResult(
  runId: string,
  result: FlowResult,
  projectRoot: string = getProjectRoot()
): string {
  const logsDir = path.resolve(projectRoot, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const resultFilePath = path.join(logsDir, `${runId}.result.json`);
  fs.writeFileSync(resultFilePath, JSON.stringify(result, null, 2), 'utf-8');
  return resultFilePath;
}

/**
 * Chụp ảnh màn hình khi gặp lỗi nếu page còn hoạt động và tính năng được bật.
 * Nếu chụp ảnh thất bại, chỉ ghi cảnh báo và KHÔNG làm mất lỗi gốc.
 */
async function captureErrorScreenshot(
  context: FlowContext,
  stepId: string,
  projectRoot: string
): Promise<string | undefined> {
  if (context.config.screenshotOnError === false) {
    context.logger.info(
      'Tính năng chụp ảnh khi gặp lỗi đã bị tắt theo cấu hình (screenshotOnError = false).',
      { flow: context.config.flowName, step: stepId }
    );
    return undefined;
  }

  // Đồng bộ lại Page từ BrowserManager nếu có
  if (context.browserManager) {
    try {
      context.page = context.browserManager.getCurrentPage();
    } catch {
      // Giữ nguyên page hiện tại
    }
  }

  if (!context.page || typeof context.page.isClosed !== 'function' || context.page.isClosed()) {
    context.logger.warn(
      'Không thể chụp ảnh màn hình lỗi vì trang (page) không khả dụng hoặc đã bị đóng.',
      { flow: context.config.flowName, step: stepId }
    );
    return undefined;
  }

  try {
    const screenshotsDir = path.resolve(projectRoot, 'screenshots', context.runId);
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const timestamp = Date.now();
    const filename = `error_${stepId}_${timestamp}.png`;
    const fullPath = path.join(screenshotsDir, filename);

    await context.page.screenshot({
      path: fullPath,
      fullPage: true,
      timeout: 5000
    });

    context.logger.warn(
      `Đã chụp ảnh màn hình lỗi tại: ${fullPath} (Lưu ý: Ảnh chụp có thể chứa dữ liệu nhạy cảm hiển thị trên trang).`,
      { flow: context.config.flowName, step: stepId }
    );

    return fullPath;
  } catch (screenshotErr) {
    // Tuyệt đối không ném lỗi tại đây để không che mất lỗi nghiệp vụ gốc
    context.logger.warn(
      `Không thể chụp ảnh màn hình lỗi: ${(screenshotErr as Error).message}`,
      { flow: context.config.flowName, step: stepId }
    );
    return undefined;
  }
}

/**
 * Bộ thực thi luồng tuần tự (Sequential Flow Runner).
 * Thực hiện các bước theo thứ tự định nghĩa.
 * Dừng ngay lập tức khi một bước gặp lỗi và không tự động thử lại.
 */
export async function runFlow(
  flow: Flow,
  context: FlowContext,
  projectRoot: string = getProjectRoot()
): Promise<FlowResult> {
  const startedAt = new Date().toISOString();
  const completedSteps: string[] = [];
  const logger = context.logger;

  logger.info(`Bắt đầu thực thi luồng: "${flow.name}" (Tổng số bước: ${flow.steps.length})`, {
    flow: flow.name
  });
  if (flow.description) {
    logger.info(`Mô tả: ${flow.description}`, { flow: flow.name });
  }

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const stepCtx = { flow: flow.name, step: step.id };

    // 1. Kiểm tra tín hiệu hủy trước khi bước bắt đầu
    if (isCancelled(context.cancellationToken)) {
      logger.warn(`Luồng đã nhận tín hiệu dừng. Bỏ qua bước [${step.id}].`, stepCtx);
      logger.stepResult(flow.name, step.id, 'cancelled', 'Bị hủy bởi người dùng hoặc tín hiệu dừng');

      const cancelledResult: FlowResult = {
        runId: context.runId,
        flowName: flow.name,
        status: 'cancelled',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps,
        error: 'Luồng đã dừng do nhận được tín hiệu hủy.'
      };
      saveFlowResult(context.runId, cancelledResult, projectRoot);
      return cancelledResult;
    }

    // 1.1. Kiểm tra điều kiện thực thi bước nếu có
    if (typeof step.shouldRun === 'function' && !step.shouldRun(context)) {
      logger.info(
        `[BỎ QUA BƯỚC] Đã bỏ qua bước "${step.name}" (${step.id}) theo cấu hình thực thi.`,
        stepCtx
      );
      continue;
    }

    logger.info(`Bắt đầu thực thi bước: "${step.name}"`, stepCtx);

    // Đồng bộ Page hiện tại từ BrowserManager nếu có (đảm bảo không dùng Page cũ sau restart)
    if (context.browserManager) {
      try {
        context.page = context.browserManager.getCurrentPage();
      } catch {
        // Nếu trang chưa mở hoặc đang chuyển chế độ, giữ nguyên
      }
    }

    try {
      // 2. Thực thi bước
      await step.execute(context);

      // Cập nhật lại context.page sau khi thực thi bước (nếu bước vừa tạo tab mới hoặc chuyển proxy)
      if (context.browserManager) {
        try {
          context.page = context.browserManager.getCurrentPage();
        } catch {
          // Bỏ qua
        }
      }

      // 3. Kiểm tra điều kiện xác nhận nếu có
      if (step.verify) {
        const verified = await step.verify(context);
        if (!verified) {
          throw new Error(`Điều kiện xác nhận (verify) cho bước "${step.name}" không thỏa mãn.`);
        }
      }

      completedSteps.push(step.id);
      logger.stepResult(flow.name, step.id, 'success', `Hoàn thành bước "${step.name}"`);
    } catch (err) {
      // 4. Khi bước lỗi: chụp ảnh (nếu được bật và page còn sống), dừng luồng ngay, không retry
      const rawMessage = (err as Error).message || String(err);
      logger.stepResult(flow.name, step.id, 'failed', rawMessage);

      // Chụp ảnh màn hình lỗi an toàn
      const screenshotPath = await captureErrorScreenshot(context, step.id, projectRoot);

      logger.error(
        `Luồng dừng ngay lập tức tại bước [${step.id}]. Không tự động thử lại.`,
        stepCtx
      );

      const failedResult: FlowResult = {
        runId: context.runId,
        flowName: flow.name,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        completedSteps,
        failedStep: {
          id: step.id,
          name: step.name,
          screenshotPath
        },
        error: rawMessage
      };

      saveFlowResult(context.runId, failedResult, projectRoot);
      return failedResult;
    }
  }

  const finishedAt = new Date().toISOString();
  logger.info(`Luồng "${flow.name}" đã hoàn thành thành công toàn bộ các bước!`, {
    flow: flow.name
  });

  const successResult: FlowResult = {
    runId: context.runId,
    flowName: flow.name,
    status: 'success',
    startedAt,
    finishedAt,
    completedSteps
  };

  saveFlowResult(context.runId, successResult, projectRoot);
  return successResult;
}

export * from './types';
