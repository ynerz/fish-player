@echo off
rem ===========================================================================
rem  Pick the better LEGENDARY shiny  --  double-click this file.
rem
rem  Only the 27 legendary fish render shiny TWICE (the user's call: legendary
rem  cards are display pieces, so give them two candidates and let a human pick).
rem  Every other fish has exactly one shiny card and needs nothing here.
rem
rem    double-click           -> list the legendary fish that still have 2 versions
rem    pick-shiny.cmd A44     -> swap in version 2 for A44 (defaults to version 2)
rem    pick-shiny.cmd A44 2   -> same thing, explicit
rem
rem  WHAT A SWAP MEANS: the pair is SWAPPED (files + the manifest records together),
rem  so the chosen image becomes the live card assets\cards\A44-shiny.png and the
rem  loser stays on disk as A44-shiny-2.png. Run the same command again to undo it.
rem  NEVER rename these files by hand and NEVER delete the losing version: the
rem  checklist counts "master + every version of every morph", so a missing file
rem  makes that fish look unfinished forever and it gets re-rendered again.
rem
rem  LOOK AT THEM FIRST: double-click tools\review-desk.cmd -- in the grid the two
rem  versions sit next to each other (labelled "shiny" and "shiny v2").
rem
rem  NOTE: keep this file ASCII-only (cmd.exe reads .cmd in the ANSI code page).
rem ===========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0.."

set "PY=C:\Users\15001\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "ID=%~1"
set "VER=%~2"
if "%VER%"=="" set "VER=2"

if not exist "%PY%" (
  echo [X] python not found: %PY%
  pause
  exit /b 1
)
if not exist "assets\cards\manifest.json" (
  echo [X] assets\cards\manifest.json not found - render some cards first
  pause
  exit /b 1
)

if "%ID%"=="" (
  echo ===========================================================
  echo   Legendary shiny - candidates  ^(2 versions each^)
  echo ===========================================================
  echo.
  "%PY%" -u tools\pick-card.py --list --morph shiny
  echo.
  echo -----------------------------------------------------------
  echo   To swap in version 2:   pick-shiny.cmd ^<ID^>       e.g.  pick-shiny.cmd A44
  echo   To dry-run first:       pick-shiny.cmd ^<ID^> --dry
  echo   To look at them first:  double-click  tools\review-desk.cmd
  echo -----------------------------------------------------------
  pause
  exit /b 0
)

echo ===========================================================
echo   Swapping in version %VER% for %ID%  ^(shiny^)
echo ===========================================================
echo.
"%PY%" -u tools\pick-card.py %ID% shiny %VER%
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [!] exit code = %RC%
pause
