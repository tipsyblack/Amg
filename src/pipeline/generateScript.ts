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
    `реклама попала в середину ролика (${found.slice(0, 3).join("; ")}), ` +
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
- От 4 до ${maxScenes} сцен. Больше сцен — быстрее ритм; выбирай столько, сколько нужно теме.
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

Пиши конкретно. «Нейросеть поможет с текстом» — плохо, это ни о чём.
«Попроси переписать текст в трёх тонах и выбери лучший» — хорошо: это можно
сделать сразу после просмотра. В каждой сцене середины должна быть деталь,
которую зритель раньше мог не знать.

Тема должна быть актуальной: свежие модели и инструменты, приёмы, которые
обсуждают сейчас, реальные задачи, а не общие слова про «искусственный
интеллект». Но факты и цифры не выдумывай: если не уверен в числе или дате —
говори о приёме, а не о статистике. Выдуманная цифра дороже, чем её
отсутствие.

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

  return { script: parsed };
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
 * Сценарий с проверками качества: обязательный хук и реклама только в финале.
 * Найденные проблемы уходят модели одной правкой — ровно одна попытка, чтобы
 * не жечь запросы в цикле. Даже если правка не помогла, сценарий отдаётся:
 * пустой результат хуже несовершенного.
 */
export async function generateCheckedScript(
  brief: string,
  revision?: ScriptRevision,
): Promise<CheckedScript> {
  const first = await generateScript(brief, revision);

  const problems = [
    hookProblem(first.script.scenes[0]),
    promoProblem(first.script),
  ].filter((p): p is string => Boolean(p));
  if (problems.length === 0) return { ...first, fixes: [] };

  const instructions = [
    problems.some((p) => p.includes("хук") || p.includes("подпись хука"))
      ? "Перепиши первую сцену: хук должен сразу бить в боль или интерес " +
        "зрителя, без приветствий и вступлений."
      : undefined,
    problems.some((p) => p.includes("реклама"))
      ? "Убери упоминания продукта, бота, подписки и призывы к действию из " +
        "всех сцен, кроме последней — замени их конкретной пользой по теме."
      : undefined,
  ].filter(Boolean);

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
