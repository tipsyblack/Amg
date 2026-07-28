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
  // Sonnet 5 вместо gemini-2.5-flash: сценарий — единственный шаг, где
  // решается, будет ли ролик смотрибельным, а стоит он копейки на фоне
  // картинок (~$0.03 против ~$1.35 за 15 картинок). Модель точнее следует
  // нашим жёстким правилам (хук, реклама только в финале, бюджет слов),
  // поэтому реже срабатывает авто-переписывание.
  openRouterModel: env("OPENROUTER_MODEL") ?? "anthropic/claude-sonnet-5",
  // Веб-поиск для сценария (плагин OpenRouter). Нужен, чтобы темы были
  // актуальными, а не пересказом знаний модели: без него «свежие модели и
  // тренды» опираются на дату обучения. Стоит порядка $4 за 1000 результатов,
  // то есть копейки на ролик. SCRIPT_WEB_SEARCH=0 отключает.
  scriptWebSearch: (env("SCRIPT_WEB_SEARCH") ?? "1") !== "0",
  scriptWebSearchResults: Number(env("SCRIPT_WEB_SEARCH_RESULTS") ?? 3),
  // Цель по длине описания под пост. Жёсткий предел — 500 символов
  // (DESCRIPTION_MAX_CHARS), поэтому цель держим ниже: если просить ровно
  // предел, модель через него перескакивает и текст приходится резать.
  descriptionChars: Number(env("DESCRIPTION_CHARS") ?? 450),

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

  // Настройки голоса ElevenLabs (действуют для оба провайдера). Значения
  // подобраны под клонированный голос: чем выше similarity_boost и чем ниже
  // style, тем ближе результат к исходной записи; speaker boost добавляет
  // сходства с оригинальным тембром. Стабильность ниже 0.5 оставляет живую
  // интонацию — на 1.0 речь становится ровной и «диктором».
  ttsStability: Number(env("TTS_STABILITY") ?? 0.4),
  ttsSimilarityBoost: Number(env("TTS_SIMILARITY_BOOST") ?? 0.9),
  ttsStyle: Number(env("TTS_STYLE") ?? 0),
  ttsSpeakerBoost: (env("TTS_SPEAKER_BOOST") ?? "1") !== "0",
  // Субтитры по словам. Точные тайминги приходят от прямого ElevenLabs вместе
  // со звуком; при провайдере kie слова раскладываются приблизительно.
  wordSubtitles: (env("WORD_SUBTITLES") ?? "1") !== "0",
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
  // Маскот по умолчанию только в хуке и финале: в каждой сцене он превращал
  // ролик в галерею поз одного персонажа. =1 возвращает его во все сцены.
  characterEveryScene: (env("CHARACTER_EVERY_SCENE") ?? "0") !== "0",

  // Брендовая концовка — последний кадр ролика: тёмная плашка с логотипом и
  // названием. Пустое BRAND_NAME отключает её целиком.
  brandName: env("BRAND_NAME") ?? "PRO NEIRO",
  brandTagline: env("BRAND_TAGLINE") ?? "",
  // Файл в public/brand/. Пусто — кадр собирается из одного текста: ставить
  // <Img> на несуществующий файл нельзя, рендер упадёт на последнем кадре.
  brandLogoFile: env("BRAND_LOGO_FILE") ?? "logo.png",
  outroSeconds: Number(env("OUTRO_SECONDS") ?? 2),

  // 60 кадров: резкие стыки длятся 0.3 с, и на 30 fps это всего 9 кадров —
  // движение читается рвано. В референсе 60. Платим временем рендера: оно
  // примерно удваивается. VIDEO_FPS=30 возвращает как было.
  fps: Number(env("VIDEO_FPS") ?? 60),
  // Сколько сцен максимум и в какую длину должен уложиться ролик.
  maxScenes: Number(env("MAX_SCENES") ?? 15),
  maxVideoSeconds: Number(env("MAX_VIDEO_SECONDS") ?? 60),
  width: Number(env("VIDEO_WIDTH") ?? 1080),
  height: Number(env("VIDEO_HEIGHT") ?? 1920),
};
