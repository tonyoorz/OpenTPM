@echo off
REM ============================================================
REM  LibreChat 一键启动脚本
REM  启动顺序: MongoDB -> session_keeper -> LibreChat 后端
REM  前端开发用 http://localhost:3080 即可 (后端 serve 构建好的前端)
REM ============================================================

title LibreChat Launcher

echo ============================================
echo   LibreChat 一键启动
echo ============================================
echo.

REM --- 1. 检查 MongoDB，没跑就启动 ---
echo [1/3] 检查 MongoDB...
tasklist /FI "IMAGENAME eq mongod.exe" 2>nul | find /I "mongod.exe" >nul
if %ERRORLEVEL% neq 0 (
    echo       MongoDB 未运行，正在启动...
    start "MongoDB" /MIN "" "C:\Users\q446328\Desktop\mongodb\mongodb-win32-x86_64-windows-7.0.20\bin\mongod.exe" --dbpath "C:\Users\q446328\Desktop\mongodb\data"
    timeout /t 3 /nobreak >nul
    echo       MongoDB 已启动
) else (
    echo       MongoDB 已在运行
)
echo.

REM --- 2. 检查 session_keeper，没跑就启动 ---
echo [2/3] 检查 session_keeper (BMW SSO)...
netstat -ano | find ":8090" | find "LISTENING" >nul
if %ERRORLEVEL% neq 0 (
    echo       session_keeper 未运行，正在启动...
    start "session_keeper" /MIN cmd /c "cd /d C:\Users\q446328\Desktop\BmwLogin && python -m session_keeper"
    timeout /t 3 /nobreak >nul
    echo       session_keeper 已启动 (端口 8090)
) else (
    echo       session_keeper 已在运行
)
echo.

REM --- 3. 启动 LibreChat 后端 ---
echo [3/3] 启动 LibreChat 后端...
echo.
echo   访问地址: http://localhost:3080
echo   内网地址: http://10.165.22.10:3080
echo.
echo   按 Ctrl+C 停止 LibreChat 后端
echo   (MongoDB 和 session_keeper 在后台继续运行)
echo.

cd /d C:\Users\q446328\Desktop\LibreChat
npx cross-env NODE_ENV=development npx nodemon api/server/index.js
