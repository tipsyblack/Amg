/**
 * Подсказка «нажми сюда» для гайдов.
 *
 * В гайде кадр стоит неподвижно, пока идёт реплика, и зритель смотрит на
 * экран, не понимая, куда именно жать. Здесь это чинится не картинкой (её
 * рисует модель и промахивается), а поверх неё: курсор подъезжает и щёлкает,
 * обводка обхватывает кнопку, круг расходится волной. Со звуком щелчка в
 * момент касания.
 *
 * Геометрия и тайминги лежат отдельно от рисования намеренно: моменты касаний
 * нужны в двух местах — самой подсказке и звуковой дорожке (щелчок ставится в
 * VideoComposition как обычный SFX), и считать их дважды нельзя, разъедутся.
 */

/**
 * Способы показать нажатие. Чередуются по номеру сцены: один и тот же курсор
 * десять кадров подряд перестаёт читаться как подсказка и становится фоном.
 */
export const TAP_KINDS = ["cursor", "ring", "frame", "ripple", "arrow"] as const;
export type TapKind = (typeof TAP_KINDS)[number];

export function tapKindFor(index: number, forced?: TapKind): TapKind {
  if (forced) return forced;
  return TAP_KINDS[((index % TAP_KINDS.length) + TAP_KINDS.length) % TAP_KINDS.length];
}

/**
 * Куда показывать, в процентах от карточки.
 *
 * Значения не случайны: в телеграм-боте почти всё нажимаемое живёт внизу —
 * инлайн-кнопки под сообщением и поле ввода в самом низу. Поэтому умолчание
 * тоже нижнее, а не центр экрана.
 */
export const TAP_ZONES: Record<string, { x: number; y: number }> = {
  центр: { x: 50, y: 50 },
  вверху: { x: 50, y: 18 },
  внизу: { x: 50, y: 80 },
  слева: { x: 20, y: 50 },
  справа: { x: 80, y: 50 },
  "вверху слева": { x: 22, y: 18 },
  "вверху справа": { x: 78, y: 18 },
  "внизу слева": { x: 22, y: 80 },
  "внизу справа": { x: 78, y: 80 },
  // Поле ввода у телеграма — у самого низа экрана, ниже кнопок.
  ввод: { x: 50, y: 92 },
  // Слова «кнопка» здесь намеренно нет, хотя место у неё то же, что у «внизу».
  // Оно встречается почти в каждом имени («кнопка Nano Banana»), и как зона
  // перехватывало бы имя кнопки, отправляя курсор в низ экрана вместо неё.
};

export const DEFAULT_TAP_ZONE = TAP_ZONES["внизу"];

export function tapZone(name?: string): { x: number; y: number } {
  if (!name) return DEFAULT_TAP_ZONE;
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return TAP_ZONES[key] ?? DEFAULT_TAP_ZONE;
}

// Один цикл подсказки: подъезд, касание, отход. 2.4 с выбрано по речи —
// средняя реплика слайда звучит 4-6 секунд, и за это время цикл успевает
// пройти дважды, не превращаясь в мельтешение.
export const TAP_CYCLE_SECONDS = 2.4;
// Момент касания внутри цикла. До него подсказка подъезжает, после — отходит.
export const TAP_HIT_SECONDS = 1.1;
// Пауза перед первым циклом: карточка в это время ещё влетает в кадр, и
// подсказка поверх летящей карточки читается как сбой.
export const TAP_START_SECONDS = 0.55;

/**
 * Кадры, на которых происходит касание.
 *
 * Циклов столько, сколько влезает целиком: оборванный на середине цикл
 * выглядит как заевшая анимация. Отсюда и «крутится по кругу» на длинных
 * репликах — там просто помещается больше циклов.
 */
export function tapTimes(durationInFrames: number, fps: number): number[] {
  const cycle = Math.round(TAP_CYCLE_SECONDS * fps);
  const start = Math.round(TAP_START_SECONDS * fps);
  const hit = Math.round(TAP_HIT_SECONDS * fps);
  const times: number[] = [];
  for (let i = 0; ; i++) {
    const from = start + i * cycle;
    if (from + cycle > durationInFrames) break;
    times.push(from + hit);
  }
  // Совсем короткая сцена: целый цикл не влезает, но подсказка нужна — иначе
  // самый быстрый шаг гайда останется без объяснения. Показываем один раз,
  // ужимая касание к середине сцены.
  if (times.length === 0 && durationInFrames > hit) {
    times.push(Math.min(hit, Math.round(durationInFrames / 2)));
  }
  return times;
}

/** Начало цикла, которому принадлежит этот кадр, и место внутри цикла. */
export function tapProgress(
  frame: number,
  durationInFrames: number,
  fps: number,
): { active: boolean; sinceStart: number } {
  const times = tapTimes(durationInFrames, fps);
  const hit = Math.round(TAP_HIT_SECONDS * fps);
  const cycle = Math.round(TAP_CYCLE_SECONDS * fps);
  for (const time of times) {
    const from = time - hit;
    if (frame >= from && frame < from + cycle) {
      return { active: true, sinceStart: frame - from };
    }
  }
  return { active: false, sinceStart: 0 };
}
