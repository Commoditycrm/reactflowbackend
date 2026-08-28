@echo off
title Flonautics - Start
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   Starting Flonautics...
echo ==========================================================
echo.

REM 1) Docker must be running
docker info >nul 2>&1
if errorlevel 1 (
  echo [X] Docker is not running.
  echo     Open "Docker Desktop", wait until it shows "Running",
  echo     then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM 2) .env must exist next to this file
if not exist ".env" (
  echo [X] No ".env" file found in this folder.
  echo     Ask your admin for the .env file and place it next to this script.
  echo.
  pause
  exit /b 1
)

echo Downloading the latest app images ^(the first time can take a few minutes^)...
docker compose -f docker-compose.hub.yml pull
if errorlevel 1 goto :err

echo.
echo Starting the app...
docker compose -f docker-compose.hub.yml up -d
if errorlevel 1 goto :err

echo.
echo Waiting for the app to be ready...
timeout /t 25 /nobreak >nul

echo Opening http://localhost:3000 in your browser...
start "" http://localhost:3000

echo.
echo [OK] The app is running. Keep Docker Desktop open.
echo      To stop it later, double-click stop.bat.
echo.
pause
exit /b 0

:err
echo.
echo [X] Something went wrong. Send this window's text to your admin.
echo.
pause
exit /b 1
