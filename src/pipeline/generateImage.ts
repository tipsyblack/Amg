import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

const CHARACTER_REFERENCE_PATH = path.resolve(
  "assets/characters/shamil.png",
);

// Стиль сцены выведен из присланного референс-видео: плоская векторная
// иллюстрация, толстый чёрный контур, приглушённая пастельная палитра,
// лёгкий юмористический тон. Персонаж — фирменный маскот "Pro Neiro":
// джин Шамиль (Шама). Правьте под свой конкретный референс/бренд-бук.
export const STYLE_PROMPT = `Плоская векторная иллюстрация в стиле коротких
объясняющих видео для соцсетей: толстый ровный чёрный контур, приглушённая
пастельная палитра, простые обтекаемые формы, лёгкий юмористический тон,
современный flat-cartoon стиль. Портретный кадр, сцена занимает весь кадр,
без текста и надписей на самой картинке.

Главный персонаж — джин по имени Шамиль (Шама), фирменный маскот бренда
"Pro Neiro": синяя кожа, чёрные волосы собраны в хвост с золотым зажимом,
острые уши, тонкие усы и аккуратная бородка, золотая серьга-кольцо,
мускулистый торс, красный жилет с золотой окантовкой, золотые браслеты на
запястьях. Обычно появляется в виде клубящегося дымного шлейфа/силуэта —
как будто выходит из волшебной лампы. Приложенное изображение — эталон
внешности персонажа: сохраняй его лицо, причёску, одежду и цветовую гамму
на всех сценах, меняя только позу, ракурс, окружение и действие по смыслу
конкретной сцены.`;

let characterReferenceDataUriPromise: Promise<string> | undefined;

async function loadCharacterReferenceDataUri(): Promise<string> {
  if (!characterReferenceDataUriPromise) {
    characterReferenceDataUriPromise = readFile(CHARACTER_REFERENCE_PATH).then(
      (buffer) => `data:image/png;base64,${buffer.toString("base64")}`,
    );
  }
  return characterReferenceDataUriPromise;
}

interface GenerateSceneImageOptions {
  prompt: string;
  // Data URI предыдущей сгенерированной картинки — передаётся как
  // дополнительный референс, чтобы фон/стиль сцены не "уплывали".
  previousSceneDataUri?: string;
}

export async function generateSceneImage({
  prompt,
  previousSceneDataUri,
}: GenerateSceneImageOptions): Promise<Buffer> {
  const characterReferenceDataUri = await loadCharacterReferenceDataUri();

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: characterReferenceDataUri } },
  ];
  if (previousSceneDataUri) {
    content.push({
      type: "image_url",
      image_url: { url: previousSceneDataUri },
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
