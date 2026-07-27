// Варианты появления и уход сцены. Смысл в разнообразии: подряд идущие сцены
// не должны двигаться одинаково, иначе ролик усыпляет. Набор перебирается по
// номеру сцены — детерминированно, чтобы рендер был повторяемым.

export type EntryStyle = "fade" | "overlay" | "slide" | "punch" | "swing";
export type ExitStyle = "none" | "crumple" | "shrink" | "driftUp";

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
}

// Пары подобраны так, чтобы уход предыдущей сцены сочетался с появлением
// следующей, а звук — с силой движения: смятие — удар, быстрый стык — щелчок
// или снап, зум-удар — хлопок.
// Звуки в цикле подобраны ещё и так, чтобы на соседних стыках не повторяться
// (первый стык — удар хука, поэтому у сцены 1 удара уже нет).
const CYCLE: SceneMotion[] = [
  { entry: "fade", exit: "shrink", sfx: "snap", pan: "in" },
  { entry: "overlay", exit: "crumple", sfx: "clap", pan: "left" },
  { entry: "slide", exit: "driftUp", sfx: "click", pan: "out" },
  { entry: "punch", exit: "shrink", sfx: "snap", pan: "right" },
  { entry: "overlay", exit: "crumple", sfx: "impact", pan: "in" },
  { entry: "swing", exit: "driftUp", sfx: "click", pan: "out" },
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

export function sceneMotion(index: number): SceneMotion {
  if (index === 0) return HOOK_MOTION;
  return CYCLE[index % CYCLE.length];
}
