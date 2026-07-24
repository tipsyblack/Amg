import { config } from "./config";

interface ScriptScene {
  caption: string;
  voiceoverText: string;
}

export interface GeneratedScript {
  title: string;
  scenes: ScriptScene[];
}

const SYSTEM_PROMPT = `Ты — сценарист коротких вертикальных видео для соцсетей (Instagram Reels, YouTube Shorts, TikTok, VK Клипы).
Отвечай СТРОГО валидным JSON без markdown-обёртки и без пояснений, по схеме:
{"title": string, "scenes": [{"caption": string, "voiceoverText": string}]}

Правила:
- 4-7 сцен.
- caption — короткий текст на экране (до 8 слов).
- voiceoverText — текст озвучки для этой сцены (1-2 предложения, разговорный стиль).
- Первая сцена — цепляющий хук, последняя — призыв к действию.
- Пиши на языке брифа пользователя.`;

export async function generateScript(brief: string): Promise<GeneratedScript> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: brief },
      ],
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

  return parsed;
}
