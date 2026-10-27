import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { runFlow, saveFlowResult } from '../src/runner';
import { Flow, FlowContext } from '../src/runner/types';
import { registerFlow, getFlow, getFlowOrThrow } from '../src/flows/registry';
import { demoFlow } from '../src/flows/demo.flow';
import { AppConfig } from '../src/config/types';
import { Logger, generateRunId, sanitizeUrl, sanitizeLogText } from '../src/utils';
import { getProjectRoot } from '../src/config';

async function runTests(): Promise<void> {
  console.log('--- BẮT ĐẦU KIỂM TRA MODULE RUNNER, LOGGER & SAFE SHUTDOWN ---\n');

  const projectRoot = getProjectRoot();
  const testRunId = 'test_' + generateRunId();
  const logger = new Logger(testRunId, projectRoot);

  const mockConfig: AppConfig = {
    startUrl: 'https://example.com',
    profileDir: 'profiles/test',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    flowName: 'demo',
    screenshotOnError: true,
    proxy: { enabled: false }
  };

  const dummyContext: FlowContext = {
    page: {} as any,
    config: mockConfig,
    runId: testRunId,
    logger
  };

  // ==========================================
  // Test 1: Flow Registry
  // ==========================================
  console.log('1. Kiểm tra Flow Registry:');

  registerFlow(demoFlow);
  const foundDemo = getFlow('demo');
  assert.ok(foundDemo, 'Phải tìm thấy demo flow');
  assert.strictEqual(foundDemo?.name, 'demo');

  let threwNotFound = false;
  try {
    getFlowOrThrow('unknown-flow-name');
  } catch (err: unknown) {
    threwNotFound = true;
    const msg = (err as Error).message;
    assert.ok(msg.includes('Không tìm thấy luồng có tên "unknown-flow-name"'));
    assert.ok(msg.includes('Các luồng hiện có'));
  }
  assert.strictEqual(threwNotFound, true, 'getFlowOrThrow phải ném lỗi khi không tìm thấy flow');
  console.log('  ✔ Registry tìm kiếm đúng và từ chối fallback khi sai tên luồng.');

  // ==========================================
  // Test 2: Sanitization (Loại bỏ mật khẩu, URL xác thực, token)
  // ==========================================
  console.log('\n2. Kiểm tra lọc thông tin nhạy cảm (Sanitize):');
  const rawAuthUrl = 'http://admin_user:my_secret_pass@example.com:8080/path?param=1';
  const cleanUrl = sanitizeUrl(rawAuthUrl);
  assert.strictEqual(cleanUrl.includes('my_secret_pass'), false, 'URL không được chứa mật khẩu');
  assert.strictEqual(cleanUrl.includes('admin_user'), false, 'URL không được chứa username');
  assert.strictEqual(cleanUrl, 'http://example.com:8080/path?param=1');

  const rawLog = 'Gửi header Authorization: Bearer abc123def456 và Cookie: session=secret789';
  const cleanLog = sanitizeLogText(rawLog);
  assert.strictEqual(cleanLog.includes('abc123def456'), false, 'Log không được chứa token');
  assert.strictEqual(cleanLog.includes('secret789'), false, 'Log không được chứa cookie');
  assert.ok(cleanLog.includes('[REDACTED]'), 'Nội dung nhạy cảm phải được thay bằng [REDACTED]');
  console.log('  ✔ Lọc URL xác thực và token/cookie trong log thành công.');

  // ==========================================
  // Test 3: Ghi nhật ký (Logger) ra file logs/<runId>.log
  // ==========================================
  console.log('\n3. Kiểm tra Logger ghi file log:');
  logger.info('Thông điệp thông tin kiểm thử', { flow: 'test-flow', step: 's1' });
  logger.warn('Thông điệp cảnh báo kiểm thử', { flow: 'test-flow', step: 's1' });
  logger.error('Thông điệp lỗi kiểm thử', { flow: 'test-flow', step: 's1' });
  logger.stepResult('test-flow', 's1', 'success', 'Thực hiện thành công');

  const logFilePath = logger.getLogFilePath();
  assert.ok(fs.existsSync(logFilePath), 'File log phải được tạo');
  const logContent = fs.readFileSync(logFilePath, 'utf-8');
  assert.ok(logContent.includes('[INFO]'));
  assert.ok(logContent.includes('[WARN]'));
  assert.ok(logContent.includes('[ERROR]'));
  assert.ok(logContent.includes('[Luồng: test-flow]'));
  assert.ok(logContent.includes('[Bước: s1]'));
  assert.ok(logContent.includes('Kết quả bước: THÀNH CÔNG'));
  console.log('  ✔ File log được tạo và ghi đúng cấu trúc, thời gian, mức độ và kết quả.');

  // ==========================================
  // Test 4: Lưu kết quả Runner vào logs/<runId>.result.json
  // ==========================================
  console.log('\n4. Kiểm tra lưu kết quả vào file result.json:');
  const sampleResult = {
    runId: testRunId,
    flowName: 'demo',
    status: 'success' as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    completedSteps: ['step-a', 'step-b']
  };

  const resultFilePath = saveFlowResult(testRunId, sampleResult, projectRoot);
  assert.ok(fs.existsSync(resultFilePath), 'File result.json phải được tạo');
  const savedData = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
  assert.strictEqual(savedData.runId, testRunId);
  assert.strictEqual(savedData.status, 'success');
  assert.deepStrictEqual(savedData.completedSteps, ['step-a', 'step-b']);
  console.log('  ✔ Kết quả runner được lưu thành công vào file result.json.');

  // ==========================================
  // Test 5: Sequential Execution & Dừng khi có lỗi
  // ==========================================
  console.log('\n5. Kiểm tra thực thi tuần tự và dừng khi gặp lỗi:');
  let step3Ran = false;

  const failingFlow: Flow = {
    name: 'test-failing',
    steps: [
      {
        id: 's1',
        name: 'Bước đầu tiên',
        execute: async () => {}
      },
      {
        id: 's2',
        name: 'Bước thứ hai bị lỗi',
        execute: async () => {
          throw new Error('Lỗi cố ý tại bước s2');
        }
      },
      {
        id: 's3',
        name: 'Bước thứ ba không được chạy',
        execute: async () => {
          step3Ran = true;
        }
      }
    ]
  };

  const failResult = await runFlow(failingFlow, dummyContext, projectRoot);
  assert.strictEqual(failResult.status, 'failed');
  assert.strictEqual(step3Ran, false, 'Bước 3 không được chạy khi bước 2 đã lỗi');
  assert.deepStrictEqual(failResult.completedSteps, ['s1']);
  assert.strictEqual(failResult.failedStep?.id, 's2');
  assert.ok(failResult.error?.includes('Lỗi cố ý tại bước s2'));
  console.log('  ✔ Dừng ngay lập tức tại bước lỗi, ghi nhận failedStep và không retry.');

  // ==========================================
  // Test 6: Chụp ảnh màn hình khi gặp lỗi (Error Screenshot)
  // ==========================================
  console.log('\n6. Kiểm tra chụp ảnh màn hình lỗi:');

  let screenshotTaken = false;
  const mockPageWithScreenshot: any = {
    isClosed: () => false,
    screenshot: async (options: { path: string }) => {
      screenshotTaken = true;
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      fs.writeFileSync(options.path, 'fake-png-content');
    }
  };

  const screenshotContext: FlowContext = {
    ...dummyContext,
    page: mockPageWithScreenshot,
    config: {
      ...mockConfig,
      screenshotOnError: true
    }
  };

  const screenshotFlowResult = await runFlow(failingFlow, screenshotContext, projectRoot);
  assert.strictEqual(screenshotTaken, true, 'Phải gọi page.screenshot khi bước lỗi và tính năng bật');
  assert.ok(screenshotFlowResult.failedStep?.screenshotPath, 'failedStep phải lưu đường dẫn ảnh');
  assert.ok(fs.existsSync(screenshotFlowResult.failedStep!.screenshotPath!), 'Tệp ảnh chụp màn hình phải tồn tại');

  // Kiểm tra khi tắt chụp ảnh bằng cấu hình (screenshotOnError = false)
  let screenshotTakenWhenDisabled = false;
  const mockPageDisabled: any = {
    isClosed: () => false,
    screenshot: async () => {
      screenshotTakenWhenDisabled = true;
    }
  };

  const disabledScreenshotContext: FlowContext = {
    ...dummyContext,
    page: mockPageDisabled,
    config: {
      ...mockConfig,
      screenshotOnError: false
    }
  };

  const disabledResult = await runFlow(failingFlow, disabledScreenshotContext, projectRoot);
  assert.strictEqual(screenshotTakenWhenDisabled, false, 'Tuyệt đối không chụp ảnh khi screenshotOnError = false');
  assert.strictEqual(disabledResult.failedStep?.screenshotPath, undefined);
  console.log('  ✔ Chụp ảnh khi lỗi và tắt chụp ảnh theo cấu hình hoạt động chính xác.');

  // ==========================================
  // Test 7: Lỗi chụp ảnh không được che mất lỗi gốc
  // ==========================================
  console.log('\n7. Kiểm tra lỗi chụp ảnh không che mất lỗi gốc:');
  const mockPageBrokenScreenshot: any = {
    isClosed: () => false,
    screenshot: async () => {
      throw new Error('Screenshot system failure!');
    }
  };

  const brokenScreenshotContext: FlowContext = {
    ...dummyContext,
    page: mockPageBrokenScreenshot,
    config: {
      ...mockConfig,
      screenshotOnError: true
    }
  };

  const brokenScreenshotResult = await runFlow(failingFlow, brokenScreenshotContext, projectRoot);
  assert.strictEqual(brokenScreenshotResult.status, 'failed');
  assert.ok(
    brokenScreenshotResult.error?.includes('Lỗi cố ý tại bước s2'),
    'Lỗi nghiệp vụ gốc phải được giữ nguyên, không bị thay bằng lỗi screenshot'
  );
  console.log('  ✔ Lỗi chụp ảnh thất bại không làm che mất lỗi gốc.');

  // ==========================================
  // Test 8: Tín hiệu hủy (Cancellation)
  // ==========================================
  console.log('\n8. Kiểm tra hủy luồng qua CancellationToken:');
  const cancelController = new AbortController();
  cancelController.abort();

  const cancelResult = await runFlow(
    {
      name: 'test-cancelled',
      steps: [{ id: 'c1', name: 'Bị hủy', execute: async () => {} }]
    },
    {
      ...dummyContext,
      cancellationToken: cancelController.signal
    },
    projectRoot
  );

  assert.strictEqual(cancelResult.status, 'cancelled');
  assert.strictEqual(cancelResult.completedSteps.length, 0);
  console.log('  ✔ Hủy luồng thành công với trạng thái "cancelled".');

  // ==========================================
  // Test 9: Luồng Demo với Mock Page
  // ==========================================
  console.log('\n9. Kiểm tra luồng Demo:');
  const mockPage: any = {
    waitForLoadState: async () => {},
    evaluate: async () => 'complete',
    title: async () => 'Example Domain',
    url: () => 'https://example.com/'
  };

  const demoResult = await runFlow(
    demoFlow,
    {
      ...dummyContext,
      page: mockPage
    },
    projectRoot
  );
  assert.strictEqual(demoResult.status, 'success');
  assert.deepStrictEqual(demoResult.completedSteps, ['wait-dom-ready', 'read-page-info']);
  console.log('  ✔ Luồng Demo chạy thành công.');

  // Dọn dẹp logs và screenshots test
  if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
  if (fs.existsSync(resultFilePath)) fs.unlinkSync(resultFilePath);
  const testScreenshotDir = path.resolve(projectRoot, 'screenshots', testRunId);
  if (fs.existsSync(testScreenshotDir)) fs.rmSync(testScreenshotDir, { recursive: true, force: true });

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA RUNNER & LOGS ĐÃ VƯỢT QUA! ---');
}

runTests().catch((err) => {
  console.error('Lỗi khi chạy kiểm tra runner:', err);
  process.exit(1);
});
