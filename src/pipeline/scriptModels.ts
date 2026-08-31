import { config } from "./config";

// Модели, которыми можно писать сценарий (через OpenRouter). Список нужен
// только для кнопок в боте: слаг можно задать и вручную — `/model <слаг>`, —
// потому что ID моделей на OpenRouter меняются чаще, чем наш код.
//
// Цены — списочные за 1M токенов на момент правки, для ориентира. Один
// сценарий это примерно 10к токенов на входе (системный промпт ~8.5 КБ плюс
// выдача веб-поиска) и ~1к на выходе, так что стоимость видна прямо в оценке.

export interface ScriptModelSpec {
  // Короткий ключ для callback-кнопок и хранения в сессии.
  key: string;
  title: string;
  note: string;
  model: string;
}

export const SCRIPT_MODELS: ScriptModelSpec[] = [
  {
    key: "sonnet",
    title: "Claude Sonnet 5",
    note: "по умолчанию, ~$0.03 за сценарий",
    // Слаг можно переопределить через OPENROUTER_MODEL в .env.
    model: config.openRouterModel,
  },
  {
    key: "opus",
    title: "Claude Opus 5",
    note: "максимум качества, ~$0.08 за сценарий",
    model: "anthropic/claude-opus-5",
  },
  {
    key: "flash",
    title: "Gemini 2.5 Flash",
    note: "дешёвый, ~$0.006 за сценарий",
    model: "google/gemini-2.5-flash",
  },
];

export const DEFAULT_SCRIPT_MODEL_KEY = "sonnet";

export function getScriptModel(key?: string): ScriptModelSpec {
  return (
    SCRIPT_MODELS.find((spec) => spec.key === key) ??
    SCRIPT_MODELS.find((spec) => spec.key === DEFAULT_SCRIPT_MODEL_KEY)!
  );
}

/**
 * Слаг модели для сессии. В сессии лежит либо ключ из списка, либо слаг,
 * введённый руками, — различаем по совпадению с ключами.
 */
export function resolveScriptModel(stored?: string): string {
  if (!stored) return config.openRouterModel;
  const known = SCRIPT_MODELS.find((spec) => spec.key === stored);
  return known ? known.model : stored;
}
