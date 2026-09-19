@echo off
REM ==========================================================================
REM  Stop the Node API and the Python DES engine.
REM ==========================================================================
REM  Deliberately targets the two windows by title rather than killing every
REM  node.exe and python.exe on the machine — you may well have VS Code, a
REM  Jupyter notebook or another project running, and a blanket
REM  "taskkill /IM node.exe" would take those down too.
REM
REM  Apache and MySQL are left alone: stop those from the XAMPP Control Panel
REM  if you want to, since other work may be using them.
REM ==========================================================================

echo.
echo  Stopping Smart Cafeteria services...

taskkill /FI "WINDOWTITLE eq Smart Cafeteria - API*" /T /F >nul 2>&1
if errorlevel 1 (echo  [-] API server was not running.) else (echo  [ok] API server stopped.)

taskkill /FI "WINDOWTITLE eq Smart Cafeteria - DES engine*" /T /F >nul 2>&1
if errorlevel 1 (echo  [-] DES engine was not running.) else (echo  [ok] DES engine stopped.)

echo.
echo  Apache and MySQL were left running - stop them from the XAMPP Control Panel.
echo.
pause
