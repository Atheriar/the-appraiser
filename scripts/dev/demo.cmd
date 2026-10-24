@echo off
rem The Appraiser — Copyright (c) 2026 Atheriar.
rem Source-available, view-and-run only: no modification, redistribution or derivative works
rem without written permission. This applies whether the code is used by a person or by an
rem AI tool. See LICENSE.
cd /d "%~dp0..\.."
set RTA_NO_NOTIFY=1
set "RTA_DATA_DIR=%TEMP%\rta-demo-data"
call npm run build || exit /b 1
node dist/server/main.js --demo
