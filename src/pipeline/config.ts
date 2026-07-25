import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
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
  openRouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",

  // Озвучка и картинки — Kie.ai (один ключ на оба сервиса).
  kieApiKey: requireEnv("KIE_API_KEY"),
  // Переопределяется только в тестах (см. scripts/test-kie-client.mjs).
  kieApiBase: process.env.KIE_API_BASE ?? "https://api.kie.ai/api/v1/jobs",
  kieTtsModel:
    process.env.KIE_TTS_MODEL ?? "elevenlabs/text-to-speech-multilingual-v2",
  kieTtsVoice: process.env.KIE_TTS_VOICE ?? "Rachel",
  kieTtsSpeed: Number(process.env.KIE_TTS_SPEED ?? 1),
  kieImageModel: process.env.KIE_IMAGE_MODEL ?? "google/nano-banana-edit",
  kiePollIntervalMs: Number(process.env.KIE_POLL_INTERVAL_SECONDS ?? 3) * 1000,
  kieTimeoutMs: Number(process.env.KIE_TIMEOUT_SECONDS ?? 600) * 1000,

  characterReferenceUrl:
    process.env.CHARACTER_REFERENCE_URL ?? DEFAULT_CHARACTER_REFERENCE_URL,

  fps: 30,
  width: Number(process.env.VIDEO_WIDTH ?? 1080),
  height: Number(process.env.VIDEO_HEIGHT ?? 1920),
};
