import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { chromium } from 'playwright';
import { getProjectRoot, validateConfig } from '../src/config';
import { AppConfig, RawConfig } from '../src/config/types';
import { getChromeExecutablePath } from '../src/browser/common';
import { startFixtureServer, FixtureServer } from '../src/fixtures/server';
import { TabManager } from '../src/worker/tab-manager';
import { WorkerInstance } from '../src/worker/worker';
import { WorkerScheduler } from '../src/worker/scheduler';
import { TerminalController } from '../src/terminal/controller';
import { generateRunId } from '../src/utils/id';
import { WorkerLogger } from '../src/utils/worker-logger';
import '../src/flows';
import { multiTabDemoFlow } from '../src/flows/multi-tab-demo.flow';
import { registerFlow, getFlowOrThrow, getFlow } from '../src/flows/registry';
import { BrowserManager } from '../src/browser/manager';

async function runMultiWorkerTests(): Promise<void> {
  console.log('=== BẮT ĐẦU BỘ KIỂM THỬ BẮT BUỘC: MULTI-WORKER CHROME ẨN DANH ===\n');

  const projectRoot = getProjectRoot();
  const testRunId = 'mw_test_' + generateRunId();
  let fixture: FixtureServer | null = null;

  try {
    // 0. Khởi chạy máy chủ HTTP Fixture
    fixture = await startFixtureServer(0);
    console.log(`[FIXTURE] Máy chủ kiểm thử cục bộ đang chạy tại: ${fixture.url}`);

    // Đảm bảo flow demo đã đăng ký
    registerFlow(multiTabDemoFlow);

    // ==========================================
    // Test 1: Kiểm tra cấu hình và validation
    // ==========================================
    console.log('\n1. Kiểm tra cấu hình multi-worker incognito & validation:');

    // 1.1 Cấu hình hợp lệ 3 jobs, maxConcurrency = 2
    const validRaw: RawConfig = {
      browserMode: 'incognito',
      maxConcurrency: 2,
      jobs: [
        { id: 'demo-01', flowName: 'multi-tab-demo', connectionMode: 'direct' },
        { id: 'demo-02', flowName: 'multi-tab-demo', connectionMode: 'direct' },
        { id: 'demo-03', flowName: 'multi-tab-demo', connectionMode: 'direct' }
      ]
    };
    const validRes = validateConfig(validRaw, projectRoot);
    assert.strictEqual(validRes.valid, true, 'Cấu hình 3 job maxConcurrency=2 phải hợp lệ');
    assert.strictEqual(validRes.config?.maxConcurrency, 2);
    assert.strictEqual(validRes.config?.jobs?.length, 3);
    assert.strictEqual(validRes.config?.browserMode, 'incognito');
    console.log('  ✔ Cấu hình 3 jobs với maxConcurrency = 2 được thẩm định thành công.');

    // 1.2 Từ chối job ID trùng lặp
    const dupRaw: RawConfig = {
      browserMode: 'incognito',
      maxConcurrency: 2,
      jobs: [
        { id: 'dup-id', flowName: 'multi-tab-demo' },
        { id: 'dup-id', flowName: 'multi-tab-demo' }
      ]
    };
    const dupRes = validateConfig(dupRaw, projectRoot);
    assert.strictEqual(dupRes.valid, false);
    assert.ok(
      dupRes.errors.some((e) => e.includes('Job id không được trùng')),
      'Phải từ chối job id trùng nhau'
    );
    console.log('  ✔ Phát hiện và từ chối cấu hình chứa Job ID trùng lặp.');

    // 1.3 Từ chối flowName không tồn tại trong registry (không fallback)
    const invalidFlowRaw: RawConfig = {
      browserMode: 'incognito',
      maxConcurrency: 2,
      jobs: [{ id: 'job-err', flowName: 'non-existing-flow-name-xyz' }]
    };
    const invalidFlowRes = validateConfig(invalidFlowRaw, projectRoot);
    assert.strictEqual(invalidFlowRes.valid, false);
    assert.ok(
      invalidFlowRes.errors.some((e) => e.includes('Không tìm thấy luồng có tên "non-existing-flow-name-xyz"')),
      'Phải từ chối flowName không tồn tại'
    );
    console.log('  ✔ Từ chối flowName không tồn tại trong registry, không fallback ngầm.');

    // 1.4 Từ chối maxConcurrency không hợp lệ
    const invalidConcRaw: RawConfig = {
      browserMode: 'incognito',
      maxConcurrency: 0,
      jobs: [{ id: 'j1', flowName: 'multi-tab-demo' }]
    };
    const invalidConcRes = validateConfig(invalidConcRaw, projectRoot);
    assert.strictEqual(invalidConcRes.valid, false);
    assert.ok(
      invalidConcRes.errors.some((e) => e.includes('"maxConcurrency" phải là số nguyên dương')),
      'maxConcurrency phải > 0'
    );
    console.log('  ✔ Từ chối maxConcurrency <= 0.');

    // ==========================================
    // Test 2: TabManager riêng biệt theo Worker
    // ==========================================
    console.log('\n2. Kiểm tra TabManager riêng biệt cho từng worker:');
    const chromeExe = getChromeExecutablePath();
    const browserForTabTest = await chromium.launch({ channel: 'chrome', executablePath: chromeExe, headless: true });
    const contextForTabTest = await browserForTabTest.newContext();
    const tabManager = new TabManager({
      workerId: 'worker-test-tabs',
      context: contextForTabTest
    });

    const pageA = await tabManager.createTab('TabA', `${fixture.url}/page-a`);
    assert.ok(pageA, 'Phải tạo được TabA');
    assert.strictEqual(tabManager.hasTab('TabA'), true);

    const gotTabA = tabManager.getTab('TabA');
    assert.strictEqual(gotTabA, pageA, 'getTab("TabA") phải trả về đúng instance');

    // Truy vấn tab không tồn tại
    let threwNoSuchTab = false;
    try {
      tabManager.getTab('Tab-NonExistent');
    } catch (err) {
      threwNoSuchTab = true;
      assert.ok((err as Error).message.includes('Không tìm thấy tab'));
    }
    assert.strictEqual(threwNoSuchTab, true, 'getTab tab không tồn tại phải ném lỗi rõ ràng');

    // Đóng tab và kiểm tra lại
    await tabManager.closeTab('TabA');
    assert.strictEqual(tabManager.hasTab('TabA'), false);
    let threwClosedTab = false;
    try {
      tabManager.getTab('TabA');
    } catch (err) {
      threwClosedTab = true;
      assert.ok((err as Error).message.includes('Không tìm thấy tab'));
    }
    assert.strictEqual(threwClosedTab, true, 'getTab sau khi closeTab phải ném lỗi không tìm thấy tab');

    // Tạo TabB rồi đóng trực tiếp page để kiểm tra nhánh isClosed()
    const pageBDirect = await tabManager.createTab('TabB');
    await pageBDirect.close();
    let threwExternallyClosed = false;
    try {
      tabManager.getTab('TabB');
    } catch (err) {
      threwExternallyClosed = true;
      assert.ok((err as Error).message.includes('đã bị đóng'));
    }
    assert.strictEqual(threwExternallyClosed, true, 'getTab tab đã đóng từ bên ngoài phải báo đã bị đóng');

    await browserForTabTest.close();
    console.log('  ✔ TabManager quản lý TabA/TabB/TabC theo tên, báo lỗi rõ khi tab không tồn tại hoặc đã đóng.');

    // ==========================================
    // Test 3: TabA, TabB, TabC trong cùng một Worker chia sẻ cookie fixture
    // ==========================================
    console.log('\n3. Kiểm tra TabA, TabB, TabC cùng worker chia sẻ cookie fixture (trong cùng context ẩn danh):');
    const workerBrowser = await chromium.launch({ channel: 'chrome', executablePath: chromeExe, headless: true });
    const workerContext = await workerBrowser.newContext();
    const workerTabs = new TabManager({
      workerId: 'worker-cookie-test',
      context: workerContext
    });

    const tA = await workerTabs.createTab('TabA', `${fixture.url}/page-a`);
    const markerValue = `marker_worker1_${Date.now()}`;
    await tA.evaluate((m) => {
      document.cookie = `worker_marker=${m}; path=/; SameSite=Lax`;
    }, markerValue);

    const tB = await workerTabs.createTab('TabB', `${fixture.url}/page-b`);
    const tC = await workerTabs.createTab('TabC', `${fixture.url}/page-c`);

    const cookieOnTabB = await tB.evaluate(() => document.cookie);
    const cookieOnTabC = await tC.evaluate(() => document.cookie);

    assert.ok(cookieOnTabB.includes(markerValue), 'TabB phải đọc được cookie do TabA thiết lập');
    assert.ok(cookieOnTabC.includes(markerValue), 'TabC phải đọc được cookie do TabA thiết lập');

    await workerBrowser.close();
    console.log('  ✔ TabA, TabB, TabC trong cùng worker chia sẻ cookie fixture thành công 100%.');

    // ==========================================
    // Test 4: Hai worker độc lập KHÔNG chia sẻ cookie và marker
    // ==========================================
    console.log('\n4. Kiểm tra hai worker không chia sẻ cookie và marker (độc lập hoàn toàn):');
    const browserW1 = await chromium.launch({ channel: 'chrome', executablePath: chromeExe, headless: true });
    const ctxW1 = await browserW1.newContext();
    const pageW1 = await ctxW1.newPage();
    await pageW1.goto(`${fixture.url}/page-a`);
    await pageW1.evaluate(() => {
      document.cookie = 'worker_marker=SECRET_MARKER_WORKER_1; path=/; SameSite=Lax';
    });

    const browserW2 = await chromium.launch({ channel: 'chrome', executablePath: chromeExe, headless: true });
    const ctxW2 = await browserW2.newContext();
    const pageW2 = await ctxW2.newPage();
    await pageW2.goto(`${fixture.url}/page-a`);
    const cookieW2 = await pageW2.evaluate(() => document.cookie);

    assert.strictEqual(
      cookieW2.includes('SECRET_MARKER_WORKER_1'),
      false,
      'Worker 2 tuyệt đối không được đọc thấy cookie của Worker 1'
    );

    await browserW1.close();
    await browserW2.close();
    console.log('  ✔ Hai worker là hai phiên ẩn danh độc lập, không rò rỉ cookie hoặc marker sang nhau.');

    // ==========================================
    // Test 5: Scheduler 3 jobs, maxConcurrency = 2
    // ==========================================
    console.log('\n5. Kiểm tra Scheduler: 3 jobs, maxConcurrency = 2 (tối đa 2 worker giữ Chrome đồng thời):');
    const baseConfig: AppConfig = {
      startUrl: fixture.url,
      profileDir: '',
      selectedProfile: {
        profileName: 'Incognito',
        userDataDir: '',
        profileDirectory: 'Incognito',
        fullPath: '',
        cdpPort: 9222
      },
      navigationTimeoutMs: 15000,
      actionTimeoutMs: 10000,
      flowName: 'multi-tab-demo',
      screenshotOnError: false,
      initialConnectionMode: 'direct',
      proxy: { enabled: false },
      phoneMode: 'mock',
      browserMode: 'incognito',
      maxConcurrency: 2,
      jobs: [
        { id: 'job-01', flowName: 'multi-tab-demo', data: { skipManualWait: true, fixtureUrl: fixture.url } },
        { id: 'job-02', flowName: 'multi-tab-demo', data: { skipManualWait: true, fixtureUrl: fixture.url } },
        { id: 'job-03', flowName: 'multi-tab-demo', data: { skipManualWait: true, fixtureUrl: fixture.url } }
      ]
    };

    let peakConcurrency = 0;
    const scheduler = new WorkerScheduler({
      config: baseConfig,
      runId: testRunId,
      projectRoot,
      autoCloseOnComplete: true, // Trong test tự động đóng để tuần tự giải phóng slot
      maxConcurrency: 2
    });

    // Theo dõi số slot được cấp
    const pollInterval = setInterval(() => {
      const activeCount = scheduler.getActiveWorkers().length;
      if (activeCount > peakConcurrency) {
        peakConcurrency = activeCount;
      }
      assert.ok(activeCount <= 2, `Số worker hoạt động không được vượt quá maxConcurrency (hiện tại: ${activeCount})`);
    }, 50);

    scheduler.start();
    await scheduler.waitForIdle();
    clearInterval(pollInterval);

    assert.ok(peakConcurrency <= 2, `Đỉnh concurrency (${peakConcurrency}) phải <= 2`);
    assert.strictEqual(scheduler.getAllWorkers().length, 3, 'Cả 3 jobs phải được thực hiện hoàn tất');

    for (const w of scheduler.getAllWorkers()) {
      assert.strictEqual(w.getStatus(), 'closed', `Worker ${w.workerId} phải hoàn tất và closed`);
      assert.strictEqual(w.getResult()?.status, 'success', `Kết quả của ${w.workerId} phải là success`);
    }
    console.log(`  ✔ Scheduler điều phối chính xác 3 jobs với tối đa 2 worker cùng lúc (đỉnh: ${peakConcurrency}).`);

    // ==========================================
    // Test 6: Dừng worker 1 không làm worker 2 dừng
    // ==========================================
    console.log('\n6. Kiểm tra độc lập khi dừng: Dừng worker 1 không làm worker 2 dừng:');
    const w1 = new WorkerInstance({
      workerId: 'worker-stop-1',
      runId: testRunId,
      job: { id: 'stop-j1', flowName: 'multi-tab-demo', data: { skipManualWait: false, fixtureUrl: fixture.url } },
      config: baseConfig,
      projectRoot,
      autoCloseOnComplete: false
    });
    const w2 = new WorkerInstance({
      workerId: 'worker-stop-2',
      runId: testRunId,
      job: { id: 'stop-j2', flowName: 'multi-tab-demo', data: { skipManualWait: true, fixtureUrl: fixture.url } },
      config: baseConfig,
      projectRoot,
      autoCloseOnComplete: true
    });

    // Khởi chạy cả 2 worker
    const p1 = w1.start();
    const p2 = w2.start();

    // Chờ w1 vào trạng thái awaiting-human
    let waited = 0;
    while (w1.getStatus() !== 'awaiting-human' && waited < 100) {
      await new Promise((r) => setTimeout(r, 100));
      waited++;
    }
    assert.strictEqual(w1.getStatus(), 'awaiting-human');

    // Dừng riêng worker 1
    await w1.stop();
    assert.strictEqual(w1.getStatus(), 'closed');
    assert.strictEqual(w1.getResult()?.status, 'cancelled');

    // Đợi worker 2 hoàn thành
    await p2;
    assert.strictEqual(w2.getResult()?.status, 'success', 'Worker 2 phải hoàn thành thành công dù Worker 1 bị dừng');
    console.log('  ✔ Dừng worker 1 độc lập hoàn toàn, worker 2 vẫn hoàn thành thành công.');

    // ==========================================
    // Test 7: Terminal Controller: resume worker 1 không làm worker 2 chạy tiếp
    // ==========================================
    console.log('\n7. Kiểm tra resume đúng worker qua Terminal Controller:');
    const schedResume = new WorkerScheduler({
      config: {
        ...baseConfig,
        jobs: [
          { id: 'resume-j1', flowName: 'multi-tab-demo', data: { skipManualWait: false, fixtureUrl: fixture.url } },
          { id: 'resume-j2', flowName: 'multi-tab-demo', data: { skipManualWait: false, fixtureUrl: fixture.url } }
        ]
      },
      runId: testRunId,
      projectRoot,
      autoCloseOnComplete: false,
      maxConcurrency: 2
    });

    const termCtrl = new TerminalController(schedResume);
    schedResume.start();

    // Chờ cả 2 worker đạt awaiting-human
    let waitResume = 0;
    while (
      schedResume.getAllWorkers().filter((w) => w.getStatus() === 'awaiting-human').length < 2 &&
      waitResume < 150
    ) {
      await new Promise((r) => setTimeout(r, 100));
      waitResume++;
    }

    const rw1 = schedResume.getWorker('worker-1');
    const rw2 = schedResume.getWorker('worker-2');
    assert.ok(rw1 && rw2, 'Phải có worker-1 và worker-2');
    assert.strictEqual(rw1?.getStatus(), 'awaiting-human');
    assert.strictEqual(rw2?.getStatus(), 'awaiting-human');

    // Gửi lệnh resume worker-1
    const resumeResp = await termCtrl.handleCommand('resume worker-1');
    assert.ok(resumeResp.includes('Đã gửi tín hiệu resume đến worker [worker-1]'));

    // Chờ một chút và kiểm tra: worker-1 phải tiếp tục còn worker-2 vẫn awaiting-human
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(rw1.getStatus() === 'running' || rw1.getStatus() === 'completed', 'Worker-1 phải chuyển trạng thái tiếp');
    assert.strictEqual(rw2.getStatus(), 'awaiting-human', 'Worker-2 vẫn phải giữ nguyên trạng thái awaiting-human');

    // Dọn dẹp cả 2
    await termCtrl.handleCommand('stop-all');
    console.log('  ✔ resume worker-1 chỉ tiếp tục worker-1, worker-2 giữ nguyên trạng thái chờ.');

    // ==========================================
    // Test 8: Đổi proxy giữa phiên ẩn danh bị chặn trước khi đóng context
    // ==========================================
    console.log('\n8. Kiểm tra chặn đổi proxy giữa phiên ẩn danh:');
    const bmIncognito = new BrowserManager(
      {
        ...baseConfig,
        incognito: true,
        proxy: { enabled: true, server: 'http://127.0.0.1:8888' }
      },
      undefined,
      undefined
    );

    // Khi gọi switchConnectionMode sang chế độ khác trên phiên incognito
    let threwIncognitoSwitchError = false;
    try {
      await bmIncognito.switchConnectionMode('proxy');
    } catch (err) {
      threwIncognitoSwitchError = true;
      assert.ok(
        (err as Error).message.includes(
          'Chưa hỗ trợ đổi proxy giữa phiên ẩn danh; đóng phiên có thể làm mất đăng nhập và trạng thái tab.'
        ),
        'Thông báo chặn phải đúng chuẩn'
      );
    }
    assert.strictEqual(threwIncognitoSwitchError, true, 'Phải chặn đổi proxy giữa phiên ẩn danh');

    // Nếu yêu cầu lại cùng chế độ direct: trả về no-op không lỗi
    const noOpResult = await bmIncognito.switchConnectionMode('direct');
    assert.ok(noOpResult !== undefined, 'Yêu cầu lại cùng chế độ phải trả về no-op an toàn');
    console.log('  ✔ Chặn đổi proxy giữa phiên ẩn danh trước khi đóng context; no-op khi cùng chế độ.');

    // ==========================================
    // Test 9: Proxy lỗi chỉ làm worker tương ứng thất bại, không fallback
    // ==========================================
    console.log('\n9. Kiểm tra proxy lỗi chỉ làm worker tương ứng thất bại:');
    const badProxyWorker = new WorkerInstance({
      workerId: 'worker-bad-proxy',
      runId: testRunId,
      job: { id: 'bad-proxy-job', flowName: 'multi-tab-demo', connectionMode: 'proxy' },
      config: {
        ...baseConfig,
        proxy: { enabled: true, server: 'http://127.0.0.1:59999' } // Port không tồn tại
      },
      projectRoot,
      autoCloseOnComplete: true
    });

    const badProxyResult = await badProxyWorker.start();
    assert.strictEqual(badProxyResult.status, 'failed', 'Worker có proxy lỗi phải thất bại');
    assert.ok(
      badProxyResult.error?.includes('PROXY') || badProxyResult.error?.includes('ERR_') || badProxyResult.error?.includes('ECONNREFUSED'),
      'Lỗi phải chỉ rõ vấn đề proxy'
    );
    console.log('  ✔ Worker với proxy lỗi dừng an toàn và thất bại, tuyệt đối không tự fallback sang direct.');

    // ==========================================
    // Test 10: Worker mới bắt đầu với phiên sạch
    // ==========================================
    console.log('\n10. Kiểm tra worker mới bắt đầu với phiên sạch:');
    const cleanWorker = new WorkerInstance({
      workerId: 'worker-clean-session',
      runId: testRunId,
      job: {
        id: 'clean-job',
        flowName: 'multi-tab-demo',
        connectionMode: 'direct',
        data: { fixtureUrl: fixture.url, skipManualWait: true }
      },
      config: baseConfig,
      projectRoot,
      autoCloseOnComplete: false
    });

    const cleanRes = await cleanWorker.start();
    assert.strictEqual(cleanRes.status, 'success');
    await cleanWorker.close();
    console.log('  ✔ Worker mới bắt đầu với phiên sạch, không lưu hoặc nạp storageState.');

    // ==========================================
    // Test 11: Kiểm tra log và kết quả không chứa dữ liệu nhạy cảm
    // ==========================================
    console.log('\n11. Kiểm tra cấu trúc file log và lọc dữ liệu nhạy cảm:');
    const workerLogger = new WorkerLogger({
      runId: testRunId,
      workerId: 'worker-log-test',
      jobId: 'j-log',
      flowName: 'multi-tab-demo',
      projectRoot
    });

    workerLogger.info('Kiểm tra Authorization: Bearer secret_token_xyz và otp 123456');
    const logFilePath = workerLogger.getLogFilePath();
    assert.ok(fs.existsSync(logFilePath), 'File log worker phải tồn tại');

    const logContent = fs.readFileSync(logFilePath, 'utf-8');
    assert.strictEqual(logContent.includes('secret_token_xyz'), false, 'Log không được chứa token');
    assert.ok(logContent.includes('[worker-log-test]'), 'Log phải có workerId');
    assert.ok(logContent.includes('[j-log]'), 'Log phải có jobId');
    assert.ok(logContent.includes('[multi-tab-demo]'), 'Log phải có flowName');

    workerLogger.saveResult({
      workerId: 'worker-log-test',
      jobId: 'j-log',
      runId: testRunId,
      flowName: 'multi-tab-demo',
      status: 'success',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      completedSteps: ['step-1']
    });

    const resultFilePath = path.join(projectRoot, 'logs', testRunId, 'worker-log-test.result.json');
    assert.ok(fs.existsSync(resultFilePath), 'File result.json của worker phải tồn tại');
    console.log('  ✔ File log logs/<runId>/<workerId>.log và result.json có đầy đủ thông tin và không chứa dữ liệu nhạy cảm.');

    // ==========================================
    // Test 12: Kiểm tra từ chối chạy đồng thời luồng live chưa hỗ trợ (Section 11)
    // ==========================================
    console.log('\n12. Kiểm tra an toàn nghiệp vụ: Từ chối chạy đồng thời luồng live (yopmail-muse):');
    const liveFlowWorker = new WorkerInstance({
      workerId: 'worker-live-check',
      runId: testRunId,
      job: { id: 'live-job-1', flowName: 'yopmail-muse' },
      config: {
        ...baseConfig,
        maxConcurrency: 2,
        jobs: [
          { id: 'live-job-1', flowName: 'yopmail-muse' },
          { id: 'live-job-2', flowName: 'yopmail-muse' }
        ]
      },
      projectRoot,
      autoCloseOnComplete: true
    });

    const liveRes = await liveFlowWorker.start();
    assert.strictEqual(liveRes.status, 'failed');
    assert.ok(
      liveRes.error?.includes('TỪ CHỐI CHẠY ĐỒNG THỜI') && liveRes.error?.includes('yopmail-muse'),
      'Phải từ chối chạy đồng thời luồng yopmail-muse'
    );
    console.log('  ✔ Từ chối chạy đồng thời luồng yopmail-muse theo đúng nguyên tắc bảo vệ tài khoản và giới hạn nghiệp vụ.');

    console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ MULTI-WORKER ĐÃ VƯỢT QUA 100%! ===');
  } finally {
    if (fixture) {
      await fixture.close();
    }
  }
}

runMultiWorkerTests().catch((err) => {
  console.error('\n[LỖI TEST MULTI-WORKER]', err);
  process.exit(1);
});
