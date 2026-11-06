@echo off
title CloudForge Server
cd /d "%~dp0"
echo Starting CloudForge Server...
echo.
echo   Owner panel : http://localhost:3000/
echo   Customer app: http://localhost:3000/app
echo.
echo Keep this window open. Press Ctrl+C to stop.
echo.
node server\index.js
pause
