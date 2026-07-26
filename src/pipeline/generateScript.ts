import { config } from "./config";

interface ScriptScene {
  caption: string;
  voiceoverText: string;
}

export interface GeneratedScript {
  title: string;
  scenes: ScriptScene[];
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
- Первая сцена — цепляющий хук, последняя — призыв к действию.
- Пиши на языке брифа пользователя.`;
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
