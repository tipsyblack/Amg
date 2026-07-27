import { config } from "./config";
import type { GeneratedScript } from "./generateScript";
import { stripSources } from "./generateScript";

// Текст под ролик: то, что вставляется в описание поста в Reels, Shorts,
// TikTok и VK Клипах. Пишется по готовому сценарию — описание должно обещать
// ровно то, что в видео, иначе зритель уходит и алгоритмы это запоминают.

// Целевая длина. Меньше 350 символов — описание не работает на поиск и не
// объясняет, о чём ролик; больше 700 — площадки обрезают, и хвост с хештегами
// не виден.
export const DESCRIPTION_MIN_CHARS = 350;
export const DESCRIPTION_MAX_CHARS = 700;

function buildPrompt(targetChars: number): string {
  return `Ты пишешь текст описания под короткое вертикальное видео (Instagram Reels, YouTube Shorts, TikTok, VK Клипы).

Отвечай СТРОГО валидным JSON без markdown-обёртки: {"description": string}

Требования к описанию:
- Длина примерно ${targetChars} символов (допустимо от ${DESCRIPTION_MIN_CHARS} до ${DESCRIPTION_MAX_CHARS}).
- Структура: первая строка — зацепка из ролика (можно вопросом), затем 2-3
  коротких абзаца по сути видео, затем призыв к действию, затем 3-5 хештегов.
- Эмодзи обязательны, но по делу: 1-2 на абзац, как маркеры, а не гирлянда.
  Не начинай каждую строку одним и тем же смайликом.
- Пиши то, что реально есть в ролике. Не обещай того, чего в нём нет.
- Никаких ссылок и адресов сайтов: площадки занижают охват за внешние ссылки в
  описании, а сама ссылка живёт в профиле.
- Без markdown-разметки: ни звёздочек, ни решёток кроме хештегов.
- Язык — тот же, что в сценарии.
- Абзацы разделяй переводами строки.`;
}

function scriptForPrompt(script: GeneratedScript): string {
  const scenes = script.scenes
    .map((scene, i) => `${i + 1}. ${scene.caption} — ${scene.voiceoverText}`)
    .join("\n");
  return `Заголовок: ${script.title}\n\nСцены:\n${scenes}`;
}

/**
 * Простое описание из самого сценария — на случай, когда модель недоступна или
 * упрямо отдаёт мусор. Лучше короткий честный текст, чем пустое поле.
 */
export function fallbackDescription(script: GeneratedScript): string {
  const first = script.scenes[0]?.voiceoverText ?? script.title;
  const middle = script.scenes
    .slice(1, -1)
    .map((scene) => scene.voiceoverText)
    .join(" ");
  const cta = script.scenes[script.scenes.length - 1]?.voiceoverText ?? "";
  const text = [
    `🔥 ${first}`,
    `💡 ${middle}`.trim(),
    `👉 ${cta}`.trim(),
    "#нейросети #ии #технологии #автоматизация",
  ]
    .filter((part) => part.length > 2)
    .join("\n\n");
  // Обрезаем по границе слова, чтобы текст не заканчивался на половине слова.
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/**
 * Что не так с описанием. Возвращает причину — её же отправляем модели.
 */
export function descriptionProblem(text: string): string | undefined {
  const clean = text.trim();
  if (clean.length < DESCRIPTION_MIN_CHARS) {
    return `описание короткое (${clean.length} символов, нужно от ${DESCRIPTION_MIN_CHARS})`;
  }
  if (clean.length > DESCRIPTION_MAX_CHARS) {
    return `описание длинное (${clean.length} символов, нужно до ${DESCRIPTION_MAX_CHARS})`;
  }
  if (!EMOJI.test(clean)) return "в описании нет эмодзи";
  if (!/#[^\s#]+/.test(clean)) return "в описании нет хештегов";
  if (/https?:\/\/|www\./i.test(clean)) {
    return "в описании есть ссылка — площадки за это занижают охват";
  }
  if (/\*\*|__/.test(clean)) return "в описании осталась markdown-разметка";
  return undefined;
}

/**
 * Описание поста по сценарию. Одна повторная попытка при проблеме, дальше —
 * то, что получилось: описание можно поправить руками, а вот отсутствие текста
 * ломает публикацию.
 */
export async function generateDescription(
  script: GeneratedScript,
  targetChars = config.descriptionChars,
): Promise<{ description: string; fixed?: string; fromFallback?: boolean }> {
  const messages = [
    { role: "system", content: buildPrompt(targetChars) },
    { role: "user", content: scriptForPrompt(script) },
  ];

  let description: string;
  try {
    description = await request(messages);
  } catch {
    return { description: fallbackDescription(script), fromFallback: true };
  }

  const problem = descriptionProblem(description);
  if (!problem) return { description };

  try {
    const retry = await request([
      ...messages,
      { role: "assistant", content: JSON.stringify({ description }) },
      {
        role: "user",
        content: `Перепиши описание: ${problem}. Формат ответа тот же.`,
      },
    ]);
    return { description: retry, fixed: problem };
  } catch {
    return { description, fixed: problem };
  }
}

async function request(
  messages: { role: string; content: string }[],
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter (описание) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter не вернул описание");
  const parsed = JSON.parse(content) as { description?: string };
  if (!parsed.description) throw new Error("В ответе нет поля description");
  // Ссылки-сноски веб-поиска попадают и сюда, но чистить описание целиком
  // нельзя: stripSources схлопывает пробелы, а в описании переводы строк —
  // это абзацы. Поэтому обрабатываем построчно.
  return parsed.description
    .split("\n")
    .map((line) => stripSources(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
