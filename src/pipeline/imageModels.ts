import { config } from "./config";

// Модели генерации картинок Kie.ai. У каждой свой формат входа: одинаковый
// смысл ("промпт + референсные изображения"), но разные имена полей —
// image_urls / image_input / input_urls. Поэтому реестр, а не подстановка
// слага в общий запрос.
export interface ImageModelSpec {
  // Короткий ключ для callback-кнопок и хранения в сессии.
  key: string;
  title: string;
  note: string;
  model: string;
  buildInput(prompt: string, imageUrls: string[]): Record<string, unknown>;
}

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    key: "nb",
    title: "Nano Banana",
    note: "текущая, проверена в деле",
    // Слаг можно переопределить через KIE_IMAGE_MODEL в .env.
    model: config.kieImageModel,
    buildInput: (prompt, imageUrls) => ({
      prompt,
      image_urls: imageUrls,
      output_format: "png",
      image_size: "9:16",
    }),
  },
  {
    key: "nb2",
    title: "Nano Banana 2",
    note: "новее, детальнее",
    model: "nano-banana-2",
    buildInput: (prompt, imageUrls) => ({
      prompt,
      image_input: imageUrls,
      aspect_ratio: "9:16",
      resolution: "1K",
      output_format: "png",
    }),
  },
  {
    key: "nb2lite",
    title: "Nano Banana 2 Lite",
    note: "быстрее и дешевле",
    model: "nano-banana-2-lite",
    buildInput: (prompt, imageUrls) => ({
      prompt,
      image_input: imageUrls,
      aspect_ratio: "9:16",
      resolution: "1K",
      output_format: "png",
    }),
  },
  {
    key: "gpt2",
    title: "GPT Image 2",
    note: "другая манера, от OpenAI",
    model: "gpt-image-2-image-to-image",
    buildInput: (prompt, imageUrls) => ({
      prompt,
      input_urls: imageUrls,
      nsfw_checker: false,
      aspect_ratio: "9:16",
      resolution: "1K",
    }),
  },
];

export const DEFAULT_IMAGE_MODEL_KEY = "nb";

export function getImageModel(key?: string): ImageModelSpec {
  return (
    IMAGE_MODELS.find((spec) => spec.key === key) ??
    IMAGE_MODELS.find((spec) => spec.key === DEFAULT_IMAGE_MODEL_KEY)!
  );
}
