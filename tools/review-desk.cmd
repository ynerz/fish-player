@echo off
rem ===========================================================================
rem  Review desk launcher (ASCII name). The Chinese-named launcher that sits
rem  next to this file only forwards here -- both do the same thing.
rem
rem  It starts the local runner (loopback only) and opens the review page in
rem  your browser. With the runner up, the page's buttons can really start a
rem  re-render: either in its own console window (recommended) or in the
rem  background. Close THIS window to stop the runner (windows it already
rem  opened keep running -- they are separate processes).
rem
rem  WHY AN ASCII ALIAS EXISTS: tools\gen-art-loop.cmd points the user here, and
rem  .cmd files must stay ASCII-only (cmd.exe reads them in the system ANSI code
rem  page). So the real launcher lives here and the Chinese-named file forwards.
rem
rem  NOTE: keep this file ASCII-only. (Same note as tools/gen-art-loop.cmd.)
rem ===========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0.."

set "PY=C:\Users\15001\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "PORT=8770"

if not exist "%PY%" (
  echo [X] python not found: %PY%
  pause
  exit /b 1
)

echo ===========================================================
echo   Review desk  -  local runner
echo   workdir : %CD%
echo   url     : http://127.0.0.1:%PORT%/
echo   close this window to stop the runner
echo ===========================================================
echo.

"%PY%" -u tools\review-cards.py --serve --open --port %PORT%
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [!] runner exit code = %RC%
echo Runner stopped. (Re-render windows you opened may still be running.)
pause
