@echo off
setlocal EnableExtensions
set "ROOT_DIR=%~dp0"
set "MONGOD_PATH=%MONGOD_PATH%"
set "MONGOD_DATA_PATH=%MONGOD_DATA_PATH%"

if not defined MONGOD_PATH set "MONGOD_PATH=%USERPROFILE%\Desktop\mongodb\mongodb-win32-x86_64-windows-7.0.20\bin\mongod.exe"
if not defined MONGOD_DATA_PATH set "MONGOD_DATA_PATH=%USERPROFILE%\Desktop\mongodb\data"

echo ============================================
echo   OpenTPM Development Launcher
echo ============================================
echo.

netstat -ano | findstr /R /C:":27017 .*LISTENING" >nul
if not errorlevel 1 (
    echo [1/4] MongoDB is already running.
) else (
    if not exist "%MONGOD_PATH%" (
        echo [1/4] MongoDB is not running and mongod.exe was not found.
        echo Set MONGOD_PATH and MONGOD_DATA_PATH, then run npm run dev again.
        exit /b 1
    )
    echo [1/4] Starting MongoDB...
    start "OpenTPM MongoDB" /MIN "%MONGOD_PATH%" --dbpath "%MONGOD_DATA_PATH%"
)

findstr /R /I "^BMW_SSO_ENABLED[ ]*=[ ]*true" "%ROOT_DIR%.env" >nul
if errorlevel 1 (
    echo [2/4] BMW SSO is disabled.
) else (
    netstat -ano | findstr /R /C:":8090 .*LISTENING" >nul
    if not errorlevel 1 (
        echo [2/4] BMW session keeper is already running.
    ) else (
        set "SESSION_KEEPER_PYTHON=%ROOT_DIR%services\session-keeper\.venv\Scripts\python.exe"
        if not exist "%SESSION_KEEPER_PYTHON%" (
            echo [2/4] Session keeper dependencies are not installed.
            echo Run the setup command in README.md, then run npm run dev again.
            exit /b 1
        )
        echo [2/4] Starting BMW session keeper...
        start "OpenTPM Session Keeper" /D "%ROOT_DIR%services\session-keeper" "%SESSION_KEEPER_PYTHON%" -m uvicorn session_keeper.app:app --host 0.0.0.0 --port 8090 --reload
    )
)

netstat -ano | findstr /R /C:":3080 .*LISTENING" >nul
if not errorlevel 1 (
    echo [3/4] Backend is already running.
) else (
    echo [3/4] Starting backend with nodemon...
    start "OpenTPM Backend" /D "%ROOT_DIR%" npm.cmd run backend:dev
)

netstat -ano | findstr /R /C:":3090 .*LISTENING" >nul
if not errorlevel 1 (
    echo [4/4] Frontend is already running.
) else (
    echo [4/4] Starting frontend with Vite...
    start "OpenTPM Frontend" /D "%ROOT_DIR%" npm.cmd run frontend:dev
)

echo.
echo Frontend: http://localhost:3090
echo Backend:  http://localhost:3080
endlocal
exit /b 0
