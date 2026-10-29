import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../src/config/types';
import {
  BrowserManager,
  getConnectionMode,
  switchConnectionMode,
  enableProxy,
  disableProxy,
  handleLaunchError
} from '../src/browser';
import { runFlow, FlowContext } from '../src/runner';
import { proxySwitchDemoFlow } from '../src/flows/proxy-switch-demo.flow';
import { Logger } from '../src/utils/logger';

// Helper tạo mock HTTP/CONNECT Proxy server local
function createLocalProxyServer(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ origin: '10.99.99.99', proxyActive: true }));
    });

    server.on('connect', (req, clientSocket, head) => {
      const parts = (req.url || '').split(':');
      const targetHost = parts[0] || '127.0.0.1';
      const targetPort = parseInt(parts[1] || '80', 10);

      const serverSocket = net.connect(targetPort, targetHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) {
          serverSocket.write(head);
        }
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });

      serverSocket.on('error', () => {
        clientSocket.destroy();
      });
      clientSocket.on('error', () => {
        serverSocket.destroy();
      });
    });

    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Helper tạo local web server để Chrome kiểm tra kết nối không cần internet ngoài
function createLocalTestWebServer(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Test Page</title></head><body>{"origin": "127.0.0.1", "status": "ok"}</body></html>`);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function runProxyTests(): Promise<void> {
  console.log('--- BẮT ĐẦU KIỂM TRA TOÀN DIỆN MODULE CHUYỂN PROXY & PERSISTENT CONTEXT ---\n');

  const projectRoot = path.resolve(__dirname, '..');
  const testUserDataDir = path.resolve(projectRoot, 'profiles', 'TestProxyUserData');
  if (!fs.existsSync(testUserDataDir)) {
    fs.mkdirSync(testUserDataDir, { recursive: true });
  }

  const WEB_PORT = 19180;
  const PROXY_PORT = 19181;
  const DEAD_PROXY_PORT = 19189; // Cổng không có server

  const webServer = await createLocalTestWebServer(WEB_PORT);
  const proxyServer = await createLocalProxyServer(PROXY_PORT);

  const testConfig: AppConfig = {
    startUrl: `http://127.0.0.1:${WEB_PORT}/`,
    profileDir: path.join(testUserDataDir, 'Profile 1'),
    selectedProfile: {
      profileName: 'TestProfile',
      userDataDir: testUserDataDir,
      profileDirectory: 'Profile 1',
      fullPath: path.join(testUserDataDir, 'Profile 1'),
      cdpPort: 9333
    },
    navigationTimeoutMs: 15000,
    actionTimeoutMs: 10000,
    flowName: 'proxy-switch-demo',
    screenshotOnError: false,
    initialConnectionMode: 'direct',
    proxyCheckUrl: `http://127.0.0.1:${WEB_PORT}/`,
    proxy: {
      enabled: false,
      server: `http://127.0.0.1:${PROXY_PORT}`,
      bypass: '<local>'
    }
  };

  const logger = new Logger('test_proxy_run', projectRoot);

  try {
    // ==========================================
    // Test 1: Khởi tạo chế độ Direct và kiểm tra getConnectionMode
    // ==========================================
    console.log('1. Khởi tạo chế độ ban đầu:');
    const manager = new BrowserManager(testConfig, undefined, logger);
    assert.strictEqual(manager.getConnectionMode(), 'direct');
    assert.strictEqual(getConnectionMode(manager), 'direct');
    console.log('  ✔ Chế độ ban đầu xác định chính xác là "direct".');

    // ==========================================
    // Test 2: Yêu cầu lại cùng chế độ không restart Chrome
    // ==========================================
    console.log('\n2. Kiểm tra yêu cầu lại cùng chế độ không restart:');
    {
      const session1 = await manager.initSession();
      assert.ok(session1.context, 'Session phải có context');
      assert.ok(session1.page, 'Session phải có page');

      const pageBefore = manager.getCurrentPage();
      const sessionSame = await manager.switchConnectionMode('direct');

      assert.strictEqual(sessionSame, session1, 'Không được tạo session mới khi chế độ không đổi');
      assert.strictEqual(manager.getCurrentPage(), pageBefore, 'Page không bị thay đổi');
      console.log('  ✔ Yêu cầu lại cùng chế độ "direct" không khởi động lại Chrome và giữ nguyên session.');
    }

    // ==========================================
    // Test 3: Proxy thiếu cấu hình (không có server)
    // ==========================================
    console.log('\n3. Kiểm tra Proxy thiếu cấu hình:');
    {
      const badConfig: AppConfig = {
        ...testConfig,
        proxy: {
          enabled: false,
          server: ''
        }
      };
      const badManager = new BrowserManager(badConfig, manager.getSession()!, logger);

      let threw = false;
      try {
        await badManager.switchConnectionMode('proxy');
      } catch (err) {
        threw = true;
        const msg = (err as Error).message;
        assert.ok(msg.includes('proxy.server'), 'Thông báo phải nêu rõ thiếu proxy.server');
        assert.ok(msg.includes('Phiên trình duyệt hiện tại được giữ nguyên'), 'Phải cam kết giữ nguyên phiên hiện tại');
      }
      assert.strictEqual(threw, true, 'Phải ném lỗi khi thiếu proxy.server');
      assert.strictEqual(manager.getCurrentPage().isClosed(), false, 'Page cũ không được phép bị đóng');
      console.log('  ✔ Từ chối chuyển sang proxy khi thiếu server và giữ nguyên phiên Chrome hiện tại.');
    }

    // ==========================================
    // Test 4: Chuyển direct → proxy thực tế
    // ==========================================
    console.log('\n4. Kiểm tra chuyển direct → proxy (thực tế qua local proxy):');
    {
      const oldPage = manager.getCurrentPage();

      // Thực hiện chuyển sang proxy
      await enableProxy(manager, {
        checkUrl: `http://127.0.0.1:${WEB_PORT}/`
      });

      assert.strictEqual(manager.getConnectionMode(), 'proxy');
      assert.strictEqual(getConnectionMode(manager), 'proxy');

      // Test 4.1: Page cũ phải bị vô hiệu hóa (isClosed)
      assert.strictEqual(oldPage.isClosed(), true, 'Page của phiên cũ phải bị đóng');

      // Test 4.2: Page mới từ BrowserManager phải hoạt động
      const newPage = manager.getCurrentPage();
      assert.notStrictEqual(newPage, oldPage, 'Page mới phải khác Page cũ');
      assert.strictEqual(newPage.isClosed(), false, 'Page mới phải đang mở');

      console.log('  ✔ Chuyển từ direct sang proxy thành công thực tế.');
      console.log('  ✔ Page cũ đã bị vô hiệu hóa hoàn toàn sau restart.');
    }

    // ==========================================
    // Test 5: Yêu cầu lại cùng chế độ proxy không restart
    // ==========================================
    console.log('\n5. Kiểm tra yêu cầu lại cùng chế độ proxy:');
    {
      const pageBefore = manager.getCurrentPage();
      await manager.switchConnectionMode('proxy');
      assert.strictEqual(manager.getCurrentPage(), pageBefore, 'Page không bị thay đổi khi yêu cầu cùng chế độ proxy');
      assert.strictEqual(manager.getConnectionMode(), 'proxy');
      console.log('  ✔ Yêu cầu lại cùng chế độ proxy không khởi động lại Chrome.');
    }

    // ==========================================
    // Test 6: Chuyển proxy → direct thực tế
    // ==========================================
    console.log('\n6. Kiểm tra chuyển proxy → direct (thực tế):');
    {
      const proxyPage = manager.getCurrentPage();

      await disableProxy(manager, {
        checkUrl: `http://127.0.0.1:${WEB_PORT}/`
      });

      assert.strictEqual(manager.getConnectionMode(), 'direct');
      assert.strictEqual(proxyPage.isClosed(), true, 'Page ở phiên proxy phải bị đóng');

      const directPage = manager.getCurrentPage();
      assert.notStrictEqual(directPage, proxyPage, 'Page mới phải khác Page proxy');
      assert.strictEqual(directPage.isClosed(), false, 'Page direct mới phải đang mở');

      console.log('  ✔ Chuyển từ proxy về direct thành công thực tế.');
    }

    // ==========================================
    // Test 7: Tạo tab mới với tên rõ ràng qua newPage()
    // ==========================================
    console.log('\n7. Kiểm tra tạo tab mới (newPage) cho giai đoạn mới:');
    {
      const customTab = await manager.newPage('Tab-StageB-Proxy');
      assert.ok(customTab);
      assert.strictEqual(customTab.isClosed(), false);
      assert.strictEqual(manager.getCurrentPage(), customTab, 'getCurrentPage phải trả về tab mới vừa tạo');
      console.log('  ✔ Tạo tab mới với tên rõ ràng [Tab-StageB-Proxy] thành công.');
    }

    // ==========================================
    // Test 8: Proxy không kết nối được (server chết): dừng ngay, không fallback
    // ==========================================
    console.log('\n8. Kiểm tra proxy chết: dừng ngay, tuyệt đối không tự fallback sang direct:');
    {
      const deadProxyConfig: AppConfig = {
        ...testConfig,
        proxy: {
          enabled: false,
          server: `http://127.0.0.1:${DEAD_PROXY_PORT}`
        }
      };
      const deadManager = new BrowserManager(deadProxyConfig, manager.getSession()!, logger);

      let threw = false;
      try {
        await deadManager.switchConnectionMode('proxy', {
          timeoutMs: 3000
        });
      } catch (err) {
        threw = true;
        const msg = (err as Error).message;
        assert.ok(msg.includes('KHÔNG tự động fallback'), 'Thông báo phải cam kết không tự fallback');
        assert.ok(
          msg.includes('[LỖI KẾT NỐI]') || msg.includes('[LỖI CHUYỂN CHẾ ĐỘ]'),
          'Phải báo lỗi kết nối hoặc chuyển chế độ'
        );
      }
      assert.strictEqual(threw, true, 'Phải ném lỗi khi proxy chết');
      assert.notStrictEqual(
        deadManager.getConnectionMode(),
        'proxy',
        'Không được đánh dấu chế độ proxy đã sẵn sàng khi kết nối lỗi'
      );
      console.log('  ✔ Proxy chết ném lỗi dừng ngay lập tức, không tự fallback sang direct, không đánh dấu proxy sẵn sàng.');
    }

    // Đóng manager hiện tại để giải phóng profile cho test luồng
    await manager.close();

    // ==========================================
    // Test 9: Kiểm tra Profile đang được sử dụng (handleLaunchError)
    // ==========================================
    console.log('\n9. Kiểm tra xử lý lỗi Profile đang bị chiếm dụng:');
    {
      const rawLockError = new Error('ProcessSingleton: profile is already in use by another Chrome process');
      const friendlyErr = handleLaunchError(rawLockError, testConfig);
      assert.ok(friendlyErr.message.includes('[LỖI PROFILE]'));
      assert.ok(friendlyErr.message.includes('userDataDir'));
      assert.ok(friendlyErr.message.includes('tuyệt đối không tự động kill'));
      console.log('  ✔ Báo lỗi thân thiện và an toàn khi profile bị khóa bởi tiến trình khác.');
    }

    // ==========================================
    // Test 10: Thực thi toàn bộ Luồng Demo (proxy-switch-demo)
    // ==========================================
    console.log('\n10. Kiểm tra thực thi Luồng proxy-switch-demo với Sequential Runner:');
    {
      const demoManager = new BrowserManager(testConfig, undefined, logger);
      const initialSession = await demoManager.initSession();

      const flowCtx: FlowContext = {
        page: initialSession.page,
        config: testConfig,
        runId: 'test_demo_flow_run',
        logger,
        browserManager: demoManager
      };

      const result = await runFlow(proxySwitchDemoFlow, flowCtx, projectRoot);

      assert.strictEqual(result.status, 'success', 'Luồng demo phải hoàn thành thành công');
      assert.strictEqual(result.completedSteps.length, 8, 'Phải hoàn thành đủ 8 bước');
      assert.deepStrictEqual(result.completedSteps, [
        'ensure-direct-mode',
        'stage-a-open-check-url',
        'stage-a-verify',
        'switch-to-proxy',
        'stage-b-open-check-url',
        'stage-b-verify',
        'switch-to-direct',
        'verify-direct-restored'
      ]);

      assert.strictEqual(demoManager.getConnectionMode(), 'direct', 'Chế độ cuối cùng phải là direct');

      await demoManager.close();
      console.log('  ✔ Toàn bộ 8 bước của luồng proxy-switch-demo đã chạy và kiểm tra thực tế thành công 100%.');
    }

    // ==========================================
    // Test 11: Kiểm tra dừng an toàn khi nhận tín hiệu hủy (Ctrl+C / CancellationToken)
    // ==========================================
    console.log('\n11. Kiểm tra hủy luồng giữa chừng (CancellationToken / Ctrl+C):');
    {
      const abortCtrl = new AbortController();
      abortCtrl.abort(); // Giả lập nhận Ctrl+C ngay trước bước chạy

      const cancelFlowCtx: FlowContext = {
        page: null as any,
        config: testConfig,
        runId: 'test_cancel_flow_run',
        logger,
        cancellationToken: abortCtrl.signal
      };

      const cancelResult = await runFlow(proxySwitchDemoFlow, cancelFlowCtx, projectRoot);
      assert.strictEqual(cancelResult.status, 'cancelled');
      assert.strictEqual(cancelResult.completedSteps.length, 0);
      console.log('  ✔ Dừng an toàn và trả về trạng thái "cancelled" khi nhận tín hiệu hủy.');
    }

  } finally {
    // Dọn dẹp máy chủ test
    await new Promise((r) => webServer.close(r));
    await new Promise((r) => proxyServer.close(r));
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA CHUYỂN PROXY ĐÃ VƯỢT QUA THÀNH CÔNG! ---');
}

runProxyTests().catch((err) => {
  console.error('\n❌ KIỂM TRA THẤT BẠI:', err);
  process.exit(1);
});
