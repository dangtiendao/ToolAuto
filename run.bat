@echo off
setlocal
chcp 65001 >nul

:: 1. Chuyen dung thu muc du an (ho tro duong dan co dau cach)
cd /d "%~dp0"

:: 2. Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 goto :NO_NODE

:: 3. Kiem tra dependencies (node_modules)
if not exist "node_modules\" goto :NO_MODULES

:: 4. Kiem tra config/config.json
if not exist "config\config.json" (
    echo [CANH BAO] Chua tim thay config\config.json.
    echo Vui long sao chep tu config\config.example.json truoc khi chay.
    echo.
)

:: 5. Bien dich TypeScript sang JavaScript
echo [1/2] Dang bien dich ma nguon TypeScript (npm run build)...
call npm run build
if %errorlevel% neq 0 goto :BUILD_ERROR

:: 6. Chay ung dung da bien dich
echo.
echo [2/2] Dang khoi chay chuong trinh (npm start)...
echo.
call npm start
set APP_CODE=%errorlevel%
if %APP_CODE% neq 0 goto :APP_ERROR

exit /b 0

:NO_NODE
echo.
echo ==============================================================
echo [LOI] Khong tim thay Node.js tren may tinh!
echo Vui long cai dat Node.js LTS tu https://nodejs.org/
echo ==============================================================
echo.
pause
exit /b 1

:NO_MODULES
echo.
echo ==============================================================
echo [LOI] Chua cai dat dependencies (thieu thu muc node_modules).
echo Vui long mo PowerShell tai thu muc nay va chay lenh: npm install
echo ==============================================================
echo.
pause
exit /b 1

:BUILD_ERROR
echo.
echo ==============================================================
echo [LOI] Bien dich TypeScript that bai!
echo ==============================================================
echo.
pause
exit /b 1

:APP_ERROR
echo.
echo ==============================================================
echo [THONG BAO] Chuong trinh ket thuc voi ma loi: %APP_CODE%
echo ==============================================================
echo.
pause
exit /b %APP_CODE%
