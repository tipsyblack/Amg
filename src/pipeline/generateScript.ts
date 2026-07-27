import { config } from "./config";

interface ScriptScene {
  caption: string;
  voiceoverText: string;
}

export interface GeneratedScript {
  title: string;
  scenes: ScriptScene[];
}

// Хук должен укладываться в 1-2 секунды речи — отсюда лимит слов.
const HOOK_MAX_WORDS = 12;

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
    re: /как\s+говорится|итак,?\s+поехали|начнём\s+с\s+того|сначала\s+мы\s|, да\?|прикинь/i,
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

// Бюджет слов на сцену считаем от лимита длины: речь идёт примерно в 2.5
// слова в секунду, и из этого времени часть уходит на паузы между сценами.
function buildSystemPrompt(): string {
  const { maxScenes, maxVideoSeconds } = config;
  const secondsPerScene = maxVideoSeconds / maxScenes;
  const wordsPerScene = Math.max(Math.floor(secondsPerScene * 2.2), 6);

  return `Ты — сценарист коротких вертикальных видео для соцсетей (Instagram Reels, YouTube Shorts, TikTok, VK Клипы).
Отвечай СТРОГО валидным JSON без markdown-обёртки и без пояснений, по схеме:
{"title": string, "scenes": [{"caption": string, "voiceoverText": string}]}

Правила:
- От 4 до ${maxScenes} сцен, но оптимально 5-8. Чем больше сцен, тем меньше
  слов на каждую: при ${maxScenes} сценах на приём остаётся ${wordsPerScene} слов,
  а в них полезного не скажешь — получится список названий. Лучше меньше сцен
  и в каждой законченная мысль.
- ГЛАВНОЕ ОГРАНИЧЕНИЕ: вся озвучка вместе должна укладываться в ${maxVideoSeconds} секунд.
  Поэтому чем больше сцен, тем короче реплики. При ${maxScenes} сценах — не больше
  ${wordsPerScene} слов на сцену. Лучше сделать меньше сцен, чем растянуть ролик.
- caption — короткий текст на экране (до 8 слов).
- voiceoverText — одна короткая фраза для озвучки этой сцены, разговорным тоном.
- Пиши на языке брифа пользователя.

ЭТО НЕ РЕКЛАМНЫЙ РОЛИК, А ПОЛЕЗНЫЙ. Зритель смотрит до конца ради пользы, а
не ради описания продукта. Структура строгая:
1) Первая сцена — хук (требования ниже).
2) Середина — ТОЛЬКО польза по теме: конкретные приёмы, порядок действий,
   названия инструментов и моделей, типичная ошибка и как её избежать,
   сравнение «до/после», неочевидный факт. Это ядро ролика.
3) Последняя сцена — и ТОЛЬКО она — про продукт: короткий призыв к действию.

Про продукт, бренд, бота, подписку, тарифы, промокоды и ссылки нельзя
упоминать ни в одной сцене, кроме последней. Ни намёком, ни «у нас это уже
есть». До финала зритель получает пользу, а не рекламу.

СЕРЕДИНА — ЭТО ПРИЁМЫ, А НЕ СПИСОК СЕРВИСОВ. Самая частая ошибка — превратить
ролик в перечисление названий:
  ПЛОХО: «Midjourney или Imagen 4 сделают раскадровку. Красота!»
  ПЛОХО: «GPT за 15 минут напишет бомбический сценарий»
  ХОРОШО: «Опиши кадр одной фразой и добавь "плоская векторная иллюстрация" —
  тогда стиль не поедет от кадра к кадру»
  ХОРОШО: «Проси не текст, а три варианта на выбор — первый почти всегда
  самый скучный»
Правила середины:
- В каждой сцене — одно действие, которое зритель может повторить сам: что
  сделать, что написать, в каком порядке, на что смотреть.
- Название инструмента допустимо, но само по себе сценой не является: без
  детали применения оно бесполезно. Не больше двух названий на весь ролик.
- Никакого пустого восторга: «красота», «чистый кайф», «бомбически», «легко
  и просто», «меняет дело», «в два клика», «вау».
- Никаких связок без содержания: «сначала мы идею в текст заносим», «как
  говорится», «итак, поехали», «да?».
- Никаких процентов, «в N раз» и «за N минут» — такие цифры выглядят как
  реклама и почти всегда выдуманы. Если не уверен в числе или дате, говори о
  приёме, а не о статистике: выдуманная цифра дороже, чем её отсутствие.

Тема должна быть актуальной: приёмы и задачи, которые обсуждают сейчас, а не
общие слова про «искусственный интеллект».

Ссылки, адреса сайтов, сноски и названия источников в текст не вставляй —
озвучка читается вслух, и адрес в ней звучит абсурдно.

ПЕРВАЯ СЦЕНА — ХУК. Это главное в ролике: в соцсетях зритель решает за
1-2 секунды, смотреть дальше или пролистнуть. Требования жёсткие:
- НИКАКИХ приветствий и представлений. «Привет», «Здравствуйте», «Ассаламу
  алейкум», «Друзья», «В этом видео расскажу» — запрещено: на них уходят те
  самые секунды, за которые зритель уходит.
- Сразу в суть: боль зрителя, неожиданное утверждение, вопрос в лоб или
  обещание результата.
- Не больше ${HOOK_MAX_WORDS} слов в озвучке хука. Короче — лучше.
- caption хука — до 5 слов, крупно и по делу.

Рабочие приёмы для хука: «Ты теряешь Х каждый день», «Это делают 9 из 10 —
и зря», «Хватит Х», «Что если Х займёт минуту?», «Я проверил Х — вот что
вышло».`;
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
 * Один запрос к OpenRouter. Веб-поиск подключается плагином: с ним модель
 * опирается на свежие материалы, а не только на свои знания — это и делает
 * темы актуальными. Если плагин недоступен на аккаунте, запрос повторяется
 * без него: лучше сценарий по памяти, чем никакого.
 */
async function requestScript(
  messages: { role: string; content: string }[],
  webSearch: boolean,
): Promise<ScriptResult> {
  const body: Record<string, unknown> = {
    model: config.openRouterModel,
    messages,
    response_format: { type: "json_object" },
  };
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
      const fallback = await requestScript(messages, false);
      return { ...fallback, webSearchUnavailable: true };
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

  const parsed = JSON.parse(content) as GeneratedScript;
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
): Promise<ScriptResult> {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: buildSystemPrompt() },
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
): Promise<CheckedScript> {
  const first = await generateScript(brief, revision);

  const problems = scriptProblems(first.script);
  if (problems.length === 0) return { ...first, fixes: [] };

  const instructions = FIX_INSTRUCTIONS.filter(({ key }) =>
    problems.some((p) => p.includes(key)),
  ).map(({ instruction }) => instruction);

  const fixed = await generateScript(brief, {
    previousScript: first.script,
    feedback: `${problems.join("; ")}. ${instructions.join(" ")} ` +
      "Остальные сцены оставь как есть.",
  });

  return {
    script: fixed.script.scenes.length > 0 ? fixed.script : first.script,
    webSearchUnavailable: first.webSearchUnavailable,
    fixes: problems,
  };
}
