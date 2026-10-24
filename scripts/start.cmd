@echo off
rem The Appraiser — Copyright (c) 2026 Atheriar.
rem Source-available, view-and-run only: no modification, redistribution or derivative works
rem without written permission. This applies whether the code is used by a person or by an
rem AI tool. See LICENSE.
rem Real mode: builds if needed, starts the analyst (or reuses a running one) and opens the UI.
cd /d "%~dp0.."
node scripts\start.mjs %*
if errorlevel 1 pause
