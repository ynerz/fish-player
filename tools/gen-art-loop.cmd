@echo off
rem ===========================================================================
rem  Fishing game - continuous fish-card rendering.
rem  Double-click this file to run. Close the window to stop.
rem
rem  WHY THIS EXISTS:
rem    Any process started from an AI session gets reaped when that turn ends
rem    (background / detached / nohup all fail), and the OS-level scheduler
rem    (schtasks.exe) is on this machine's program blacklist. So "just keep it
rem    running" has to be an ordinary console process that YOU own. No install,
rem    no system settings touched.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads .cmd in the system ANSI code
rem  page, so UTF-8 Chinese text here gets shredded into broken commands.
rem
rem  ARG: optional "minutes per segment", default 0 = unlimited (runs to the end).
rem       e.g.  gen-art-loop.cmd 30   -> wrap up every 30 min, then continue.
rem ===========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0.."

set "PY=C:\Users\15001\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "BUDGET=%~1"
if "%BUDGET%"=="" set "BUDGET=0"

if not exist "%PY%" (
  echo [X] python not found: %PY%
  pause
  exit /b 1
)

echo ===========================================================
echo   Fish card rendering - continuous
echo   workdir : %CD%
echo   segment : %BUDGET% min  ^(0 = unlimited^)
echo   images  : 6 per fish normally; 7 for legendary
echo             legendary shiny is rendered TWICE - id-shiny.png and id-shiny-2.png
echo   speed   : about 60 s per image at 25 steps, 110 s at 35 steps
echo             golden and shiny use 35 steps; real speed varies with machine load
echo   note    : --skip-existing only fills in MISSING files.
echo             Cards made with an OLDER prompt are NOT re-rendered.
echo             Run  gen-art.py --stale  for that list, or use the review page
echo             to re-render the ones you marked.
echo   close this window to stop
echo ===========================================================
echo.

:loop
"%PY%" -u tools\gen-art.py --skip-existing --budget-min %BUDGET%
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [!] last segment exit code = %RC%
if "%BUDGET%"=="0" goto done
echo [%TIME%] segment done, next in 2 s...
ping -n 3 127.0.0.1 >nul
goto loop

:done
echo.
echo ===========================================================
echo   Finished (or nothing left to render).
echo   images : assets\cards\      ledger : assets\cards\manifest.json
echo   verify : tools\check-cards.py  (run with system conda python)
echo ===========================================================
pause
