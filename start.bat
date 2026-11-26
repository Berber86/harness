@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Мой помощник

if not exist "node_modules" (
  echo Первый запуск: устанавливаю компоненты. Это займет минуту.
  call npm install
  if errorlevel 1 goto :fail
)

echo Открываю окно программы. Это черное окно можно свернуть, но не закрывать.
powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:8787'"
call npm run ui
goto :eof

:fail
echo Не удалось установить компоненты. Напиши об этом в чат, и мы разберемся.
pause
