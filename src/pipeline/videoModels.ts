import { config } from "./config";

// Модели «оживления» кадра (image-to-video) на Kie.ai.
//
// Слаги и поля входа сверены с документацией Kie.ai (docs.kie.ai/market/
// bytedance/*) после того, как первая попытка — угаданные имена вида
// `bytedance/seedance-v2-mini-i2v` — получила от API 422 «The model name you
// specified is not supported». Правильное именование оказалось короче:
// `bytedance/seedance-2-mini`. Заодно выяснилось, что и поля были не те:
// у семейства Seedance 2.x входная картинка называется `first_frame_url`, а
// не `image_url`, — то есть даже с верным слагом запрос бы не прошёл.
//
// Семейств два, и вход у них разный, поэтому реестр, а не подстановка слага
// в общий запрос:
//   • Seedance 2.x — prompt, first_frame_url, resolution, aspect_ratio,
//     duration, generate_audio;
//   • Seedance V1  — prompt, image_url, resolution, duration, camera_fixed,
//     seed, enable_safety_checker.
export interface VideoModelSpec {
  // Короткий ключ для callback-кнопок и хранения в сессии.
  key: string;
  title: string;
  note: string;
  model: string;
  /** Минимальная длительность, которую принимает модель. */
  minSeconds: number;
  /** Максимальная длительность. */
  maxSeconds: number;
  /** Порядок цены за секунду — для честных цифр в чате. */
  pricePerSecond: number;
  // Промпт + первый кадр (публичная ссылка) + длительность в секундах.
  buildInput(
    prompt: string,
    firstFrameUrl: string,
    seconds: number,
  ): Record<string, unknown>;
}

// Клип показывается внутри карточки, а она повторяет пропорции картинки —
// те же 3:4, что и у иллюстраций (см. imageModels.ts).
const CLIP_ASPECT = "3:4";

// 720p, а не 1080p: клип занимает 75% ширины кадра, то есть примерно 810 px по
// ширине, и разница на глаз не видна, а по цене — вдвое.
//
// Регистр буквы вынесен в .env намеренно. В документации Kie.ai примеры для
// V1 написаны строчной («720p»), а описания Seedance 2 — прописной («720P»),
// и какой из вариантов принимает API, проверяется только запросом. Ошибка тут
// стоит ноль (createTask отвечает 422 сразу, задача не создаётся), но чинить
// её правкой кода и передеплоем — глупо: CLIP_RESOLUTION=720P и всё.
const CLIP_RESOLUTION = config.clipResolution;

/**
 * Вход Seedance 2.x. `generate_audio: false` обязателен: у нас своя озвучка,
 * а сгенерированный моделью звук лёг бы поверх неё — и, судя по тому, что это
 * отдельный параметр, ещё и стоил бы денег.
 */
const seedance2Input = (
  prompt: string,
  firstFrameUrl: string,
  seconds: number,
): Record<string, unknown> => ({
  prompt,
  first_frame_url: firstFrameUrl,
  resolution: CLIP_RESOLUTION,
  aspect_ratio: CLIP_ASPECT,
  duration: seconds,
  generate_audio: false,
});

/**
 * Вход Seedance V1. `camera_fixed: true` — ровно то, что нам нужно: карточка
 * в кадре и так приезжает анимацией, и поехавшая внутри неё камера ломает
 * стык. У семейства 2.x такого выключателя нет, там об этом просим словами.
 *
 * duration строкой, а не числом: так в примере документации.
 */
const seedanceV1Input = (
  prompt: string,
  firstFrameUrl: string,
  seconds: number,
): Record<string, unknown> => ({
  prompt,
  image_url: firstFrameUrl,
  resolution: CLIP_RESOLUTION,
  duration: String(seconds),
  camera_fixed: true,
  seed: -1,
});

export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    key: "sd2mini",
    title: "Seedance 2.0 Mini",
    note: "дешевле и быстрее полной 2.0, 480P/720P, 4-15 с",
    model: "bytedance/seedance-2-mini",
    minSeconds: 4,
    maxSeconds: 15,
    pricePerSecond: 0.056,
    buildInput: seedance2Input,
  },
  {
    key: "sd2fast",
    title: "Seedance 2.0 Fast",
    note: "быстрее полной 2.0, качество между ней и Mini",
    model: "bytedance/seedance-2-fast",
    minSeconds: 4,
    maxSeconds: 15,
    pricePerSecond: 0.09,
    buildInput: seedance2Input,
  },
  {
    key: "sd2",
    title: "Seedance 2.0",
    note: "лучшее качество семейства, ~$0.125/с при 720p",
    model: "bytedance/seedance-2",
    minSeconds: 4,
    maxSeconds: 15,
    pricePerSecond: 0.125,
    buildInput: seedance2Input,
  },
  {
    key: "sd15pro",
    title: "Seedance 1.5 Pro",
    note: "прошлое поколение со звуком",
    model: "bytedance/seedance-1-5-pro",
    minSeconds: 4,
    maxSeconds: 12,
    pricePerSecond: 0.1,
    buildInput: seedance2Input,
  },
  {
    key: "v1pro",
    title: "Seedance V1 Pro",
    note: "старое семейство, зато есть выключатель движения камеры",
    model: "bytedance/v1-pro-image-to-video",
    minSeconds: 5,
    maxSeconds: 10,
    pricePerSecond: 0.09,
    buildInput: seedanceV1Input,
  },
  {
    key: "v1lite",
    title: "Seedance V1 Lite",
    note: "самый дешёвый вариант, качество заметно ниже",
    model: "bytedance/v1-lite-image-to-video",
    minSeconds: 5,
    maxSeconds: 10,
    pricePerSecond: 0.045,
    buildInput: seedanceV1Input,
  },
];

export const DEFAULT_VIDEO_MODEL_KEY = "sd2mini";

export function getVideoModel(key?: string): VideoModelSpec {
  const spec =
    VIDEO_MODELS.find((item) => item.key === key) ??
    VIDEO_MODELS.find((item) => item.key === DEFAULT_VIDEO_MODEL_KEY)!;
  // KIE_VIDEO_MODEL перебивает слаг из реестра, но не формат входа: подменять
  // ещё и его вслепую нельзя — у двух семейств поля разные.
  return config.kieVideoModel
    ? { ...spec, model: config.kieVideoModel }
    : spec;
}

/**
 * Длительность, которую модель точно примет.
 *
 * Нужна потому, что мы просили 2 секунды, а Seedance 2 короче четырёх не
 * делает вовсе — запрос отвергался бы даже с верным слагом и верными полями.
 * Молча отправлять заведомо неприемлемое число хуже, чем округлить: клип на
 * секунду длиннее просто дольше висит замороженным последним кадром.
 */
export function clampClipSeconds(spec: VideoModelSpec, seconds: number): number {
  return Math.min(Math.max(seconds, spec.minSeconds), spec.maxSeconds);
}
