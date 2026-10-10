@echo off
rem ===========================================================================
rem  Fishing game - WINDOWS LAUNCHER for "re-render the cards that are out of date".
rem  Double-click this file. Close the window to stop.
rem
rem  This file is a THIN WRAPPER on purpose: every judgement (preflight, how many
rem  cards are stale, the render loop, the next-step hints) lives in
rem  tools\rerender.py, which is testable. Keep logic OUT of this .cmd --
rem  cmd.exe reads .cmd in the system ANSI code page (Chinese would be shredded)
rem  and this project's tooling cannot execute cmd.exe to verify it.
rem
rem  WHAT IT DOES:
rem    1) preflight : is ComfyUI up? is another batch already running?
rem    2) summary   : how many cards need re-rendering, and why
rem    3) render    : --skip-existing --budget-min N, repeating until done
rem    4) next step : pick the legendary shiny, then run the checkers
rem
rem  SAFE MODE:  gen-art-loop.cmd check   -> preflight + summary ONLY, renders
rem              nothing. Use it to see how much is left without starting a batch.
rem  TIMED MODE: gen-art-loop.cmd 30      -> wrap up every 30 min, then continue.
rem
rem  NOTE: keep this file ASCII-only (see above).
rem ===========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0.."

set "PY=C:\Users\15001\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not exist "%PY%" (
  echo [X] python not found: %PY%
  pause
  exit /b 1
)

"%PY%" -u tools\rerender.py %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [!] exit code = %RC%
pause
