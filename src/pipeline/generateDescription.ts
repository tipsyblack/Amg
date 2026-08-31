import { config } from "./config";
import type { GeneratedScript } from "./generateScript";
import { stripSources } from "./generateScript";

// Текст под ролик: то, что вставляется в описание поста в Reels, Shorts,
// TikTok и VK Клипах. Пишется по готовому сценарию — описание должно обещать
// ровно то, что в видео, иначе зритель уходит и алгоритмы это запоминают.

// Длина описания. 500 символов — жёсткий предел, а не пожелание: он задан
// требованием к посту, поэтому гарантируется не промптом, а обрезкой на выходе
// (enforceLimit). Меньше 350 — описание не работает на поиск и не объясняет,
// о чём ролик.
export const DESCRIPTION_MIN_CHARS = 350;
export const DESCRIPTION_MAX_CHARS = 500;

/**
 * Цель для промпта. Просить ровно предел бессмысленно — модель регулярно
 * перескакивает через него, и текст приходится резать. Держим цель ниже, а
 * значение из .env заодно загоняем в допустимые границы.
 */
export function targetLength(requested: number): number {
  const headroom = DESCRIPTION_MAX_CHARS - 50;
  return Math.min(Math.max(requested, DESCRIPTION_MIN_CHARS), headroom);
}

function buildPrompt(targetChars: number): string {
  return `Ты пишешь текст описания под короткое вертикальное видео (Instagram Reels, YouTube Shorts, TikTok, VK Клипы).

Отвечай СТРОГО валидным JSON без markdown-обёртки: {"description": string}

Требования к описанию:
- Длина примерно ${targetChars} символов, и ни в каком случае не больше ${DESCRIPTION_MAX_CHARS} — это жёсткий предел, текст длиннее будет обрезан. Минимум ${DESCRIPTION_MIN_CHARS}.
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
 * Приводит описание к пределу длины. Это последняя линия: сколько бы модель ни
 * написала, в чат уходит текст не длиннее DESCRIPTION_MAX_CHARS.
 *
 * Режем тело, а не хвост: хештеги стоят последней строкой и нужны для поиска,
 * поэтому их сохраняем целиком, а сокращаем то, что выше. Обрыв — по границе
 * слова, иначе текст кончается на половине слова.
 */
export function enforceLimit(
  text: string,
  max: number = DESCRIPTION_MAX_CHARS,
): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;

  const lines = clean.split("\n");
  const last = lines[lines.length - 1].trim();
  const tagsOnly = /^#[^\s#]+(?:\s+#[^\s#]+)*$/.test(last);

  let tail = tagsOnly ? `\n\n${last}` : "";
  let body = tagsOnly ? lines.slice(0, -1).join("\n").trim() : clean;
  // Если на тело почти ничего не остаётся, хештеги спасать нечем — режем всё
  // подряд, иначе получится строка из одних решёток.
  if (max - tail.length - 1 < 80) {
    tail = "";
    body = clean;
  }

  const cut = body.slice(0, max - tail.length - 1);
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${kept.replace(/[\s,.;:!?…—-]+$/u, "")}…${tail}`;
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
  return enforceLimit(text);
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
): Promise<{
  description: string;
  fixed?: string;
  fromFallback?: boolean;
  // Текст пришлось урезать до предела: модель не уложилась даже со второй
  // попытки. Показываем в чате — обрезанный хвост стоит перечитать глазами.
  trimmed?: boolean;
}> {
  const messages = [
    { role: "system", content: buildPrompt(targetLength(targetChars)) },
    { role: "user", content: scriptForPrompt(script) },
  ];

  // Предел длины гарантируем здесь, на выходе, а не надеемся на модель:
  // «до 500 символов» — требование к посту, и нарушить его нельзя ни при
  // сбое сети, ни когда модель проигнорировала промпт дважды.
  const done = (
    text: string,
    rest: { fixed?: string; fromFallback?: boolean } = {},
  ) => {
    const description = enforceLimit(text);
    return {
      description,
      ...rest,
      ...(description === text.trim() ? {} : { trimmed: true }),
    };
  };

  let description: string;
  try {
    description = await request(messages);
  } catch {
    return done(fallbackDescription(script), { fromFallback: true });
  }

  const problem = descriptionProblem(description);
  if (!problem) return done(description);

  try {
    const retry = await request([
      ...messages,
      { role: "assistant", content: JSON.stringify({ description }) },
      {
        role: "user",
        content: `Перепиши описание: ${problem}. Формат ответа тот же.`,
      },
    ]);
    return done(retry, { fixed: problem });
  } catch {
    return done(description, { fixed: problem });
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
