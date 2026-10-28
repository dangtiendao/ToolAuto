# Chrome Automation Tool (Windows)

Công cụ tự động hóa Google Chrome trên Windows sử dụng Node.js LTS, TypeScript và Playwright.

---

## 1. Cài đặt lần đầu

Yêu cầu: Đã cài đặt **Google Chrome** tại `C:\Program Files\Google\Chrome\Application\chrome.exe` và **Node.js LTS** (phiên bản 18+ hoặc 20+).

Mở PowerShell tại thư mục dự án và chạy:
```powershell
npm install
```

---

## 2. Cấu hình chọn Profile Chrome thực tế

File cấu hình chính: `config/config.json`.

```json
{
  "startUrl": "https://example.com",
  "browser": {
    "profileName": "Profile 1",
    "cdpPort": 9222,
    "profiles": {
      "Profile 1": {
        "profileDirectory": "Profile 1"
      },
      "Default": {
        "profileDirectory": "Default"
      },
      "Profile 2": {
        "profileDirectory": "Profile 2"
      }
    }
  },
  "navigationTimeoutMs": 30000,
  "actionTimeoutMs": 15000,
  "flowName": "yopmail-muse",
  "screenshotOnError": true,
  "proxy": {
    "enabled": false,
    "server": "",
    "bypass": ""
  }
}
```

### Các thông số quan trọng:
- **`profileName`**: Tên profile bạn muốn tool sử dụng (ví dụ: `"Profile 1"`, `"Default"`, `"Profile 2"`...).
- **`profiles`**: Danh sách khai báo các Profile trong Chrome của bạn. Mỗi profile chỉ cần chỉ định `"profileDirectory"` tương ứng với thư mục profile trong Chrome (ví dụ: `"Profile 1"`).
- **Thư mục dữ liệu Chrome (`userDataDir`)**: Mặc định hệ thống tự động nhận diện thư mục dữ liệu Chrome của máy bạn tại:
  `%LOCALAPPDATA%\Google\Chrome\User Data`
  *(Bạn không cần khai báo lại đường dẫn này nếu dùng Chrome cá nhân thông thường).*
- **`cdpPort`**: Cổng kết nối Chrome DevTools Protocol (mặc định: `9222`).

---

## 3. Cách thức hoạt động với Google Chrome thật

Hệ thống kết nối trực tiếp vào Google Chrome thông qua giao thức **Remote Debugging Port (CDP)**:

1. **Khởi chạy tự động:**
   - Khi bạn chạy tool (`run.bat` hoặc `npm start`), tool sẽ tự động khởi chạy Chrome từ:
     `C:\Program Files\Google\Chrome\Application\chrome.exe`
     kèm cờ `--remote-debugging-port=9222` và mở đúng Profile bạn đã chọn (ví dụ: `Profile 1`).
   - Mọi tài khoản, cookie, lịch sử và extension trong Profile đó đều được giữ nguyên 100%.

2. **Nếu Chrome đang mở sẵn trên máy:**
   - Nếu Chrome đã được mở sẵn kèm cổng 9222, tool sẽ kết nối trực tiếp vào cửa sổ Chrome đó mà **không cần đóng các tab bạn đang làm việc**.
   - Nếu Chrome đang mở bình thường (chưa bật cổng 9222), bạn có 2 cách:
     - **Cách 1 (Nhanh nhất):** Đóng tất cả cửa sổ Chrome lại, sau đó chạy `npm start` (hoặc click `run.bat`). Tool sẽ tự mở Chrome kèm cổng 9222 và profile đã chọn.
     - **Cách 2:** Khởi động Chrome bằng phím tắt / Command Prompt kèm cờ:
       ```cmd
       "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --profile-directory="Profile 1"
       ```
       *(Sau khi mở bằng lệnh này, bạn có thể chạy tool bất cứ lúc nào mà không cần khởi động lại Chrome).*

---

## 4. Cách chạy chương trình

### Cách 1: Khởi chạy nhanh bằng `run.bat`
Nhấp đúp chuột vào file **`run.bat`** tại thư mục gốc dự án.

### Cách 2: Khởi chạy bằng PowerShell / Terminal
```powershell
# Chạy trực tiếp qua tsx:
npm run dev

# Hoặc biên dịch rồi chạy:
npm run build
npm start

# Chạy kiểm thử tự động toàn diện:
npm test
```

---

## 5. Các luồng nghiệp vụ có sẵn

1. **`demo`**: Mở trang `startUrl`, kiểm tra DOM, ghi nhận tiêu đề và URL.
2. **`yopmail-muse`**: Luồng tuần tự tự động hóa trên 2 tab (TabA mở YOPmail tạo hộp thư ngẫu nhiên 10-14 ký tự, TabB mở Muse.ai gửi email, TabA lấy OTP, TabB nhập OTP và xác nhận).
