@echo off
title Flonautics - Stop
setlocal
cd /d "%~dp0"

echo Stopping Flonautics...
docker compose -f docker-compose.hub.yml down

echo.
echo [OK] Stopped. Your data is kept.
echo      Double-click start.bat to run it again.
echo.
pause
