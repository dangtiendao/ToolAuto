# Chrome Automation Tool (Windows)

Công cụ tự động hóa Google Chrome trên Windows sử dụng Node.js LTS, TypeScript và Playwright.

---

## 1. Cài đặt lần đầu

Yêu cầu: Đã cài đặt **Google Chrome** và **Node.js LTS** (phiên bản 18+ hoặc 20+).

Mở PowerShell tại thư mục dự án và chạy:
```powershell
npm install
```

---

## 2. Tạo cấu hình (Config)

Tạo file cấu hình chính từ file mẫu:
```powershell
Copy-Item config/config.example.json config/config.json
```

Các thông số chính trong `config/config.json`:
- `startUrl`: URL mở ban đầu (chỉ chấp nhận `http` hoặc `https`). Mặc định: `https://example.com`.
- `profileDir`: Thư mục profile riêng (mặc định: `profiles/default`, tự động tạo nếu chưa có).
- `navigationTimeoutMs`: Thời gian chờ tải trang (mili-giây, số nguyên dương). Mặc định: `30000`.
- `actionTimeoutMs`: Thời gian chờ thao tác phần tử (mili-giây, số nguyên dương). Mặc định: `15000`.
- `flowName`: Tên luồng cần chạy (ví dụ: `demo`).
- `screenshotOnError`: Chụp ảnh màn hình khi có lỗi (`true`/`false`). Mặc định: `true`.

---

## 3. Bật / Tắt Proxy

Trong `config/config.json`:
- **Tắt proxy (Mặc định)**:
  ```json
  "proxy": {
    "enabled": false
  }
  ```
- **Bật proxy**:
  ```json
  "proxy": {
    "enabled": true,
    "server": "http://dia-chi-proxy:port",
    "bypass": "localhost;*.internal"
  }
  ```
  *(Chỉ hỗ trợ giao thức: `http://`, `https://`, `socks5://`. Không hỗ trợ `socks4://`).*

- **Cấu hình tài khoản proxy (Tùy chọn)**:
  Tạo file `.env` từ mẫu:
  ```powershell
  Copy-Item .env.example .env
  ```
  Điền thông tin xác thực vào `.env` (tuyệt đối không điền vào `config.json`):
  ```env
  PROXY_USERNAME=tai_khoan
  PROXY_PASSWORD=mat_khau
  ```
  > **Cam kết an toàn**: Nếu proxy lỗi kết nối, hệ thống sẽ báo lỗi và dừng, **tuyệt đối không tự ý chuyển sang kết nối trực tiếp**.

---

## 4. Cách chạy chương trình

### Cách 1: Khởi chạy nhanh bằng `run.bat`
Nhấp đúp chuột vào file **`run.bat`** tại thư mục gốc dự án, hoặc chạy trong Command Prompt/PowerShell:
```cmd
run.bat
```
- Tự động kiểm tra Node.js và `node_modules`.
- Tự động biên dịch TypeScript (`npm run build`) và khởi chạy (`npm start`).
- Giữ cửa sổ khi gặp lỗi để dễ đọc thông báo.

### Cách 2: Khởi chạy bằng Terminal (PowerShell)
```powershell
# Chạy trực tiếp qua TypeScript (Development):
npm run dev

# Hoặc biên dịch rồi chạy:
npm run build
npm start

# Chạy toàn bộ các bài kiểm tra tự động (Test):
npm test
```

### Cách dừng chương trình
- Sau khi luồng hoàn thành: Nhấn phím **Enter** trên terminal để đóng Chrome an toàn.
- Dừng khẩn cấp khi đang chạy: Nhấn **Ctrl+C** (hệ thống sẽ hủy luồng, đóng Chrome, lưu kết quả `cancelled`, và thoát với mã `130`).

---

## 5. Xem kết quả và nhật ký

- **Nhật ký chạy**: Lưu tại `logs/<runId>.log` (ghi nhận timestamp, mức INFO/WARN/ERROR, tên luồng, tên bước và kết quả từng bước).
- **Kết quả có cấu trúc**: Lưu tại `logs/<runId>.result.json` (`status: "success" | "failed" | "cancelled"`, thời gian, danh sách bước hoàn thành, thông tin lỗi).
- **Ảnh chụp khi lỗi**: Lưu tại `screenshots/<runId>/error_<stepId>_<timestamp>.png` (Lưu ý: Ảnh chụp màn hình có thể chứa dữ liệu nhạy cảm hiển thị trên trang).

---

## 6. Thêm luồng tự động hóa mới

1. **Tạo file luồng**: Trong thư mục `src/flows/`, tạo file ví dụ `src/flows/my-flow.flow.ts`:
   ```typescript
   import { Flow } from '../runner/types';

   export const myFlow: Flow = {
     name: 'my-flow',
     description: 'Mô tả luồng của bạn',
     steps: [
       {
         id: 'step-1',
         name: 'Mô tả bước 1',
         execute: async (context) => {
           // Thao tác với context.page
         },
         verify: async (context) => true // Điều kiện xác nhận (tùy chọn)
       }
     ]
   };
   ```
2. **Đăng ký vào Registry**: Trong `src/flows/index.ts`, thêm:
   ```typescript
   import { myFlow } from './my-flow.flow';
   registerFlow(myFlow);
   ```
3. **Cấu hình để chạy**: Trong `config/config.json`, đổi `"flowName": "my-flow"`.

---

## Cấu trúc thư mục

```text
├── config/             # Cấu hình mẫu và cấu hình thực tế
├── logs/               # File nhật ký .log và kết quả .result.json (được git bỏ qua)
├── screenshots/        # Ảnh chụp khi gặp lỗi (được git bỏ qua)
├── profiles/           # Profile riêng của Chrome (được git bỏ qua)
├── src/
│   ├── browser/        # Quản lý Chrome, cấu hình proxy, đóng context an toàn
│   ├── config/         # Đọc, kiểm tra tính hợp lệ và chuẩn hóa cấu hình
│   ├── flows/          # Các kịch bản tự động hóa và Flow Registry
│   ├── runner/         # Bộ điều phối thực thi tuần tự các bước
│   ├── utils/          # Logger, Run ID, lọc thông tin nhạy cảm (Sanitizer)
│   └── index.ts        # Điểm khởi chạy chính của ứng dụng
├── tests/              # Bộ kiểm tra tự động toàn diện
├── .env.example        # Mẫu biến môi trường xác thực proxy
├── .gitignore          # Cấu hình bỏ qua tệp nhạy cảm và dữ liệu chạy
├── package.json        # Dependencies và scripts
├── run.bat             # File khởi chạy nhanh trên Windows
├── tsconfig.json       # Cấu hình TypeScript compiler
└── README.md           # Hướng dẫn sử dụng
```
