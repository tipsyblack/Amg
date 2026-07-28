import { config } from "./config";

interface ScriptScene {
  caption: string;
  voiceoverText: string;
  // Объект, который появляется поверх картинки сцены, не заменяя её.
  // Необязательно: нет объекта — сцена как раньше.
  overlay?: {
    // Что нарисовать: один предмет, коротко.
    object: string;
    // На каком слове реплики он должен появиться.
    word?: string;
  };
}

export interface GeneratedScript {
  title: string;
  scenes: ScriptScene[];
}

// Хук — короткая новость плюс, при желании, фраза-зацепка («сейчас расскажу,
// смотри»). В сумме это укладывается в пару фраз; жёсткие 12 слов браковали
// нормальные новостные хуки, поэтому лимит по факту — 20.
const HOOK_MAX_WORDS = 20;

/**
 * Вычищает из текста ссылки и сноски.
 *
 * С включённым веб-поиском модель дописывает к фразам источники — вида
 * `[mashagpt.ru](https://…/blog/…)`. В подписи это мусор, а в озвучке
 * катастрофа: синтезатор честно читает адрес вслух. Просьбы в промпте
 * недостаточно, поэтому чистим механически.
 */
export function stripSources(text: string): string {
  return (
    text
      // [подпись](адрес) → подпись, дальше подпись-домен уберётся ниже
      .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, "$1")
      .replace(/\((?:https?:\/\/|www\.)[^)]*\)/gi, " ")
      .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
      // Голый домен: «mashagpt.ru», «example.com».
      .replace(
        /\b(?:[a-z0-9-]+\.)+(?:ru|com|net|org|io|ai|me|dev|app|co|info|su|рф)\b/gi,
        " ",
      )
      .replace(/\[\d+\]|\[\s*\]|\(\s*\)/g, " ")
      // Осколки пунктуации после вырезанного: « . », «..», « ,».
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:…])/g, "$1")
      .replace(/([.!?])(?:\s*\1)+/g, "$1")
      .trim()
  );
}

function sanitizeScript(script: GeneratedScript): GeneratedScript {
  return {
    title: stripSources(script.title ?? ""),
    scenes: script.scenes.map((scene) => ({
      caption: stripSources(scene.caption ?? ""),
      voiceoverText: stripSources(scene.voiceoverText ?? ""),
    })),
  };
}

// Приветствия и «в этом видео» в начале — главный убийца удержания, поэтому
// проверяем их отдельно от промпта: модель про запрет иногда забывает.
const WEAK_HOOK_OPENINGS =
  /^\s*(привет|здравствуй|здорово|салам|ассаламу|добрый\s+(день|вечер|утро)|доброе\s+утро|друзья|дорогие|уважаемые|итак|hello|hi\b|hey|в\s+этом\s+(видео|ролике)|сегодня\s+(я\s+)?(расскажу|поговорим)|меня\s+зовут)/i;

/**
 * Проверяет, годится ли первая сцена в качестве хука. Возвращает причину
 * отказа — её же отправляем модели, чтобы она переписала именно хук.
 */
export function hookProblem(scene: ScriptScene): string | undefined {
  const voiceover = scene.voiceoverText.trim();
  if (WEAK_HOOK_OPENINGS.test(voiceover)) {
    return "хук начинается с приветствия или с «в этом видео» — это отпугивает зрителя";
  }
  const words = voiceover.split(/\s+/).filter(Boolean).length;
  if (words > HOOK_MAX_WORDS) {
    return `в хуке ${words} слов, нужно не больше ${HOOK_MAX_WORDS}`;
  }
  if (scene.caption.split(/\s+/).filter(Boolean).length > 5) {
    return "подпись хука длиннее 5 слов";
  }
  return undefined;
}

// Рекламные обороты. Модель, получив бриф про продукт, легко скатывается в
// «наш бот умеет вот это» с первой же сцены — а зритель ради такого не
// смотрит. Ищем их во всех сценах, кроме последней: там призыв к действию
// уместен и обязателен.
// Внимание к \w: в JS он не включает кириллицу, поэтому окончания слов
// перебираются классом [а-яё] — иначе «по ссылке в описании» не находится.
const PROMO_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /наш[а-яё]*\s+(бот|сервис|канал|приложени|платформ|нейросет)/i, what: "«наш бот/сервис»" },
  { re: /у\s+нас\s+(есть|можно|уже)/i, what: "«у нас есть»" },
  { re: /подписк|подпишись|подписыва/i, what: "подписка" },
  { re: /тариф|промокод|оформ(и|ите|ить)\s|пробн[а-яё]+\s+период/i, what: "тарифы или промокод" },
  { re: /ссылк[а-яё]*\s+(в|под)\s+(описании|шапке|профиле|видео)/i, what: "ссылка в описании" },
  { re: /переходи|перейди|жми|жмите|нажми|регистрируйся|зарегистрир/i, what: "призыв к действию" },
  { re: /бесплатн[а-яё]*\s+(доступ|пробуй|попробуй)/i, what: "«бесплатный доступ»" },
];

// Пустой восторг и связки без содержания. С ними ролик звучит бодро, но
// зритель не узнаёт ничего — именно так выглядит «сценарий ни о чём».
const FILLER_PATTERNS: { re: RegExp; what: string }[] = [
  {
    re: /красот[аы]!|чист(ый|ое)\s+кайф|бомбическ|это\s+магия|огонь!|вау|кайф!|сказка|мечта!/i,
    what: "пустой восторг",
  },
  {
    re: /легко\s+и\s+просто|проще\s+некуда|меняют?\s+дело|в\s+два\s+клика|на\s+раз-два|без\s+проблем!/i,
    what: "штамп вместо пользы",
  },
  {
    re: /как\s+говорится|итак,?\s+поехали|начнём\s+с\s+того|сначала\s+мы\s|, да\?/i,
    what: "связка без содержания",
  },
];

// Проценты, «в N раз» и «за N минут» в ролике почти всегда выдуманы, а звучат
// как реклама. Границу слова здесь нельзя писать через \b: в JS он опирается
// на латинский \w, и перед кириллической буквой границы просто нет — нужен
// явный запрет предыдущей буквы. Числа считаем и цифрами, и словами: «в пять
// раз быстрее» — такая же непроверяемая цифра, как «в 5 раз».
const NUMBER_WORD =
  "\\d+|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять";
const FAKE_STATS = new RegExp(
  `\\d+\\s?%|(?<![а-яё])в\\s+(?:${NUMBER_WORD})\\s+раз|(?<![а-яё])за\\s+(?:${NUMBER_WORD})\\s+(?:минут|секунд|час)`,
  "i",
);

// Латинское название с заглавной: Midjourney, GPT-5.4, Sora 2, ElevenLabs.
const TOOL_NAME = /\b[A-Z][A-Za-z0-9]+(?:[.\-]\d+(?:\.\d+)?)?\b/;
const MAX_TOOL_SCENES = 2;

/**
 * Ролик не должен превращаться в перечисление инструментов: «Midjourney
 * сделает раскадровку», «Suno напишет музыку» — это список названий, из
 * которого зритель не выносит ни одного действия.
 */
export function toolListProblem(script: GeneratedScript): string | undefined {
  // Хук и финал не считаем: там название бывает уместно.
  const body = script.scenes.slice(1, -1);
  if (body.length < 3) return undefined;
  const named = body.filter((scene) => TOOL_NAME.test(scene.caption)).length;
  if (named > MAX_TOOL_SCENES && named / body.length > 0.4) {
    return (
      `${named} из ${body.length} сцен середины — это названия инструментов, ` +
      "а не польза: нужно показать, что именно делать, а не перечислять сервисы"
    );
  }
  return undefined;
}

/**
 * Ищет пустые фразы и выдуманные цифры в середине ролика.
 */
export function fillerProblem(script: GeneratedScript): string | undefined {
  const found: string[] = [];
  script.scenes.slice(0, -1).forEach((scene, index) => {
    const text = `${scene.caption} ${scene.voiceoverText}`;
    for (const { re, what } of FILLER_PATTERNS) {
      if (re.test(text)) found.push(`сцена ${index + 1} — ${what}`);
    }
    if (FAKE_STATS.test(text)) {
      found.push(`сцена ${index + 1} — непроверяемая цифра`);
    }
  });
  if (found.length === 0) return undefined;
  return `в сценах есть вода вместо конкретики (${found.slice(0, 5).join("; ")})`;
}

/**
 * Проверяет, что реклама осталась только в финале. Возвращает причину отказа —
 * её же отправляем модели на переписывание.
 */
export function promoProblem(script: GeneratedScript): string | undefined {
  const body = script.scenes.slice(0, -1);
  const found: string[] = [];
  body.forEach((scene, index) => {
    const text = `${scene.caption} ${scene.voiceoverText}`;
    for (const { re, what } of PROMO_PATTERNS) {
      if (re.test(text)) found.push(`сцена ${index + 1} — ${what}`);
    }
  });
  if (found.length === 0) return undefined;
  return (
    `реклама попала в середину ролика (${found.slice(0, 5).join("; ")}), ` +
    "а продукт должен упоминаться только в последней сцене"
  );
}

// Речь синтезатора идёт примерно 2.4 слова в секунду — отсюда общий бюджет
// слов на ролик. Считаем его целиком, а не на сцену: сцены бывают разной
// длины, и жёсткая норма на каждую как раз и превращала сценарий в телеграф.
const WORDS_PER_SECOND = 2.4;

// Эталон тона и плотности: присланный заказчиком ролик про дата-центры в
// космосе. Модель по описанию правил всё равно скатывается то в телеграф, то в
// перечисление сервисов, а по живому примеру держит жанр гораздо лучше.
// Утверждение «не зря он первый триллионер» из оригинала убрано намеренно:
// это непроверяемый факт, и учить модель такому не стоит.
const STYLE_EXAMPLE = JSON.stringify({
  title: "Дата-центры в космосе",
  scenes: [
    {
      caption: "ДАТА-ЦЕНТРЫ В КОСМОСЕ",
      voiceoverText:
        "Илон Маск строит дата-центры для своего ИИ в космосе. Ему чё, мало места, что ли? Сейчас расскажу, смотри.",
    },
    {
      caption: "ПАЛКА О ДВУХ КОНЦАХ",
      voiceoverText:
        "Серверы для искусственного интеллекта занимают много места и требуют много воды. На Земле выходит палка о двух концах: либо дорогая земля, либо дорогая вода. Маск пошёл другим путём и хочет вывести серверы на орбиту своими ракетами.",
    },
    {
      caption: "МИНУС 270 — И ВСЁ РАВНО ГРЕЮТСЯ",
      voiceoverText:
        "Но как быть без воды? Прикол в том, что в космосе минус 270, а серверы всё равно перегреются: в вакууме тепло уносить нечем. Поэтому размером с полспутника будет радиатор, который сбрасывает тепло в открытый космос инфракрасным излучением. А Солнце там светит всегда, и атмосфера его не ослабляет — энергии от панелей хоть отбавляй.",
    },
    {
      caption: "СЧИТАТЬ ОН УМЕЕТ",
      voiceoverText: "Илон — мужик с мозгами и деньги считать умеет.",
    },
    {
      caption: "ЖМИ ССЫЛКУ В ПРОФИЛЕ",
      voiceoverText:
        "Ещё больше такого про ИИ — в профиле, подпишись. А по ссылке в шапке можешь затестить любую нейросеть через нашего бота бесплатно.",
    },
  ],
});

function buildSystemPrompt(maxVideoSeconds: number): string {
  const { maxScenes } = config;
  const totalWords = Math.floor(maxVideoSeconds * WORDS_PER_SECOND);

  return `Ты — сценарист коротких вертикальных видео для соцсетей (Instagram Reels, YouTube Shorts, TikTok, VK Клипы).
Отвечай СТРОГО валидным JSON без markdown-обёртки и без пояснений, по схеме:
{"title": string, "scenes": [{"caption": string, "voiceoverText": string, "overlay": {"object": string, "word": string} | null}]}

ЖАНР: не реклама и не инструкция, а «рассказываю интересное». Зритель должен
узнать что-то, чего не знал, и дослушать из любопытства. Хорошая тема — свежая
новость, неожиданный факт, разбор «как это вообще работает», неочевидное
последствие. Плохая тема — пересказ возможностей продукта.

СТРУКТУРА:
1) Хук — новость или факт, от которого хочется узнать продолжение
   (требования ниже).
2) Середина — сама история: в чём была проблема или тупик, как её обходят,
   за счёт чего это работает. Обязательна конкретная механика: что мешало,
   какое решение нашли, какая деталь всё меняет. Можно короткое личное
   замечание про героя истории.
3) Последняя сцена — и ТОЛЬКО она — призыв к действию и упоминание продукта.

Про продукт, бренд, бота, подписку, тарифы, промокоды и ссылки нельзя
упоминать ни в одной сцене, кроме последней. Ни намёком, ни «у нас это уже
есть». До финала зритель получает историю, а не рекламу.

Объём и ритм:
- От 4 до ${maxScenes} сцен, но оптимально 5-7.
- Всего в ролике не больше ${totalWords} слов озвучки — это ${maxVideoSeconds} секунд речи.
  Распределяй неравномерно: хук короткий, сцены-объяснения по 25-45 слов,
  реплика-реакция может быть в одну строку.
- НЕ пиши телеграфом: сцена из четырёх слов ничего не объясняет. Лучше пять
  сцен с законченными мыслями, чем двенадцать обрывков.
- caption — короткая подпись сцены (до 8 слов). На экране она НЕ показывается:
  весь текст в кадре несут субтитры по словам. Подпись нужна как название
  сцены — по ней человек согласовывает сценарий и понимает, о чём кадр.
- Пиши на языке брифа пользователя.

ПОЯВЛЯЮЩИЙСЯ ОБЪЕКТ (поле overlay). Картинка сцены не меняется, но в момент,
когда ты называешь что-то конкретное, этот предмет может появиться в кадре
поверх неё. Правила:
- object — ОДИН предмет, названный коротко и предметно: «спутниковый радиатор
  с рёбрами», «монета», «красный крестик», «стопка счетов». Не сцена, не
  действие, не персонаж.
- word — слово из voiceoverText этой же сцены, на котором предмет появляется.
  Пиши его так, как оно стоит в реплике.
- overlay нужен не каждой сцене: ставь null там, где называть нечего. Хорошо,
  когда объект есть примерно в половине сцен.
- Персонажа, фон и надписи в object не описывай — только предмет.

ТОН: живой разговорный, на «ты», с риторическими вопросами и обращением к
зрителю («смотри», «прикол в том», «затестить»). Сленг уместен. Но живой тон —
это конкретика, сказанная по-человечески, а не восторг вместо содержания.

ЧЕГО НЕЛЬЗЯ:
- Превращать ролик в перечисление сервисов: «Midjourney сделает раскадровку,
  Suno напишет музыку, ElevenLabs озвучит» — это список названий, из которого
  зритель не выносит ничего. Не больше двух названий на весь ролик, и только
  вместе с объяснением или деталью.
- Пустой восторг: «красота», «чистый кайф», «бомбически», «легко и просто»,
  «меняет дело», «в два клика», «вау».
- Связки без содержания: «сначала мы идею в текст заносим», «как говорится»,
  «итак, поехали».
- Проценты, «в N раз», «за N минут» — такие цифры выглядят как реклама и
  почти всегда выдуманы. Цифры из физики и техники (минус 270, размер
  радиатора, вес, расстояние) — наоборот, украшают: они и есть суть истории.
  Но если не уверен в числе или дате — не выдумывай, скажи без числа.
- Ссылки, адреса сайтов, сноски и названия источников в тексте — озвучка
  читается вслух, и адрес в ней звучит абсурдно.

ПЕРВАЯ СЦЕНА — ХУК. В соцсетях зритель решает за 1-2 секунды, смотреть дальше
или пролистнуть:
- НИКАКИХ приветствий и представлений. «Привет», «Здравствуйте», «Ассаламу
  алейкум», «Друзья», «В этом видео расскажу» — запрещено.
- Сразу факт или новость, желательно с вопросом-подначкой: «ему чё, мало
  места, что ли?». Можно короткую вторую фразу-зацепку («сейчас расскажу,
  смотри»).
- Не больше ${HOOK_MAX_WORDS} слов всего, и первая фраза — самая короткая.
- caption хука — до 5 слов.

Приёмы для хука: неожиданное действие известного человека или компании,
«оказывается, Х работает не так», «Х запретили, и вот почему», «Ты платишь за
Х, хотя это уже бесплатно».

ПРИМЕР РОЛИКА В НУЖНОМ ЖАНРЕ, ТОНЕ И ПЛОТНОСТИ (тема другая — ориентируйся на
подачу, а не на содержание):
${STYLE_EXAMPLE}`;
}

export interface ScriptRevision {
  // Предыдущая версия сценария и замечания пользователя — для цикла правок.
  previousScript: GeneratedScript;
  feedback: string;
}

export interface ScriptResult {
  script: GeneratedScript;
  // Веб-поиск запрошен, но OpenRouter его не выполнил: сценарий написан по
  // памяти модели, без свежих данных. Об этом стоит сказать вслух.
  webSearchUnavailable?: boolean;
}

/**
 * Достаёт JSON из ответа модели.
 *
 * `response_format` — параметр из мира OpenAI, и надёжных подтверждений, что
 * OpenRouter переводит его в нативный `output_config` для моделей Claude, нет.
 * Если он молча игнорируется, модель охотно оборачивает JSON в ```-блок или
 * приписывает фразу до него — и голый `JSON.parse` на этом падает. Поэтому
 * снимаем обёртку сами и берём текст от первой `{` до последней `}`.
 */
export function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : content).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}

/**
 * Один запрос к OpenRouter. Веб-поиск подключается плагином: с ним модель
 * опирается на свежие материалы, а не только на свои знания — это и делает
 * темы актуальными. Если плагин недоступен на аккаунте, запрос повторяется
 * без него: лучше сценарий по памяти, чем никакого. Точно так же повторяем
 * без `response_format`, если модель его не принимает — формат мы всё равно
 * задаём в промпте, а JSON достаём разбором.
 */
async function requestScript(
  messages: { role: string; content: string }[],
  webSearch: boolean,
  jsonMode: boolean = true,
): Promise<ScriptResult> {
  const body: Record<string, unknown> = {
    model: config.openRouterModel,
    messages,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (webSearch) {
    body.plugins = [
      { id: "web", max_results: config.scriptWebSearchResults },
    ];
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    if (webSearch) {
      // Плагин мог не подойти модели или тарифу — повторяем без него.
      const fallback = await requestScript(messages, false, jsonMode);
      return { ...fallback, webSearchUnavailable: true };
    }
    if (jsonMode) {
      // Модель не принимает response_format — она не единственная такая.
      // Формат ответа описан в системном промпте, так что без параметра
      // сценарий получится тоже.
      return requestScript(messages, false, false);
    }
    throw new Error(`OpenRouter вернул ошибку ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter не вернул содержимое ответа");
  }

  let parsed: GeneratedScript;
  try {
    parsed = JSON.parse(extractJson(content)) as GeneratedScript;
  } catch {
    throw new Error(
      `Модель ${config.openRouterModel} вернула не JSON: ${content.slice(0, 200)}`,
    );
  }
  if (!parsed.scenes?.length) {
    throw new Error("Сгенерированный сценарий не содержит сцен");
  }

  // Модель может увлечься и выдать больше сцен, чем разрешено: обрезаем,
  // сохраняя последнюю — в ней призыв к действию.
  if (parsed.scenes.length > config.maxScenes) {
    const kept = parsed.scenes.slice(0, config.maxScenes - 1);
    parsed.scenes = [...kept, parsed.scenes[parsed.scenes.length - 1]];
  }

  return { script: sanitizeScript(parsed) };
}

export async function generateScript(
  brief: string,
  revision?: ScriptRevision,
  maxVideoSeconds: number = config.maxVideoSeconds,
): Promise<ScriptResult> {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: buildSystemPrompt(maxVideoSeconds) },
    { role: "user", content: brief },
  ];
  if (revision) {
    messages.push(
      { role: "assistant", content: JSON.stringify(revision.previousScript) },
      {
        role: "user",
        content: `Перепиши сценарий с учётом замечаний, сохранив формат ответа: ${revision.feedback}`,
      },
    );
  }

  // При правках свежие материалы уже не нужны: тема выбрана, идёт доводка.
  return requestScript(messages, config.scriptWebSearch && !revision);
}

export interface CheckedScript extends ScriptResult {
  // Что бот переписал автоматически — показываем в чате, чтобы правки не
  // выглядели необъяснимой сменой текста.
  fixes: string[];
}

/**
 * Все проверки сценария: хук, реклама только в финале, отсутствие
 * перечисления сервисов и воды. Возвращает список проблем — он же уходит
 * модели на правку и показывается в чате.
 */
export function scriptProblems(script: GeneratedScript): string[] {
  return [
    hookProblem(script.scenes[0]),
    promoProblem(script),
    toolListProblem(script),
    fillerProblem(script),
  ].filter((p): p is string => Boolean(p));
}

// Что просить у модели по каждой найденной проблеме. Ключ ищется в тексте
// причины, поэтому формулировки причин и ключи менять надо вместе.
const FIX_INSTRUCTIONS: { key: string; instruction: string }[] = [
  {
    key: "хук",
    instruction:
      "Перепиши первую сцену: хук должен сразу бить в боль или интерес " +
      "зрителя, без приветствий и вступлений.",
  },
  {
    key: "реклама",
    instruction:
      "Убери упоминания продукта, бота, подписки и призывы к действию из " +
      "всех сцен, кроме последней — замени их конкретной пользой по теме.",
  },
  {
    key: "названия инструментов",
    instruction:
      "Замени перечисление сервисов приёмами: в каждой сцене середины — одно " +
      "действие, которое зритель может повторить сам (что сделать, что " +
      "написать, на что смотреть). Названий инструментов оставь не больше двух " +
      "на весь ролик, и только вместе с деталью применения.",
  },
  {
    key: "вода вместо конкретики",
    instruction:
      "Убери пустой восторг, штампы, связки без содержания и непроверяемые " +
      "цифры — вместо них дай конкретику, которую можно применить сразу.",
  },
];

/**
 * Сценарий с проверками качества. Найденные проблемы уходят модели одной
 * правкой — ровно одна попытка, чтобы не жечь запросы в цикле. Даже если
 * правка не помогла, сценарий отдаётся: пустой результат хуже несовершенного.
 */
export async function generateCheckedScript(
  brief: string,
  revision?: ScriptRevision,
  maxVideoSeconds?: number,
): Promise<CheckedScript> {
  const first = await generateScript(brief, revision, maxVideoSeconds);

  const problems = scriptProblems(first.script);
  if (problems.length === 0) return { ...first, fixes: [] };

  const instructions = FIX_INSTRUCTIONS.filter(({ key }) =>
    problems.some((p) => p.includes(key)),
  ).map(({ instruction }) => instruction);

  const fixed = await generateScript(
    brief,
    {
      previousScript: first.script,
      feedback: `${problems.join("; ")}. ${instructions.join(" ")} ` +
        "Остальные сцены оставь как есть.",
    },
    maxVideoSeconds,
  );

  return {
    script: fixed.script.scenes.length > 0 ? fixed.script : first.script,
    webSearchUnavailable: first.webSearchUnavailable,
    fixes: problems,
  };
}
