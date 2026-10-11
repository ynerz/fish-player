@echo off
rem ===========================================================================
rem  Pick the better LEGENDARY shiny  --  double-click this file.
rem
rem  Only legendary fish render shiny TWICE (the user's call: legendary
rem  cards are display pieces, so give them two candidates and let a human pick).
rem  Every other fish has exactly one shiny card and needs nothing here.
rem
rem    double-click            -> list the legendary fish that still have 2 versions
rem    pick-shiny.cmd A44 2    -> swap in version 2 for A44  (EXPLICIT version)
rem    pick-shiny.cmd A44 dry  -> DRY RUN: prints what would happen, writes nothing
rem                               (a dry run MAY omit the version: it defaults to 2;
rem                                "--dry" works too -- normalised in tools\pick-card.py)
rem
rem  WHY THERE IS NO BARE "pick-shiny.cmd A44": a swap really swaps the files AND the
rem  manifest record together, so "typing one number less" must not turn into a write.
rem  That default lives in tools\pick-card.py (dry runs only, where it is harmless);
rem  THIS launcher forwards your argument verbatim instead of inventing a version.
rem  It also rejects a third argument instead of silently dropping it (keep 2 max).
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
if not "%~3"=="" (
  echo [X] too many arguments: usage is  pick-shiny.cmd ^<ID^> [version ^| dry]
  echo     got:  %*
  echo     a 3rd argument used to be dropped silently - now it is an error
  pause
  exit /b 2
)

if "%ID%"=="" (
  echo ===========================================================
  echo   Legendary shiny - candidates  ^(2 versions each^)
  echo ===========================================================
  echo.
  "%PY%" -u tools\pick-card.py --list --morph shiny
  set "RC=%ERRORLEVEL%"
  echo.
  echo -----------------------------------------------------------
  echo   To swap in version 2:   pick-shiny.cmd ^<ID^> 2    e.g.  pick-shiny.cmd A44 2
  echo   To dry-run first:       pick-shiny.cmd ^<ID^> dry  e.g.  pick-shiny.cmd A44 dry
  echo   To look at them first:  double-click  tools\review-desk.cmd
  echo -----------------------------------------------------------
  echo.
  if not "%RC%"=="0" echo [!] exit code = %RC%
  pause
  exit /b %RC%
)

echo ===========================================================
echo   Shiny pick for %ID%
if "%~2"=="" (
  echo   args forwarded to pick-card.py : ^(none^)
  echo   ^>^> a real swap needs an explicit version, so this will stop and tell you
) else (
  echo   args forwarded to pick-card.py : %~2
)
echo ===========================================================
echo.
"%PY%" -u tools\pick-card.py %ID% shiny %~2
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [!] exit code = %RC%
pause
exit /b %RC%
