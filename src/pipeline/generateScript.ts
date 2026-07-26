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
- Последняя сцена — призыв к действию.
- Пиши на языке брифа пользователя.

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

export async function generateScript(
  brief: string,
  revision?: ScriptRevision,
): Promise<GeneratedScript> {
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
      `OpenRouter вернул ошибку ${response.status}: ${await response.text()}`,
    );
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

  return parsed;
}

/**
 * Сценарий с гарантированным хуком: если первая сцена не годится, просим
 * модель переписать именно её. Одна попытка — дальше отдаём как есть, чтобы
 * не жечь запросы в бесконечном цикле.
 */
export async function generateScriptWithHook(
  brief: string,
  revision?: ScriptRevision,
): Promise<{ script: GeneratedScript; hookFixed?: string }> {
  const script = await generateScript(brief, revision);
  const problem = hookProblem(script.scenes[0]);
  if (!problem) return { script };

  const fixed = await generateScript(brief, {
    previousScript: script,
    feedback:
      `Перепиши ТОЛЬКО первую сцену — ${problem}. ` +
      "Остальные сцены оставь дословно как есть. Хук должен сразу бить в " +
      "боль или интерес зрителя, без приветствий и вступлений.",
  });

  // Если и после правки хук слабый, берём лучший из двух: переписанный обычно
  // ближе к требованиям, но пустым результатом рисковать не будем.
  return {
    script: fixed.scenes.length > 0 ? fixed : script,
    hookFixed: problem,
  };
}
