#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю компоненты. Это займет минуту."
  npm install || exit 1
fi

node scripts/launch-ui.mjs
