import { config } from "./config";

// Модели «оживления» кадра (image-to-video) на Kie.ai. Смысл один — «первый
// кадр плюс промпт, на выходе короткий клип», — но поля входа у моделей
// разные, поэтому реестр, а не подстановка слага в общий запрос. Ровно та же
// история, что с картинками (см. imageModels.ts).
//
// ВАЖНО про слаги. Точные имена моделей в API Kie.ai я проверить не мог:
// из окружения, где писался этот код, наружу к api.kie.ai хода нет. Слаги
// ниже — кандидаты по документации, а не подтверждённые значения, и один
// неверный слаг уронил бы генерацию уже после того, как оплачены картинки и
// озвучка. Поэтому:
//   • команда /vidmodel в боте перебирает кандидатов дешёвым пробным
//     запросом (probeKieTask) и показывает, какой из них аккаунт принимает;
//   • выбранный слаг сохраняется и дальше берётся из настроек чата;
//   • KIE_VIDEO_MODEL в .env перебивает всё — если знаете точное имя,
//     впишите его и реестр не понадобится.
export interface VideoModelSpec {
  // Короткий ключ для callback-кнопок и хранения в сессии.
  key: string;
  title: string;
  note: string;
  model: string;
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
// ширине, и разница с 720p на глаз не видна, а по цене — вдвое.
const CLIP_RESOLUTION = "720p";

// Вход у всех кандидатов одинаковый — различаются только слаги. Держим
// сборщик в одном месте: если появится модель с другими полями, она добавится
// отдельной записью со своим buildInput.
const seedanceInput = (
  prompt: string,
  firstFrameUrl: string,
  seconds: number,
): Record<string, unknown> => ({
  prompt,
  image_url: firstFrameUrl,
  duration: seconds,
  resolution: CLIP_RESOLUTION,
  aspect_ratio: CLIP_ASPECT,
});

export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    key: "sd2mini",
    title: "Seedance 2.0 Mini",
    note: "дешевле и быстрее полной 2.0 — на ней удобно подбирать промпт",
    // Слаг по подсказке владельца аккаунта («скорее всего»), а не из
    // документации. Стоит первым и взят за умолчание, но проверку это не
    // отменяет: /vidmodel probe скажет точно.
    model: "bytedance/seedance-2-0-mini",
    buildInput: seedanceInput,
  },
  {
    key: "sd2",
    title: "Seedance 2.0",
    note: "качество выше, чем у Mini; ~$0.125/с при 720p с референсом",
    model: "bytedance/seedance-2-0",
    buildInput: seedanceInput,
  },
  {
    key: "sd2mini-i2v",
    title: "Seedance 2.0 Mini (i2v)",
    note: "тот же Mini, но именование в стиле image-to-video",
    model: "bytedance/seedance-v2-mini-i2v",
    buildInput: seedanceInput,
  },
  {
    key: "sd2-i2v",
    title: "Seedance 2.0 (i2v)",
    note: "полная 2.0 в том же именовании",
    model: "bytedance/seedance-v2-i2v",
    buildInput: seedanceInput,
  },
  {
    key: "sd1pro",
    title: "Seedance 1.0 Pro",
    note: "прошлое поколение, оставлено на случай, если 2.0 нет на аккаунте",
    model: "bytedance/seedance-v1-pro-i2v",
    buildInput: seedanceInput,
  },
];

export const DEFAULT_VIDEO_MODEL_KEY = "sd2mini";

export function getVideoModel(key?: string): VideoModelSpec {
  const spec =
    VIDEO_MODELS.find((item) => item.key === key) ??
    VIDEO_MODELS.find((item) => item.key === DEFAULT_VIDEO_MODEL_KEY)!;
  // KIE_VIDEO_MODEL перебивает слаг из реестра, но не формат входа: поля
  // одинаковые у всех трёх, а если появится модель с другими — она добавится
  // в реестр отдельной записью.
  return config.kieVideoModel
    ? { ...spec, model: config.kieVideoModel }
    : spec;
}
