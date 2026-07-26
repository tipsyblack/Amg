import "dotenv/config";

// Пустая строка в .env (например, "CHARACTER_REFERENCE_URL=" из шаблона)
// означает "не задано" — иначе она затирала бы значения по умолчанию.
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(
      `Отсутствует переменная окружения ${name}. Заполните .env (см. .env.example).`,
    );
  }
  return value;
}

// Эталон внешности персонажа. Kie.ai принимает входные картинки только по
// публичной ссылке, поэтому по умолчанию берём файл из этого же репозитория
// через raw.githubusercontent.com. Если сделаете репозиторий приватным —
// подставьте свою публичную ссылку в CHARACTER_REFERENCE_URL.
const DEFAULT_CHARACTER_REFERENCE_URL =
  "https://raw.githubusercontent.com/tipsyblack/Amg/refs/heads/claude/remotion-video-automation-biby8g/assets/characters/shamil.png";

export const config = {
  // Сценарий — OpenRouter.
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: env("OPENROUTER_MODEL") ?? "google/gemini-2.5-flash",

  // Озвучка и картинки — Kie.ai (один ключ на оба сервиса).
  kieApiKey: requireEnv("KIE_API_KEY"),
  // Переопределяется только в тестах (см. scripts/test-kie-client.mjs).
  kieApiBase: env("KIE_API_BASE") ?? "https://api.kie.ai/api/v1/jobs",
  kieTtsModel: env("KIE_TTS_MODEL") ?? "elevenlabs/text-to-speech-multilingual-v2",
  kieTtsVoice: env("KIE_TTS_VOICE") ?? "Rachel",
  kieTtsSpeed: Number(env("KIE_TTS_SPEED") ?? 1),
  kieImageModel: env("KIE_IMAGE_MODEL") ?? "google/nano-banana-edit",
  kiePollIntervalMs: Number(env("KIE_POLL_INTERVAL_SECONDS") ?? 3) * 1000,
  kieTimeoutMs: Number(env("KIE_TIMEOUT_SECONDS") ?? 600) * 1000,

  characterReferenceUrl:
    env("CHARACTER_REFERENCE_URL") ?? DEFAULT_CHARACTER_REFERENCE_URL,

  fps: 30,
  width: Number(env("VIDEO_WIDTH") ?? 1080),
  height: Number(env("VIDEO_HEIGHT") ?? 1920),
};
