import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildProxyScrapeUrl,
  getDownloadsDataProxyPath,
  fetchProxiesFromApi,
  findWorkingProxy,
  testProxyConnection,
  ScrapedProxyItem,
  DEFAULT_PROXYSCRAPE_BASE_URL
} from '../src/browser/proxy-provider';
import * as net from 'net';
import { ProxyConfig } from '../src/config/types';

console.log('--- BẮT ĐẦU KIỂM TRA MODULE PROXY NÂNG CAO (API PROXYSCRAPE HOÀN TOÀN IN-MEMORY) ---');

function createMockLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    info: (msg: string) => logs.push({ level: 'info', msg }),
    warn: (msg: string) => logs.push({ level: 'warn', msg }),
    error: (msg: string) => logs.push({ level: 'error', msg })
  };
}

async function runTests() {
  // Test 1: Kiểm tra buildProxyScrapeUrl
  console.log('\n1. Kiểm tra buildProxyScrapeUrl với mã nước {country}:');
  {
    const sgUrl = buildProxyScrapeUrl('sg');
    assert.ok(sgUrl.includes('country=sg%2Cus'), 'URL phải chứa country=sg%2Cus');
    assert.ok(sgUrl.includes('timeout='), 'URL phải chứa tham số timeout');
    assert.ok(sgUrl.includes('protocol=http,socks4,socks5'), 'URL phải kéo đồng thời cả 3 giao thức: http, socks4, socks5');

    const usUrl = buildProxyScrapeUrl('us');
    assert.ok(usUrl.includes('country=us%2Cus'), 'URL phải chứa country=us%2Cus');
    console.log('  ✔ Xây dựng URL API với mã nước chính xác.');
  }

  // Test 2: Đảm bảo tuyệt đối không tạo/ghi file Downloads\data_proxy.txt
  console.log('\n2. Kiểm tra cam kết không lưu trữ file (Zero Disk Footprint, bỏ qua data_proxy.txt):');
  {
    const downloadPath = getDownloadsDataProxyPath();
    // Đảm bảo file trong Downloads không tồn tại
    if (fs.existsSync(downloadPath)) {
      fs.unlinkSync(downloadPath);
    }

    const mockRawJson = JSON.stringify({
      shown_records: 1,
      total_records: 1,
      proxies: [
        {
          alive: true,
          ip: '111.222.333.1',
          port: 8080,
          protocol: 'http',
          proxy: 'http://111.222.333.1:8080',
          uptime: 99.5,
          ip_data: { countryCode: 'SG', country: 'Singapore' }
        }
      ]
    });

    const logger = createMockLogger();
    const proxies = await fetchProxiesFromApi('sg', {
      mockRawJson,
      logger
    });

    assert.strictEqual(proxies.length, 1);
    assert.strictEqual(
      fs.existsSync(downloadPath),
      false,
      'Tuyệt đối không được tạo hoặc lưu file vào Downloads\\data_proxy.txt'
    );
    console.log('  ✔ Toàn bộ dữ liệu xử lý trực tiếp trong RAM, không lưu trữ bất kỳ file nào ra đĩa.');
  }

  // Test 3: Kiểm tra parse payload trực tiếp trong bộ nhớ (In-Memory)
  console.log('\n3. Kiểm tra parse payload trực tiếp từ bộ nhớ (In-Memory JSON parsing):');
  {
    const mockData = {
      shown_records: 2,
      total_records: 2,
      proxies: [
        {
          alive: true,
          ip: '111.222.333.1',
          port: 8080,
          protocol: 'http',
          proxy: 'http://111.222.333.1:8080',
          uptime: 99.5,
          ip_data: { countryCode: 'SG', country: 'Singapore' }
        },
        {
          alive: true,
          ip: '111.222.333.2',
          port: 3128,
          protocol: 'http',
          proxy: 'http://111.222.333.2:3128',
          uptime: 95.0,
          ip_data: { countryCode: 'US', country: 'United States' }
        }
      ]
    };

    const logger = createMockLogger();
    const proxies = await fetchProxiesFromApi('sg', {
      mockRawJson: JSON.stringify(mockData),
      logger
    });

    assert.strictEqual(proxies.length, 2, 'Phải nạp được 2 proxy từ RAM.');
    assert.strictEqual(proxies[0].ip, '111.222.333.1');
    assert.strictEqual(proxies[0].ip_data?.countryCode, 'SG');
    assert.strictEqual(proxies[1].ip, '111.222.333.2');
    assert.strictEqual(proxies[1].ip_data?.countryCode, 'US');
    console.log('  ✔ Đọc và parse dữ liệu proxy trực tiếp từ bộ nhớ thành công 100%.');
  }

  // Test 4: Kiểm tra cơ chế duyệt tuần tự từng proxy trong bộ nhớ (proxy 1 lỗi -> thử proxy 2 -> fallback)
  console.log('\n4. Kiểm tra cơ chế duyệt proxy: proxy 1 lỗi -> thử proxy 2 -> chọn proxy thành công:');
  {
    const mockList = {
      shown_records: 2,
      total_records: 2,
      proxies: [
        {
          alive: true,
          ip: '192.0.2.1', // TEST-NET-1 (luôn timeout)
          port: 80,
          protocol: 'http',
          proxy: 'http://192.0.2.1:80',
          uptime: 98,
          ip_data: { countryCode: 'SG' }
        },
        {
          alive: true,
          ip: '192.0.2.2', // TEST-NET-1 (luôn timeout)
          port: 8080,
          protocol: 'http',
          proxy: 'http://192.0.2.2:8080',
          uptime: 95,
          ip_data: { countryCode: 'SG' }
        }
      ]
    };

    const fallback: ProxyConfig = {
      enabled: true,
      server: 'http://103.82.194.227:17833',
      username: 'z53l',
      password: 'z53l'
    };

    const logger = createMockLogger();
    const result = await findWorkingProxy('sg', {
      mockRawJson: JSON.stringify(mockList),
      testTimeoutMs: 100, // timeout siêu nhanh cho test
      fallbackProxy: fallback,
      logger
    });

    assert.strictEqual(result.testedCount, 2, 'Phải test lần lượt cả 2 proxy.');
    assert.strictEqual(result.source, 'fallback_config', 'Phải chuyển sang fallback khi cả 2 free proxy lỗi.');
    assert.strictEqual(result.proxyConfig.server, 'http://103.82.194.227:17833');

    const warnLogs = logger.logs.filter((l) => l.level === 'warn');
    assert.ok(warnLogs.some((l) => l.msg.includes('Đang thử với proxy tiếp theo')));
    assert.ok(warnLogs.some((l) => l.msg.includes('FALLBACK PROXY DỰ PHÒNG')));
    console.log('  ✔ Duyệt tuần tự qua các proxy lỗi và chuyển fallback an toàn khi tất cả đều không phản hồi.');
  }

  // Test 5: Kiểm tra ưu tiên lọc đúng mã quốc gia (SG / US) và sắp xếp uptime trong bộ nhớ
  console.log('\n5. Kiểm tra ưu tiên lọc theo mã quốc gia chỉ định:');
  {
    const mixedData = {
      shown_records: 4,
      total_records: 4,
      proxies: [
        { ip: '1.1.1.1', port: 80, protocol: 'http', proxy: 'http://1.1.1.1:80', uptime: 90, ip_data: { countryCode: 'US' } },
        { ip: '2.2.2.2', port: 80, protocol: 'http', proxy: 'http://2.2.2.2:80', uptime: 95, ip_data: { countryCode: 'SG' } },
        { ip: '3.3.3.3', port: 80, protocol: 'http', proxy: 'http://3.3.3.3:80', uptime: 99, ip_data: { countryCode: 'SG' } },
        { ip: '4.4.4.4', port: 80, protocol: 'http', proxy: 'http://4.4.4.4:80', uptime: 80, ip_data: { countryCode: 'FR' } }
      ]
    };

    const logger = createMockLogger();
    const fallback: ProxyConfig = { enabled: true, server: 'http://127.0.0.1:8888' };

    await findWorkingProxy('sg', {
      mockRawJson: JSON.stringify(mixedData),
      testTimeoutMs: 50,
      fallbackProxy: fallback,
      randomize: false,
      logger
    });

    // Proxy đầu tiên được test phải là proxy SG có uptime cao nhất (3.3.3.3 uptime 99%), sau đó đến 2.2.2.2 (uptime 95%)
    const testLogs = logger.logs.filter((l) => l.msg.includes('Đang test'));
    assert.ok(testLogs[0].msg.includes('3.3.3.3'), 'Proxy test đầu tiên phải là 3.3.3.3 (SG, uptime 99%).');
    assert.ok(testLogs[1].msg.includes('2.2.2.2'), 'Proxy test thứ hai phải là 2.2.2.2 (SG, uptime 95%).');
    console.log('  ✔ Sắp xếp và ưu tiên chính xác theo quốc gia chỉ định (SG) và chỉ số uptime khi randomize=false.');
  }

  // Test 6: Kiểm tra cơ chế bốc ngẫu nhiên số thứ tự trong tổng kết quả (không quét lần lượt từ trên xuống)
  console.log('\n6. Kiểm tra cơ chế bốc ngẫu nhiên số thứ tự trong tổng kết quả (không quét lần lượt từ trên xuống):');
  {
    const manyProxies = {
      shown_records: 10,
      total_records: 10,
      proxies: Array.from({ length: 10 }, (_, i) => ({
        ip: `10.0.0.${i + 1}`,
        port: 8080,
        protocol: 'http',
        proxy: `http://10.0.0.${i + 1}:8080`,
        uptime: 90 - i,
        ip_data: { countryCode: 'SG' }
      }))
    };

    const logger = createMockLogger();
    const fallback: ProxyConfig = { enabled: true, server: 'http://127.0.0.1:8888' };

    await findWorkingProxy('sg', {
      mockRawJson: JSON.stringify(manyProxies),
      testTimeoutMs: 20,
      fallbackProxy: fallback,
      logger
      // randomize mặc định là true
    });

    const randomTestLogs = logger.logs.filter((l) => l.msg.includes('Đang test ngẫu nhiên'));
    assert.ok(randomTestLogs.length > 0, 'Phải có log kiểm tra ngẫu nhiên.');
    assert.ok(logger.logs.some((l) => l.msg.includes('Bốc ngẫu nhiên số thứ tự trong tổng kết quả')));

    // Kiểm tra không có proxy nào bị test trùng lặp trong cùng một lần quét
    const testedIps = randomTestLogs.map((l) => {
      const match = l.msg.match(/10\.0\.0\.\d+/);
      return match ? match[0] : '';
    });
    const uniqueIps = new Set(testedIps);
    assert.strictEqual(testedIps.length, uniqueIps.size, 'Các vị trí ngẫu nhiên không được test trùng lặp.');
    console.log(`  ✔ Bốc ngẫu nhiên số thứ tự thành công (đã test ${testedIps.length} proxy độc lập, không trùng lặp, không quét lần lượt từ trên xuống).`);
  }

  // Test 7: Kiểm tra bắt tay (Handshake) proxy SOCKS5 qua TCP nhị phân
  console.log('\n7. Kiểm tra cơ chế test proxy SOCKS5 qua socket TCP (0x05, 0x00 handshake):');
  {
    const socks5Server = net.createServer((socket) => {
      socket.on('data', (data) => {
        if (data[0] === 0x05) {
          // Trả về SOCKS5 NO AUTH: VER=5, METHOD=0
          socket.write(Buffer.from([0x05, 0x00]));
        }
      });
    });

    await new Promise<void>((resolve) => socks5Server.listen(0, '127.0.0.1', () => resolve()));
    const port = (socks5Server.address() as net.AddressInfo).port;

    const check = await testProxyConnection('127.0.0.1', port, { protocol: 'socks5', timeoutMs: 1000 });
    assert.strictEqual(check.alive, true, 'Proxy SOCKS5 phải được nhận diện sống.');
    assert.ok(typeof check.latencyMs === 'number', 'Phải đo được độ trễ latencyMs.');

    socks5Server.close();
    console.log('  ✔ Kiểm tra kết nối SOCKS5 qua socket TCP thành công 100%.');
  }

  // Test 8: Kiểm tra bắt tay (Handshake) proxy SOCKS4 qua TCP nhị phân
  console.log('\n8. Kiểm tra cơ chế test proxy SOCKS4 qua socket TCP (0x00, 0x5a reply):');
  {
    const socks4Server = net.createServer((socket) => {
      socket.on('data', (data) => {
        if (data[0] === 0x04) {
          // Trả về SOCKS4 request granted: VN=0, CD=0x5A
          socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x50, 0x01, 0x01, 0x01, 0x01]));
        }
      });
    });

    await new Promise<void>((resolve) => socks4Server.listen(0, '127.0.0.1', () => resolve()));
    const port = (socks4Server.address() as net.AddressInfo).port;

    const check = await testProxyConnection('127.0.0.1', port, { protocol: 'socks4', timeoutMs: 1000 });
    assert.strictEqual(check.alive, true, 'Proxy SOCKS4 phải được nhận diện sống.');
    assert.ok(typeof check.latencyMs === 'number', 'Phải đo được độ trễ latencyMs.');

    socks4Server.close();
    console.log('  ✔ Kiểm tra kết nối SOCKS4 qua socket TCP thành công 100%.');
  }

  // Test 9: Kiểm tra findWorkingProxy nhận diện đúng scheme socks5:// và socks4:// khi trả về từ kết quả
  console.log('\n9. Kiểm tra findWorkingProxy tạo đúng scheme (socks5://, socks4://, http://):');
  {
    // Tạo 1 mock server SOCKS5 thật sự lắng nghe để findWorkingProxy có thể chọn
    const mockSocks5 = net.createServer((socket) => {
      socket.on('data', (data) => {
        if (data[0] === 0x05) {
          socket.write(Buffer.from([0x05, 0x00]));
        }
      });
    });

    await new Promise<void>((resolve) => mockSocks5.listen(0, '127.0.0.1', () => resolve()));
    const s5Port = (mockSocks5.address() as net.AddressInfo).port;

    const mixedProtocolProxies = {
      shown_records: 1,
      total_records: 1,
      proxies: [
        {
          ip: '127.0.0.1',
          port: s5Port,
          protocol: 'socks5',
          uptime: 99,
          ip_data: { countryCode: 'SG' }
        }
      ]
    };

    const logger = createMockLogger();
    const result = await findWorkingProxy('sg', {
      mockRawJson: JSON.stringify(mixedProtocolProxies),
      testTimeoutMs: 1000,
      logger
    });

    assert.strictEqual(result.proxyConfig.server, `socks5://127.0.0.1:${s5Port}`, 'Phải tạo đúng scheme socks5://');
    mockSocks5.close();
    console.log('  ✔ findWorkingProxy tự động nhận diện và gán đúng giao thức socks5://.');
  }

  console.log('\n=== TẤT CẢ BÀI KIỂM THỬ PROXY NÂNG CAO ĐÃ VƯỢT QUA 100%! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ BÀI KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
