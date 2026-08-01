@echo off
chcp 65001 >nul
title KAIRA Launcher
color 0B

set "PYTHON_EXE=C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe"
set "PROJECT_DIR=%~dp0"

echo ============================================================
echo                 KAIRA ALL-IN-ONE LAUNCHER
echo ============================================================
echo.

echo [1/4] Cleaning up any old instances...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 3000 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 8765 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo     Done.
echo.

echo [2/4] Starting Desktop Control Agent ^(Python, port 8765^)...
start "KAIRA Desktop Agent" /MIN cmd /k "cd /d "%PROJECT_DIR%" && "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765"
echo     Launching in background window...
echo.

echo [3/4] Waiting for agent to be ready...
set "READY=0"
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        echo     Desktop Agent is ONLINE - 52 tools ready!
        goto :agent_ready
    )
    echo     ...waiting %%i/15
)
:agent_ready
if "%READY%"=="0" (
    echo     [WARNING] Desktop Agent did not respond in time.
    echo     KAIRA will still run, but desktop control may be unavailable.
)
echo.

echo [4/4] Starting KAIRA Server ^(Node, port 3000^)...
echo ============================================================
echo   Desktop Agent : http://127.0.0.1:8765
echo   KAIRA UI      : http://localhost:3000
echo ============================================================
echo.
echo   Close this window to stop KAIRA.
echo   ^(Desktop Agent runs in its own minimized window.\)
echo.

cd /d "%PROJECT_DIR%"
npm run dev

echo.
echo KAIRA has stopped. Cleaning up Desktop Agent...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
pause
