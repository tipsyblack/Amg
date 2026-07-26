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
  // Именно ID голоса, а не имя: в документации Kie.ai пример показывает имя
  // ("Rachel"), но список допустимых значений — ID, и с именем генерация
  // падает с "internal error". По умолчанию — ID голоса Rachel.
  kieTtsVoice: env("KIE_TTS_VOICE") ?? "21m00Tcm4TlvDq8ikWAM",
  kieTtsSpeed: Number(env("KIE_TTS_SPEED") ?? 1),
  // Пусто = модель определяет язык сама.
  kieTtsLanguageCode: env("KIE_TTS_LANGUAGE_CODE") ?? "",

  // Резервная озвучка напрямую через ElevenLabs — нужна, когда прокси Kie.ai
  // для их моделей лежит. Провайдер: "kie" (по умолчанию) или "elevenlabs";
  // переключается командой /tts в боте.
  ttsProvider: (env("TTS_PROVIDER") ?? "kie") as "kie" | "elevenlabs",
  elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
  elevenLabsModelId: env("ELEVENLABS_MODEL_ID") ?? "eleven_multilingual_v2",
  kieImageModel: env("KIE_IMAGE_MODEL") ?? "google/nano-banana-edit",
  // Музыка (Suno через Kie.ai). Считается дольше картинок — свой лимит.
  kieMusicModel: env("KIE_MUSIC_MODEL") ?? "V5",
  // Suno у Kie.ai требует callBackUrl обязательно, но нам он не нужен: мы
  // сами опрашиваем статус задачи. Поэтому здесь заглушка на зарезервированном
  // IANA домене example.com — Kie.ai постучится в пустоту и это ни на что не
  // влияет. Если однажды поднимете свой обработчик, впишите его адрес.
  kieMusicCallbackUrl:
    env("KIE_MUSIC_CALLBACK_URL") ?? "https://example.com/kie-music-callback",
  kieMusicTimeoutMs: Number(env("KIE_MUSIC_TIMEOUT_SECONDS") ?? 600) * 1000,
  kiePollIntervalMs: Number(env("KIE_POLL_INTERVAL_SECONDS") ?? 3) * 1000,
  kieTimeoutMs: Number(env("KIE_TIMEOUT_SECONDS") ?? 600) * 1000,
  // Повторы при сбоях Kie.ai: сколько попыток на задачу и базовая пауза
  // между ними (растёт вдвое с каждой попыткой: 2с, 4с, 8с, 16с).
  kieMaxAttempts: Number(env("KIE_MAX_ATTEMPTS") ?? 5),
  kieRetryBaseMs: Number(env("KIE_RETRY_BASE_SECONDS") ?? 2) * 1000,

  characterReferenceUrl:
    env("CHARACTER_REFERENCE_URL") ?? DEFAULT_CHARACTER_REFERENCE_URL,

  fps: 30,
  // Сколько сцен максимум и в какую длину должен уложиться ролик.
  maxScenes: Number(env("MAX_SCENES") ?? 15),
  maxVideoSeconds: Number(env("MAX_VIDEO_SECONDS") ?? 60),
  width: Number(env("VIDEO_WIDTH") ?? 1080),
  height: Number(env("VIDEO_HEIGHT") ?? 1920),
};
