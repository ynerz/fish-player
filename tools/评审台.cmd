@echo off
rem ===========================================================================
rem  Forwarder only. The real launcher is review-desk.cmd (ASCII name + ASCII
rem  body) -- that is what tools\gen-art-loop.cmd points at.
rem  This file exists so the old Chinese file name keeps working (it is the name
rem  already known to the user). Keep this body ASCII-only.
rem ===========================================================================
@call "%~dp0review-desk.cmd" %*
