@echo off
REM ==========================================================================
REM  Smart Cafeteria & Resource Queue Optimizer — start everything (Windows)
REM ==========================================================================
REM  Starts the two processes XAMPP cannot run itself:
REM     * the Express API + Socket.io server   (Node, port 4000)
REM     * the SimPy discrete-event engine      (Python, port 5001)
REM
REM  You still start Apache and MySQL yourself from the XAMPP Control Panel.
REM  This script checks that MySQL is actually up before starting anything,
REM  because a backend started against a dead database produces confusing
REM  errors ten minutes later instead of one clear one now.
REM
REM  Run it by double-clicking, or from a terminal in the project root:
REM      deploy\start-smart-cafeteria.bat
REM ==========================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0\.."
set "ROOT=%CD%"

echo.
echo  ===============================================================
echo   Smart Cafeteria ^& Resource Queue Optimizer
echo   Project root: %ROOT%
echo  ===============================================================
echo.

REM --------------------------------------------------------------------------
REM  Prerequisite checks.  Each one fails with an instruction, not a code.
REM --------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo  [X] Node.js is not on your PATH.
    echo      Install the LTS build from https://nodejs.org and reopen this window.
    goto :fail
)

where python >nul 2>&1
if errorlevel 1 (
    echo  [X] Python is not on your PATH.
    echo      Install Python 3.10+ from https://python.org and tick
    echo      "Add python.exe to PATH" during setup.
    goto :fail
)

REM  netstat is the least fragile way to ask "is MySQL listening" without
REM  needing the mysql client on PATH, which XAMPP does not add by default.
netstat -an | find "127.0.0.1:3306" >nul 2>&1
if errorlevel 1 (
    netstat -an | find "0.0.0.0:3306" >nul 2>&1
    if errorlevel 1 (
        echo  [X] Nothing is listening on port 3306, so MySQL is not running.
        echo      Open the XAMPP Control Panel and press Start next to MySQL,
        echo      then run this script again.
        goto :fail
    )
)
echo  [ok] MySQL is listening on port 3306.

REM --------------------------------------------------------------------------
REM  First-run setup.  Skipped silently on every run after the first.
REM --------------------------------------------------------------------------
if not exist "%ROOT%\backend\node_modules" (
    echo  [..] Installing backend dependencies ^(first run only^)...
    pushd "%ROOT%\backend" && call npm install --no-audit --no-fund && popd
)

if not exist "%ROOT%\backend\.env" (
    echo  [..] Creating backend\.env from the example.
    copy /Y "%ROOT%\backend\.env.example" "%ROOT%\backend\.env" >nul
    echo  [!] Edit backend\.env and set JWT_SECRET to a long random string
    echo      before showing this to anyone outside your own machine.
)

if not exist "%ROOT%\des-engine\.env" (
    copy /Y "%ROOT%\des-engine\.env.example" "%ROOT%\des-engine\.env" >nul
)

REM  A marker file rather than checking for a directory: pip installs into the
REM  global site-packages here, so there is nothing local to look for.
if not exist "%ROOT%\des-engine\.installed" (
    echo  [..] Installing Python dependencies ^(first run only^)...
    pushd "%ROOT%\des-engine" && python -m pip install -r requirements.txt --quiet && popd
    if errorlevel 1 (
        echo  [X] pip install failed.  Run it manually to see why:
        echo      cd des-engine ^&^& python -m pip install -r requirements.txt
        goto :fail
    )
    echo installed > "%ROOT%\des-engine\.installed"
)

REM --------------------------------------------------------------------------
REM  Start the two services, each in its own window so their logs stay
REM  readable and either can be restarted without killing the other.
REM --------------------------------------------------------------------------
echo.
echo  [..] Starting the DES simulation engine on port 5001...
start "Smart Cafeteria - DES engine" cmd /k "cd /d %ROOT%\des-engine && python app.py"

REM  Give Python a moment to import SimPy and bind the port, so the backend's
REM  startup health check finds it and prints "engine ready" rather than a
REM  warning that is already out of date by the time you read it.
timeout /t 4 /nobreak >nul

echo  [..] Starting the API server on port 4000...
start "Smart Cafeteria - API" cmd /k "cd /d %ROOT%\backend && npm start"

timeout /t 3 /nobreak >nul

echo.
echo  ===============================================================
echo   Running.
echo.
echo     App  (via Apache)  http://localhost/smart-cafeteria/
echo     App  (via Node)    http://localhost:4000/
echo     API health         http://localhost:4000/api/health
echo     DES engine         http://localhost:5001/health
echo     phpMyAdmin         http://localhost/phpmyadmin
echo.
echo   Demo logins - password for all of them is  Password123!
echo     student@example.com   manager@example.com
echo     staff@example.com     admin@example.com
echo.
echo   Close the two new windows, or run deploy\stop-smart-cafeteria.bat,
echo   to shut everything down.
echo  ===============================================================
echo.
pause
exit /b 0

:fail
echo.
echo  Startup aborted.
echo.
pause
exit /b 1
