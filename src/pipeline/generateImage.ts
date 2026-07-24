import { config } from "./config";

// Стиль выведен из присланного референса: плоская векторная иллюстрация,
// толстый чёрный контур, приглушённая пастельная палитра, один сквозной
// персонаж. Правьте под свой конкретный референс/агентство.
export const STYLE_PROMPT = `Плоская векторная иллюстрация в стиле коротких
объясняющих видео для соцсетей: толстый ровный чёрный контур, приглушённая
пастельная палитра, простые обтекаемые формы, лёгкий юмористический тон,
современный flat-cartoon стиль. В кадре — один и тот же персонаж: маленький
серо-голубой робот с квадратной головой и круглыми чёрными глазами (если по
смыслу сцены нужен другой персонаж или предмет, сохраняй ту же манеру
отрисовки). Портретный кадр, персонаж и сцена занимают весь кадр, без текста
и надписей на самой картинке.`;

interface GenerateSceneImageOptions {
  prompt: string;
  // Data URI предыдущей сгенерированной картинки — передаётся как
  // изображение-референс, чтобы персонаж и стиль не "уплывали" от сцены к
  // сцене.
  referenceImageDataUri?: string;
}

export async function generateSceneImage({
  prompt,
  referenceImageDataUri,
}: GenerateSceneImageOptions): Promise<Buffer> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (referenceImageDataUri) {
    content.push({
      type: "image_url",
      image_url: { url: referenceImageDataUri },
    });
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openRouterImageModel,
      modalities: ["image", "text"],
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter (генерация изображения) вернул ошибку ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    choices?: {
      message?: { images?: { image_url?: { url?: string } }[] };
    }[];
  };

  const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imageUrl || !imageUrl.startsWith("data:")) {
    throw new Error(
      "OpenRouter не вернул изображение — убедитесь, что OPENROUTER_IMAGE_MODEL " +
        "указывает на модель с поддержкой генерации картинок (см. openrouter.ai/models).",
    );
  }

  const base64 = imageUrl.slice(imageUrl.indexOf(",") + 1);
  return Buffer.from(base64, "base64");
}
