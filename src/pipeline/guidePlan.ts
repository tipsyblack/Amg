import { config } from "./config";
import { extractJson } from "./extractJson";
import { MAX_SLIDE_WORDS, MIN_SLIDE_WORDS } from "./guide";
import { readSlang, slangPrompt } from "./slang";

/**
 * Помощь по сценарию гайда: покадровый план на заданную тему.
 *
 * Зачем отдельно от новостного сценариста. Тот придумывает и текст, и
 * картинку, а тут картинку снимает человек — у него на экране настоящий бот, и
 * никакая модель этого экрана не видела. Поэтому план не «сценарий, который
 * пойдёт в ролик», а ЗАГОТОВКА: на каждый кадр сказано, что снять и что
 * сказать, а решает человек.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, из-за которого промпт написан именно так: модель не
 * знает интерфейса и с удовольствием придумает кнопку «Создать шедевр». В
 * гайде выдуманная кнопка хуже, чем никакой гайд: зритель пойдёт её искать и
 * не найдёт. Поэтому названия кнопок разрешены только те, что человек назвал
 * сам в теме; всё остальное описывается действием.
 */

export interface PlanSlide {
  /** Что снять на экране. */
  screen: string;
  /** Что сказать на этом кадре — уйдёт в озвучку как есть, если принять план. */
  line: string;
}

export const DEFAULT_PLAN_SLIDES = 7;
export const MAX_PLAN_SLIDES = 15;

export function buildPlanPrompt(
  topic: string,
  count: number,
  context?: string,
): string {
  return `Ты помогаешь сделать ролик-инструкцию по телеграм-боту. Нужен
ПОКАДРОВЫЙ план: на каждый кадр — что показать на экране и что сказать вслух.

Отвечай СТРОГО валидным JSON без markdown-обёртки:
{"slides": [{"screen": string, "line": string}]}

Тема: ${topic}
${context ? `\nЧто это за продукт: ${context}\n` : ""}
Кадров: ${count}.

ЧТО ТАКОЕ КАДР. Один кадр — один шаг, который зритель может повторить у себя.
Порядок кадров — порядок действий. Кадр без действия («вступление», «а сейчас
разберём») не нужен.

screen — что снять на экране, одной фразой: какой это экран и что на нём
главное. Это подсказка человеку, который пойдёт делать скриншот.
- НЕ ВЫДУМЫВАЙ НАЗВАНИЯ КНОПОК, команд и пунктов меню. Ты не видел этот бот.
  Пиши действие: «экран после отправки команды», «список с выбором», «кнопка
  подтверждения внизу». Точные названия можно брать ТОЛЬКО из темы выше.
- Один экран на кадр. Если шаг требует двух экранов — это два кадра.

line — реплика голосом ведущего, ${MIN_SLIDE_WORDS}-${MAX_SLIDE_WORDS} слов:
- на «ты», разговорно, как объясняют другу, а не как пишут справку;
- говори, ЧТО СДЕЛАТЬ и ЧТО ПОЛУЧИТСЯ, а не описывай картинку словами —
  картинку зритель и так видит;
- никаких «в этом видео», «давайте рассмотрим», «переходим к следующему шагу»;
- числа и названия — только те, что есть в теме.

ПЕРВЫЙ КАДР — зачем это смотреть: результат, который получится в конце, или
боль, которую это снимает. Без него досматривать незачем.
ПОСЛЕДНИЙ КАДР — что сделать прямо сейчас. Одно действие, без «подписывайтесь
и ставьте лайки».
${slangPrompt(readSlang())}`;
}

/** Разбор ответа модели. Терпимый: план — это черновик для человека. */
export function parsePlan(raw: string): PlanSlide[] {
  let data: { slides?: { screen?: string; line?: string }[] };
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(
      "Не разобрал ответ модели как план. Попробуйте ещё раз — или другую модель: /model",
    );
  }
  const slides = (data.slides ?? [])
    .map((slide) => ({
      screen: (slide.screen ?? "").trim(),
      line: (slide.line ?? "").trim(),
    }))
    .filter((slide) => slide.line);
  if (slides.length === 0) {
    throw new Error("Модель вернула пустой план — попробуйте переформулировать тему.");
  }
  return slides;
}

export async function requestGuidePlan(
  topic: string,
  count: number,
  context?: string,
  model: string = config.openRouterModel,
): Promise<PlanSlide[]> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildPlanPrompt(topic, count, context) },
        { role: "user", content: topic },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter вернул ошибку ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return parsePlan(data.choices?.[0]?.message?.content ?? "");
}

/** План для чата: по нему человек идёт снимать экраны. */
export function formatPlan(slides: PlanSlide[]): string {
  return slides
    .map(
      (slide, i) =>
        `${i + 1}. 📸 ${slide.screen || "экран на ваш выбор"}\n   🎙 ${slide.line}`,
    )
    .join("\n\n");
}

/**
 * Сколько слов в репликах плана вышло за рамки. Проверяется тем же мерилом,
 * что и слайды: реплика плана и есть будущая реплика слайда.
 */
export function planWarnings(slides: PlanSlide[]): string[] {
  const warnings: string[] = [];
  slides.forEach((slide, i) => {
    const words = slide.line.split(/\s+/).filter(Boolean).length;
    if (words > MAX_SLIDE_WORDS) {
      warnings.push(`кадр ${i + 1}: реплика длинная (${words} слов) — стоит разбить`);
    }
    if (words < MIN_SLIDE_WORDS) {
      warnings.push(`кадр ${i + 1}: реплика короткая (${words} слов) — кадр мелькнёт`);
    }
    if (!slide.screen) {
      warnings.push(`кадр ${i + 1}: не сказано, что снять`);
    }
  });
  return warnings;
}

/** Разбор аргумента команды: «6 как собрать ролик» или просто тема. */
export function parsePlanArgs(
  arg: string,
): { topic: string; count: number } | { error: string } {
  const text = arg.trim();
  if (!text) {
    return {
      error:
        "О чём гайд? Например: /plan как собрать первый ролик\n" +
        `Сколько кадров — числом впереди: /plan 5 как поменять голос ` +
        `(по умолчанию ${DEFAULT_PLAN_SLIDES}, не больше ${MAX_PLAN_SLIDES}).`,
    };
  }
  const match = text.match(/^(\d{1,2})\s+(.+)$/s);
  if (!match) return { topic: text, count: DEFAULT_PLAN_SLIDES };

  const count = Number(match[1]);
  if (count < 2 || count > MAX_PLAN_SLIDES) {
    return {
      error: `Кадров должно быть от 2 до ${MAX_PLAN_SLIDES}. Вы просили ${count}.`,
    };
  }
  return { topic: match[2].trim(), count };
}
