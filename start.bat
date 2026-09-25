@echo off
title Yu Code
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

echo Starting Yu Code...
call npm run dev
pause
