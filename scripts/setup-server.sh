#!/usr/bin/env bash
# Подготовка Ubuntu/Debian-сервера к генерации видео.
# Запускать из корня репозитория:  sudo bash scripts/setup-server.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root — запустите через sudo:" >&2
  echo "  sudo bash scripts/setup-server.sh" >&2
  exit 1
fi

if [[ ! -f package.json ]]; then
  echo "Запускайте скрипт из корня репозитория (там, где лежит package.json)." >&2
  exit 1
fi

# На Ubuntu 24.04 часть библиотек переименована в *t64 — берём то, что есть.
pick_pkg() {
  local candidate
  for candidate in "$@"; do
    if apt-cache show "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  echo "Не найден ни один из пакетов: $*" >&2
  return 1
}

echo "==> Обновляю список пакетов"
apt-get update -y

echo "==> Ставлю базовые утилиты"
apt-get install -y --no-install-recommends ca-certificates curl gnupg git

# Node.js 18+ обязателен (в проекте используется встроенный fetch).
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    echo "==> Node.js $(node -v) уже установлен, пропускаю"
    NEED_NODE=0
  else
    echo "==> Node.js $(node -v) слишком старый, обновляю"
  fi
fi

if [[ "$NEED_NODE" -eq 1 ]]; then
  echo "==> Ставлю Node.js 22 LTS"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

# Remotion рендерит видео в headless Chrome. Сам Chrome он скачивает при
# первом рендере, но системные библиотеки для него нужно поставить заранее.
echo "==> Ставлю системные библиотеки для headless Chrome"
apt-get install -y --no-install-recommends \
  "$(pick_pkg libasound2t64 libasound2)" \
  "$(pick_pkg libatk-bridge2.0-0t64 libatk-bridge2.0-0)" \
  "$(pick_pkg libatk1.0-0t64 libatk1.0-0)" \
  "$(pick_pkg libcups2t64 libcups2)" \
  "$(pick_pkg libgdk-pixbuf-2.0-0 libgdk-pixbuf2.0-0)" \
  libcairo2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libx11-6 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  fonts-liberation

echo "==> Ставлю зависимости проекта"
# npm ci ставит строго по package-lock.json. Запускаем от имени владельца
# каталога, чтобы node_modules не оказался во владении root.
REPO_OWNER="$(stat -c '%U' .)"
if [[ "$REPO_OWNER" != "root" ]]; then
  sudo -u "$REPO_OWNER" npm ci
else
  npm ci
fi

if [[ ! -f .env ]]; then
  echo "==> Создаю .env из .env.example"
  cp .env.example .env
  if [[ "$REPO_OWNER" != "root" ]]; then
    chown "$REPO_OWNER" .env
  fi
  chmod 600 .env
fi

cat <<'DONE'

==> Готово.

Осталось два шага:

  1. Впишите ключи в файл .env (он уже создан, права 600):
       nano .env
     Нужны: OPENROUTER_API_KEY и KIE_API_KEY

  2. Запустите генерацию:
       npm run generate -- "бриф: что за продукт, для кого, какой посыл"
       npm run render

Готовый ролик появится в out/video.mp4
DONE
