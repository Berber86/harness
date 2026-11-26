@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

.venv\Scripts\python.exe -c "import chainlit" 2>nul
if errorlevel 1 (
    echo Installing dependencies ^(this may take 1-2 minutes^)...
    .venv\Scripts\python.exe -m pip install -e .
)

echo Starting web interface...
.venv\Scripts\python.exe -m chainlit run app.py -w
pause
