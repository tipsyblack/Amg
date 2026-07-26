#!/usr/bin/env bash
# Разовое включение полной автоматизации на сервере:
#   1) автодеплой из GitHub по cron (раз в 5 минут);
#   2) телеграм-бот как systemd-сервис (автозапуск, перезапуск при сбоях).
# После этого заходить на сервер больше не нужно.
#
# Запуск из корня репозитория:  sudo bash scripts/install-automation.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo bash scripts/install-automation.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_LINE="*/5 * * * * /bin/bash $REPO_DIR/scripts/auto-deploy.sh >> $REPO_DIR/deploy.log 2>&1"

echo "==> Включаю автодеплой (cron, раз в 5 минут)"
# Идемпотентно: старую строку с auto-deploy убираем, новую добавляем.
{ crontab -l 2>/dev/null | grep -v "scripts/auto-deploy.sh" || true; echo "$CRON_LINE"; } | crontab -
echo "    $(crontab -l | grep auto-deploy)"

echo "==> Ставлю бота как systemd-сервис"
sed "s|/root/Amg|$REPO_DIR|g" "$REPO_DIR/scripts/amg-bot.service" \
  >/etc/systemd/system/amg-bot.service
systemctl daemon-reload
systemctl enable amg-bot >/dev/null 2>&1

if grep -q "^TELEGRAM_BOT_TOKEN=..*" "$REPO_DIR/.env" 2>/dev/null; then
  systemctl restart amg-bot
  echo "    бот запущен: systemctl status amg-bot"
else
  echo "    ВНИМАНИЕ: в .env нет TELEGRAM_BOT_TOKEN — бот установлен, но не запущен."
  echo "    Впишите токен (nano $REPO_DIR/.env) и выполните: systemctl restart amg-bot"
fi

cat <<'DONE'

==> Автоматизация включена.

Как это работает дальше:
  - новые коммиты в GitHub приезжают на сервер сами (максимум через 5 минут);
  - после обновления бот перезапускается автоматически;
  - бот стартует сам после перезагрузки сервера.

Посмотреть, что происходит (по желанию):
  tail -20 deploy.log            # журнал автодеплоя
  journalctl -u amg-bot -n 30    # журнал бота
DONE
