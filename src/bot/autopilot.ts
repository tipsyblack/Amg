import type { Session, Step } from "./state";

/**
 * Решение автопилота: делать ли следующий шаг сразу, без кнопки.
 *
 * Отдельным файлом, потому что здесь два неочевидных условия, и оба уже могли
 * бы стоить ролика:
 *
 * 1. `ok` — предыдущий шаг ДОЛЖЕН был пройти. Обёртка withGeneration ловит
 *    ошибки сама и отвечает в чат кнопкой «Повторить», то есть исключение
 *    наружу не выходит и по одному только факту возврата продолжать нельзя:
 *    следующий шаг работал бы на пустом месте и добавил бы к одной ошибке
 *    вторую.
 * 2. `step === "idle"` — диалог не должен чего-то ждать. Шаг сценария может
 *    закончиться остановкой автопилота (в сценарии осталась объективная
 *    проблема) и выставить ожидание правок; продолжать в этот момент значит
 *    рисовать картинки к заведомо негодному сценарию.
 *
 * Сама цепочка вызывается СНАРУЖИ withGeneration: внутри флаг генерации ещё
 * поднят, и вложенный шаг ответил бы «уже идёт другая генерация».
 */
export function autopilotContinues({
  ok,
  session,
}: {
  ok: boolean;
  session: Pick<Session, "autopilot" | "step">;
}): boolean {
  return ok && session.autopilot === true && session.step === "idle";
}

/** Шаги конвейера в том порядке, в котором их проходит автопилот. */
export const AUTOPILOT_CHAIN: readonly ["script", "images", "assemble"] = [
  "script",
  "images",
  "assemble",
];

/**
 * Разбор аргумента команды. Пусто — переключить, иначе явное значение: на
 * потоке удобнее и `/autopilot` без аргумента, и `/autopilot off` наверняка.
 */
export function parseAutopilotArg(
  arg: string | undefined,
  current: boolean,
): boolean {
  const value = (arg ?? "").trim().toLowerCase();
  if (!value) return !current;
  return ["on", "вкл", "1", "да", "true", "yes"].includes(value);
}

export type AutopilotStep = (typeof AUTOPILOT_CHAIN)[number];
export type { Step };
