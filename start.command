#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю компоненты. Это займет минуту."
  npm install || exit 1
fi

echo "Открываю окно программы. Это окно можно свернуть, но не закрывать."
( sleep 3; open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787 >/dev/null 2>&1 ) &
npm run ui
