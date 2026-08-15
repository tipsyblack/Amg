import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Правка `.env` на сервере из чата.
 *
 * Зачем вообще: заказчик не хочет заходить по SSH, а ключи живут только в
 * `.env` — репозиторий публичный, и класть их туда нельзя. Без этого любая
 * новая интеграция упирается в «откройте nano».
 *
 * ЧЕМ ЭТО ОПАСНО И ЧТО С ЭТИМ СДЕЛАНО. Ключ, набранный в чат, остаётся в
 * истории Telegram и в уведомлениях на телефоне. Поэтому:
 *
 *  - сообщение с ключом бот удаляет сразу после чтения;
 *  - в ответ печатается только хвост из четырёх знаков, никогда сам ключ;
 *  - менять можно ТОЛЬКО перечисленные ниже переменные. Без белого списка
 *    команда стала бы способом переписать в `.env` что угодно — от пути до
 *    токена самого бота;
 *  - команда работает лишь когда задан TELEGRAM_ALLOWED_CHAT_ID. Иначе бот
 *    открыт всем, кто его найдёт, и правка ключей из чата означала бы, что их
 *    может переписать любой прохожий.
 */

export const ENV_FILE = path.resolve(".env");

/**
 * Что разрешено менять из чата.
 *
 * Токена самого бота здесь нет намеренно: ошибка в нём отрезала бы
 * единственный канал управления, и чинить пришлось бы всё равно по SSH.
 */
export const EDITABLE_KEYS = [
  "ZERNIO_API_KEY",
  "ZERNIO_PROFILE_ID",
  "OPENROUTER_API_KEY",
  "KIE_API_KEY",
  "ELEVENLABS_API_KEY",
] as const;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

export function isEditableKey(name: string): name is EditableKey {
  return (EDITABLE_KEYS as readonly string[]).includes(name);
}

/**
 * Показ значения: хвост из четырёх знаков и длина.
 *
 * Полностью скрывать нельзя — иначе не отличить «ключ на месте» от «вставился
 * с лишним пробелом». Хвоста достаточно, чтобы сверить с личным кабинетом, и
 * мало, чтобы ключом воспользоваться.
 */
export function maskSecret(value: string): string {
  if (!value) return "не задан";
  if (value.length <= 4) return `${"•".repeat(value.length)} (${value.length} знаков)`;
  return `…${value.slice(-4)} (${value.length} знаков)`;
}

/** Разбор команды `/setkey ИМЯ значение`. */
export function parseSetKey(
  input: string | undefined,
): { name: string; value: string } | { error: string } {
  const text = (input ?? "").trim();
  if (!text) {
    return {
      error:
        "Формат: /setkey ИМЯ значение\n\nНапример: /setkey ZERNIO_API_KEY zk_живой_ключ",
    };
  }
  const space = text.search(/\s/);
  if (space < 0) {
    return { error: `Не вижу значения для ${text}. Формат: /setkey ИМЯ значение` };
  }
  const name = text.slice(0, space).trim().toUpperCase();
  // Значение берём как есть, но без окружающих пробелов и кавычек: из буфера
  // ключ часто прилетает в кавычках, и записать их в .env — значит получить
  // «неверный ключ» на ровном месте.
  const value = text
    .slice(space + 1)
    .trim()
    .replace(/^["'](.*)["']$/s, "$1");
  if (!value) {
    return { error: `Пустое значение для ${name}. Формат: /setkey ИМЯ значение` };
  }
  if (!isEditableKey(name)) {
    return {
      error:
        `${name} менять из чата нельзя. Разрешены: ${EDITABLE_KEYS.join(", ")}.\n\n` +
        "Остальное правится только на сервере — это защита от того, чтобы " +
        "одной опечаткой в чате не сломать бота целиком.",
    };
  }
  return { name, value };
}

/** Текущее содержимое `.env` строками. Нет файла — пустой список. */
function readLines(): string[] {
  if (!existsSync(ENV_FILE)) return [];
  return readFileSync(ENV_FILE, "utf-8").split("\n");
}

/**
 * Записывает переменную, сохраняя всё остальное — комментарии, порядок и
 * прочие ключи. Переписывать файл целиком нельзя: там настройки, которых бот
 * не знает.
 */
export function setEnvValue(name: string, value: string): void {
  const lines = readLines();
  const pattern = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  let replaced = false;

  const next = lines.map((line) => {
    if (replaced || !pattern.test(line)) return line;
    replaced = true;
    return `${name}=${value}`;
  });

  if (!replaced) {
    // Файл мог кончаться без перевода строки — тогда новая переменная
    // прилипла бы к последней.
    if (next.length > 0 && next[next.length - 1].trim() !== "") next.push("");
    next.push(`${name}=${value}`);
    next.push("");
  }

  writeFileSync(ENV_FILE, next.join("\n"));
  // Права на файл с ключами — только владельцу. Если файл создаётся впервые,
  // без этого он унаследовал бы umask и оказался читаемым для всех.
  chmodSync(ENV_FILE, 0o600);
}

/** Значение переменной из файла (не из process.env — там старое). */
export function getEnvValue(name: string): string {
  const pattern = new RegExp(`^\\s*(export\\s+)?${name}\\s*=(.*)$`);
  for (const line of readLines()) {
    const match = line.match(pattern);
    if (match) return match[2].trim().replace(/^["'](.*)["']$/s, "$1");
  }
  return "";
}
