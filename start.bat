@echo off
chcp 65001 >nul
cd /d "%~dp0"
title My Assistant

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install LTS from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\tsx" (
  echo Installing dependencies, please wait...
  call npm install
  if errorlevel 1 goto :fail
)

node scripts\launch-ui.mjs
if errorlevel 1 goto :fail
goto :eof

:fail
echo Failed to start. Please copy this message into chat.
pause
exit /b 1
