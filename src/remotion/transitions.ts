// Варианты появления и уход сцены. Смысл в разнообразии: подряд идущие сцены
// не должны двигаться одинаково, иначе ролик усыпляет. Набор перебирается по
// номеру сцены — детерминированно, чтобы рендер был повторяемым.

export type EntryStyle = "fade" | "overlay" | "slide" | "punch" | "swing";
export type ExitStyle = "none" | "crumple" | "shrink" | "driftUp";

export interface SceneMotion {
  entry: EntryStyle;
  exit: ExitStyle;
  // Звук на стыке сцен из public/sfx. Подбирается под характер перехода.
  sfx: "whoosh" | "swish" | "pop" | "thud";
  // Куда ведёт наплыв на картинку внутри сцены.
  pan: "in" | "out" | "left" | "right";
  // Усиленная подача: пружина мягче, подпись бьёт крупнее. Нужна хуку.
  emphasis?: boolean;
}

// Пары подобраны так, чтобы уход предыдущей сцены сочетался с появлением
// следующей: смятие — с глухим ударом, наложение — с коротким свишем.
const CYCLE: SceneMotion[] = [
  { entry: "fade", exit: "shrink", sfx: "swish", pan: "in" },
  { entry: "overlay", exit: "crumple", sfx: "thud", pan: "left" },
  { entry: "slide", exit: "driftUp", sfx: "whoosh", pan: "out" },
  { entry: "punch", exit: "shrink", sfx: "pop", pan: "right" },
  { entry: "overlay", exit: "crumple", sfx: "thud", pan: "in" },
  { entry: "swing", exit: "driftUp", sfx: "whoosh", pan: "out" },
];

// Первая сцена — хук. Зритель решает за 1-2 секунды, поэтому кадр должен
// выстрелить, а не проявиться: наезд из мелкого масштаба с упругой пружиной,
// подпись сразу крупно, уход — смятием под глухой удар.
const HOOK_MOTION: SceneMotion = {
  entry: "punch",
  exit: "crumple",
  sfx: "thud",
  pan: "in",
  emphasis: true,
};

export function sceneMotion(index: number): SceneMotion {
  if (index === 0) return HOOK_MOTION;
  return CYCLE[index % CYCLE.length];
}
