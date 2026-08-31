import { config } from "./config";
import { extractJson } from "./extractJson";

/**
 * Где на кадре кнопка, о которой идёт речь.
 *
 * ЗАЧЕМ. Подсказку «нажми сюда» рисуем мы сами, по координате. Координату
 * можно указать пометкой в реплике, но в настоящем гайде кнопки каждый раз в
 * разных местах, и писать пометку к каждому слайду — это ровно та ручная
 * работа, ради избавления от которой всё и делается. Поэтому спрашиваем у
 * модели, которая УМЕЕТ СМОТРЕТЬ: вот кадр, вот реплика — где тут то, о чём
 * говорят?
 *
 * СМОТРИМ НА ПЕРЕРИСОВАННЫЙ КАДР, А НЕ НА ИСХОДНЫЙ СКРИНШОТ. Промпт просит
 * сохранить расположение, но модель не обязана слушаться дословно: она может
 * сместить блок, обрезать край, перекомпоновать. Координата, снятая с
 * оригинала, показывала бы тогда в пустоту. Меряем ровно то изображение,
 * которое увидит зритель.
 *
 * ЧЕСТНОСТЬ ВАЖНЕЕ ПОЛНОТЫ. Модель обязана сказать «не нашёл», если на кадре
 * нечего нажимать или речь не про нажатие. Уверенный курсор, показывающий не
 * туда, хуже, чем курсор в умолчании: зритель пойдёт искать кнопку там, где её
 * нет, и решит, что инструкция врёт.
 */

export interface TapTarget {
  xPercent: number;
  yPercent: number;
  /** Что модель там увидела — уходит в чат, чтобы промах было видно сразу. */
  what: string;
}

export function buildFindPrompt(narration: string): string {
  return `На картинке — кадр из видеоинструкции по телеграм-боту. Это
перерисованный в мультяшном стиле скриншот интерфейса.

Реплика, которая звучит на этом кадре: «${narration}»

Найди на КАРТИНКЕ элемент, на который зритель должен нажать по этой реплике:
кнопку, пункт меню, поле ввода, команду. Ответь СТРОГО валидным JSON без
markdown-обёртки:

{"found": true, "x": число, "y": число, "what": "что это"}

- x и y — центр элемента В ПРОЦЕНТАХ от размера картинки: x=0 левый край,
  x=100 правый, y=0 верх, y=100 низ. Целые числа.
- what — коротко, что это за элемент: «кнопка Собрать видео», «поле ввода
  внизу», «команда /new в сообщении».

ЕСЛИ НАЖИМАТЬ НЕЧЕГО — так и ответь: {"found": false, "what": "почему"}.
Это нормальный ответ, и он лучше выдуманного. Нечего нажимать, когда:
- реплика ничего не предлагает нажать (показывает результат, объясняет);
- на кадре нет ни кнопок, ни полей, ни команд;
- непонятно, о каком именно элементе речь, а их несколько.

Не угадывай. Курсор, показывающий не туда, хуже, чем никакого курсора:
зритель пойдёт искать кнопку там, где её нет.`;
}

/** Разбор ответа. Отдельно, чтобы проверялось без сети. */
export function parseFindResult(raw: string): TapTarget | undefined {
  let data: { found?: boolean; x?: number; y?: number; what?: string };
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return undefined;
  }
  if (data.found === false) return undefined;

  const x = Number(data.x);
  const y = Number(data.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  // Координаты за пределами кадра — признак того, что модель отвечала наугад
  // или в других единицах. Такому ответу верить нельзя.
  if (x < 0 || x > 100 || y < 0 || y > 100) return undefined;
  // Ровно по краю кнопок не бывает: там рамка карточки.
  if (x < 3 || x > 97 || y < 3 || y > 97) return undefined;

  return {
    xPercent: Math.round(x),
    yPercent: Math.round(y),
    what: (data.what ?? "").trim() || "элемент интерфейса",
  };
}

/**
 * Спрашивает у модели со зрением, куда показывать. Возвращает undefined, если
 * нажимать нечего или ответ не годится — решение «тогда рисуем по умолчанию»
 * принимается выше, там же, где об этом сообщают человеку.
 *
 * Ничего не бросает по сети: подсказка — украшение поверх готового кадра, и
 * ронять из-за неё слайд, за который уже заплачено, нельзя.
 */
export async function findTapTarget(
  imageUrl: string,
  narration: string,
  model: string = config.openRouterModel,
): Promise<TapTarget | undefined> {
  try {
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
          {
            role: "user",
            content: [
              { type: "text", text: buildFindPrompt(narration) },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return parseFindResult(data.choices?.[0]?.message?.content ?? "");
  } catch {
    return undefined;
  }
}
