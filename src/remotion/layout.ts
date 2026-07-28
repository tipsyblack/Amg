// Геометрия каркаса кадра — одна на карточку и на субтитры.
//
// Все числа сняты с кадров референса (1440×2560) и приведены к 1080×1920.
// Раньше они лежали по своим файлам, и это вылезло боком: карточка растёт под
// пропорции картинки, а вертикальная картинка растянула её ровно на строку
// субтитров — текст оказался поверх рамки. Теперь безопасная высота карточки
// считается из тех же чисел, что задают положение субтитров, так что наехать
// друг на друга они больше не могут.

export const REF_WIDTH = 1080;
export const REF_HEIGHT = 1920;

// Карточка: 1086×1435 px на кадре 1440×2560.
export const CARD_WIDTH_PERCENT = 75.4;
export const CARD_TOP_PERCENT = 10.9;
export const CARD_ASPECT = 0.757;
// Рамка в референсе 19 px на 1440 — это 14 px на 1080.
export const CARD_BORDER_PX = 14;
export const CARD_RADIUS_PX = 26;

// Субтитры: высота заглавных букв и базовая линия от нижнего края кадра.
export const SUBTITLE_CAP_HEIGHT_PX = 77;
export const SUBTITLE_BASELINE_PERCENT = 23;

// Просвет между низом карточки и верхом букв. В референсе он 6.1% высоты, но
// там картинка ровно 0.757. Вертикальным картинкам разрешаем вытянуть карточку
// сильнее, сохраняя хотя бы этот минимум — иначе их пришлось бы резать сильно.
export const CARD_TO_TEXT_GAP_PERCENT = 3;

/** Верх заглавных букв субтитров, px в системе 1080×1920. */
export function subtitleTopPx(): number {
  return (
    REF_HEIGHT * (1 - SUBTITLE_BASELINE_PERCENT / 100) - SUBTITLE_CAP_HEIGHT_PX
  );
}

/**
 * Самая «высокая» карточка, которая ещё не наезжает на субтитры, в виде
 * отношения ширины к высоте: чем меньше число, тем вытянутее карточка.
 */
export function minCardAspect(): number {
  const top = (CARD_TOP_PERCENT / 100) * REF_HEIGHT;
  const gap = (CARD_TO_TEXT_GAP_PERCENT / 100) * REF_HEIGHT;
  const maxHeight = subtitleTopPx() - gap - top;
  return ((CARD_WIDTH_PERCENT / 100) * REF_WIDTH) / maxHeight;
}

// Сверху ограничиваем квадратом: шире — уже не похоже на референс.
export const MAX_CARD_ASPECT = 1;

/**
 * Пропорции карточки под конкретную картинку. Карточка повторяет пропорции
 * самой картинки: модели иногда отдают не то, что просили, и жёсткая рамка
 * срезала бы картинку по краям. Но не любые — в границах, за которыми кадр
 * либо перестаёт походить на референс, либо наезжает на субтитры.
 */
export function cardAspect(width?: number, height?: number): number {
  if (!width || !height) return CARD_ASPECT;
  return Math.min(Math.max(width / height, minCardAspect()), MAX_CARD_ASPECT);
}

/** Низ карточки в px (система 1080×1920) — по нему видно просвет до субтитров. */
export function cardBottomPx(aspect: number): number {
  const top = (CARD_TOP_PERCENT / 100) * REF_HEIGHT;
  return top + ((CARD_WIDTH_PERCENT / 100) * REF_WIDTH) / aspect;
}
