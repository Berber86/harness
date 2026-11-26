#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "Первый запуск: создаю окружение и устанавливаю библиотеки..."
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -e .
else
    source .venv/bin/activate
fi

echo "Запускаю интерфейс в браузере..."
chainlit run app.py -w
