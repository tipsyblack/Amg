#!/usr/bin/env bash
# Автодеплой: подтягивает новые коммиты из GitHub и, если менялись
# зависимости, переустанавливает их. Ничего не генерирует и не рендерит.
#
# Ручной запуск:  bash scripts/auto-deploy.sh
# По расписанию:  см. docs/SERVER.md (раздел про автодеплой)
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${DEPLOY_BRANCH:-claude/remotion-video-automation-biby8g}"
LOCK_FILE="${LOCK_FILE:-/tmp/amg-deploy.lock}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# Не даём двум деплоям идти одновременно (например, если предыдущий запуск
# из cron ещё не закончил npm ci).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Деплой уже выполняется, пропускаю запуск"
  exit 0
fi

cd "$REPO_DIR"

git fetch --quiet origin "$BRANCH"

LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"

# Обновлений нет — выходим тихо, чтобы не засорять лог при запуске каждые
# несколько минут.
if [[ "$LOCAL_REV" == "$REMOTE_REV" ]]; then
  exit 0
fi

log "Найдены обновления: ${LOCAL_REV:0:7} -> ${REMOTE_REV:0:7}"

LOCK_HASH_BEFORE="$(git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)"

# reset --hard приводит отслеживаемые файлы точно к состоянию GitHub.
# Файлы вне git (.env, out/, public/audio, public/images) не затрагиваются.
git reset --hard --quiet "origin/$BRANCH"

LOCK_HASH_AFTER="$(git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)"

if [[ "$LOCK_HASH_BEFORE" != "$LOCK_HASH_AFTER" ]]; then
  log "Изменился package-lock.json — переустанавливаю зависимости"
  npm ci
else
  log "Зависимости не менялись, npm ci не нужен"
fi

log "Готово, версия на сервере: $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"
