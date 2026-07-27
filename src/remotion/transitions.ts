// Варианты появления и уход сцены. Смысл в разнообразии: подряд идущие сцены
// не должны двигаться одинаково, иначе ролик усыпляет. Набор перебирается по
// номеру сцены — детерминированно, чтобы рендер был повторяемым.

export type EntryStyle = "fade" | "overlay" | "slide" | "punch" | "swing";
export type ExitStyle = "none" | "crumple" | "shrink" | "driftUp";

// Переходы всего кадра из @remotion/transitions — другой класс движения, чем
// наши анимации карточки. Если у сцены задан library, то стык с СЛЕДУЮЩЕЙ
// сценой делает библиотека: карточка на этом стыке не мнётся и не уезжает
// (exit: "none"), а входящая сцена появляется без своего движения — иначе два
// перехода наложатся друг на друга и получится каша.
export type LibraryTransition = "wipe" | "flip" | "clockWipe" | "slide";

// Звуки на стыках — короткие и жёсткие: атака в единицы миллисекунд, спад в
// десятки. Плавные наплывы (вуш, свиш) на стыке читаются как размазанные,
// поэтому набор — щелчок, хлопок, снап и удар. См. scripts/build-sfx.mjs.
export type SfxName = "click" | "clap" | "snap" | "impact";

export interface SceneMotion {
  entry: EntryStyle;
  exit: ExitStyle;
  // Звук на стыке сцен из public/sfx. Подбирается под характер перехода.
  sfx: SfxName;
  // Куда ведёт наплыв на картинку внутри сцены.
  pan: "in" | "out" | "left" | "right";
  // Усиленная подача: пружина мягче, подпись бьёт крупнее. Нужна хуку.
  emphasis?: boolean;
  // Переход из библиотеки на стыке со следующей сценой.
  library?: LibraryTransition;
}

// Пары подобраны так, чтобы уход предыдущей сцены сочетался с появлением
// следующей, а звук — с силой движения: смятие — удар, быстрый стык — щелчок
// или снап, зум-удар — хлопок.
// Звуки в цикле подобраны ещё и так, чтобы на соседних стыках не повторяться
// (первый стык — удар хука, поэтому у сцены 1 удара уже нет).
const CYCLE: SceneMotion[] = [
  { entry: "fade", exit: "shrink", sfx: "snap", pan: "in" },
  { entry: "overlay", exit: "crumple", sfx: "clap", pan: "left" },
  // Стык 2→3 — шторка: своего ухода у карточки нет, его делает переход.
  { entry: "slide", exit: "none", sfx: "click", pan: "out", library: "wipe" },
  { entry: "punch", exit: "shrink", sfx: "snap", pan: "right" },
  { entry: "overlay", exit: "crumple", sfx: "impact", pan: "in" },
  { entry: "swing", exit: "none", sfx: "click", pan: "out", library: "flip" },
  { entry: "fade", exit: "none", sfx: "snap", pan: "left", library: "clockWipe" },
  { entry: "punch", exit: "driftUp", sfx: "clap", pan: "right" },
];

// Первая сцена — хук. Зритель решает за 1-2 секунды, поэтому кадр должен
// выстрелить, а не проявиться: наезд из мелкого масштаба с упругой пружиной,
// подпись сразу крупно, уход — смятием под глухой удар.
const HOOK_MOTION: SceneMotion = {
  entry: "punch",
  exit: "crumple",
  sfx: "impact",
  pan: "in",
  emphasis: true,
};

// Длина цикла: тесты сверяют по ней повторяемость, чтобы добавление вариантов
// не требовало правки проверок.
export const MOTION_CYCLE_LENGTH = CYCLE.length;

export function sceneMotion(index: number): SceneMotion {
  if (index === 0) return HOOK_MOTION;
  return CYCLE[index % CYCLE.length];
}
