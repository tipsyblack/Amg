import { config } from "./config";

/**
 * Имена моделей озвучки у двух путей разные, и это ловушка.
 *
 * Прокси Kie.ai ждёт `elevenlabs/text-to-speech-multilingual-v2`, сам
 * ElevenLabs — `eleven_multilingual_v2`. Команда `/ttsmodel` одна, а значение
 * должно подойти тому пути, который сейчас работает.
 *
 * Раньше этой проблемы просто не существовало: на прямом пути модель вообще не
 * бралась из настройки — там всегда стояло значение из .env, что бы ни выбрали
 * командой. Настройка была, а действия у неё не было.
 */

/** Модели ElevenLabs, пригодные для озвучки текста. Из их официального SDK. */
export const DIRECT_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2_5",
  "eleven_v3",
] as const;

/** Похоже ли это на имя модели самого ElevenLabs. */
export function isDirectModel(name: string): boolean {
  return /^eleven_[a-z0-9_]+$/i.test(name.trim());
}

/**
 * Соответствие имён между путями. Список короткий намеренно: угадывать имя,
 * которого мы не видели, хуже, чем честно откатиться на значение из .env.
 */
const FROM_KIE: Record<string, string> = {
  "elevenlabs/text-to-speech-multilingual-v2": "eleven_multilingual_v2",
  "elevenlabs/text-to-speech-turbo-v2-5": "eleven_turbo_v2_5",
  "elevenlabs/text-to-speech-flash-v2-5": "eleven_flash_v2_5",
};

/**
 * Какую модель отправить прямому ElevenLabs.
 *
 * Имя из настройки подходит как есть — берём его. Имя в формате Kie.ai —
 * переводим, если знаем перевод. Не знаем — берём значение из .env: лучше
 * озвучить моделью по умолчанию, чем получить отказ на имени, которого у
 * ElevenLabs нет.
 */
export function directModelId(override?: string): string {
  const name = (override ?? "").trim();
  if (!name) return config.elevenLabsModelId;
  if (isDirectModel(name)) return name;
  return FROM_KIE[name] ?? config.elevenLabsModelId;
}

/**
 * Понятно ли, что произойдёт с выбранной моделью на прямом пути. Нужно, чтобы
 * бот мог предупредить сразу, а не оставить человека гадать, почему голос не
 * изменился.
 */
export function directModelNote(override?: string): string | undefined {
  const name = (override ?? "").trim();
  if (!name || isDirectModel(name)) return undefined;
  if (FROM_KIE[name]) {
    return `На прямом ElevenLabs это ${FROM_KIE[name]} — перевёл имя автоматически.`;
  }
  return (
    `Имя «${name}» — из набора Kie.ai, у прямого ElevenLabs такой модели нет. ` +
    `Озвучу моделью по умолчанию (${config.elevenLabsModelId}). ` +
    `Модели прямого пути: ${DIRECT_TTS_MODELS.join(", ")}.`
  );
}
