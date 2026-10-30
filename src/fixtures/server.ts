import * as http from 'http';
import { AddressInfo } from 'net';

export interface FixtureServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Khởi chạy máy chủ HTTP fixture cục bộ phục vụ kiểm thử song song các worker.
 * Hỗ trợ các trang demo:
 * - / (trang chủ)
 * - /page-a (Tab A: hiển thị và ghi nhận cookie)
 * - /page-b (Tab B: form nhập liệu tuần tự)
 * - /page-c (Tab C: kiểm tra cookie chia sẻ)
 * - /set-cookie?name=...&val=... (thiết lập cookie qua HTTP header)
 * - /api/cookies (trả về danh sách cookie nhận được)
 */
export async function startFixtureServer(preferredPort: number = 0): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    // Header CORS và không cache để tránh ảnh hưởng kiểm thử
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    if (pathname === '/set-cookie') {
      const name = parsedUrl.searchParams.get('name') || 'worker_marker';
      const val = parsedUrl.searchParams.get('val') || '';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `${name}=${val}; Path=/; SameSite=Lax`
      });
      res.end(`<!DOCTYPE html><html><body><h1>Cookie Set</h1><p>${name}=${val}</p></body></html>`);
      return;
    }

    if (pathname === '/api/cookies') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
      return;
    }

    // Các trang HTML demo
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Fixture Demo: ${pathname}</title>
</head>
<body>
  <h1>Fixture Test Page: <span id="path-name">${pathname}</span></h1>
  <div id="cookies-display">Cookies: <span id="cookies-val"></span></div>
  
  <div id="form-container" style="margin-top: 15px;">
    <label for="demo-input">Dữ liệu kiểm thử:</label>
    <input id="demo-input" type="text" placeholder="Nhập giá trị..." />
    <button id="demo-submit" type="button">Xác nhận</button>
  </div>
  
  <div id="status" style="margin-top: 15px; font-weight: bold;">Sẵn sàng</div>
  <div id="manual-checkpoint" style="margin-top: 15px;">Điểm chờ thủ công (chờ resume)</div>

  <script>
    document.getElementById('cookies-val').textContent = document.cookie;
    document.getElementById('demo-submit').addEventListener('click', function() {
      var val = document.getElementById('demo-input').value;
      document.getElementById('status').textContent = 'Đã cập nhật: ' + val;
    });
  </script>
</body>
</html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(preferredPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}
