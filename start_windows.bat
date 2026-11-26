@echo off
cd /d "%~dp0"

if not exist ".venv" (
    echo Первый запуск: создаю окружение и устанавливаю библиотеки...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    pip install -e .
) else (
    call .venv\Scripts\activate.bat
)

echo Запускаю интерфейс в браузере...
chainlit run app.py -w
pause
