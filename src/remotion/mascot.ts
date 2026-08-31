import {
  CARD_TO_TEXT_GAP_PERCENT,
  REF_HEIGHT,
  subtitleTopPx,
} from "./layout";

// Геометрия сцены-маскота: кадр без карточки, персонаж стоит прямо на белом.
//
// Это отдельный приём из присланного референса, и он у нас отсутствовал: мы
// маскота всегда прятали ВНУТРЬ карточки, а там он появляется на весь кадр,
// без рамки вообще. Именно поэтому наши ролики выглядели однообразнее — мы
// ни разу не ломали карточку.
//
// Числа сняты с установившегося кадра (1440×2562, часть 2, 4.2 с), а не с
// кадра перехода. Разница существенная: на 3.0 с карточка сжата в полоску
// шириной 15% и персонаж выглядит иначе — это середина схлопывания, и первый
// раз я прочитал именно её, приняв переход за композицию.
export const MASCOT_HEIGHT_PERCENT = 60.6;
export const MASCOT_TOP_PERCENT = 14.4;
// В референсе персонаж занимал 62.8% ширины кадра, но там другая поза — рука
// поднята, фигура узкая. У нашего эталона руки скрещены, силуэт шире, и
// подогнать обе стороны разом нельзя. Ведём по высоте: она задаёт, насколько
// крупно читается лицо, а по ширине просто не даём упереться в края кадра.
export const MASCOT_MAX_WIDTH_PERCENT = 86;

// Ниже этой доли кадра фигура опускаться не должна: там субтитры.
//
// В присланном ролике слова «НАШ», «ПОПРОБУЙ», «БЕСПЛАТНО» напечатаны прямо
// по синему хвосту джина. Это не случайность, а арифметика: фигура кончается
// на 75.0% высоты (14.4 + 60.6), а верх заглавных букв — на 73.0%
// (100 − 23 − 77/1920). Пересечение 2% высоты кадра, то есть 38 px на 1920,
// и оно повторялось бы в каждой сцене с маскотом.
//
// У карточек такая защита есть давно (minCardAspect в layout.ts): карточке не
// дают вытянуться до субтитров. Маскот рисуется в обход неё — здесь то же
// правило и тот же просвет.
const MIN_TOP_PERCENT = 6;

// Сколько занимает сам персонаж внутри public/characters/shamil.png: файл
// собран с полями (scripts/build-character-reference.mjs), и без поправки на
// них фигура вышла бы мельче заданного.
const FIGURE_HEIGHT_SHARE = 0.918;
const FIGURE_WIDTH_SHARE = 0.812;
const IMAGE_ASPECT = 1080 / 1440;

export interface MascotBox {
  /** Ширина картинки в пикселях кадра. */
  width: number;
  /** Высота картинки в пикселях кадра. */
  height: number;
  /** Отступ сверху до КАРТИНКИ (не до фигуры). */
  top: number;
}

/**
 * Размер и положение файла с маскотом так, чтобы САМА ФИГУРА встала по
 * измеренным долям кадра.
 */
export function mascotBox(width: number, height: number): MascotBox {
  // Ведём по высоте фигуры, потом переводим в размер картинки.
  let imageHeight = (MASCOT_HEIGHT_PERCENT / 100) * height / FIGURE_HEIGHT_SHARE;
  let imageWidth = imageHeight * IMAGE_ASPECT;

  // Если по ширине фигура упирается в края — ужимаем всё пропорционально.
  const maxFigureWidth = (MASCOT_MAX_WIDTH_PERCENT / 100) * width;
  const figureWidth = imageWidth * FIGURE_WIDTH_SHARE;
  if (figureWidth > maxFigureWidth) {
    const k = maxFigureWidth / figureWidth;
    imageWidth *= k;
    imageHeight *= k;
  }

  // Теперь опускаем фигуру так, чтобы она не наехала на субтитры.
  //
  // Сначала пробуем поднять её выше: размер важнее верхнего отступа — от него
  // зависит, насколько крупно читается лицо, а над головой всё равно пусто.
  // Если подъёма не хватает (упёрлись в MIN_TOP_PERCENT), только тогда
  // уменьшаем саму фигуру.
  const gap = (CARD_TO_TEXT_GAP_PERCENT / 100) * height;
  const maxBottom = (subtitleTopPx() / REF_HEIGHT) * height - gap;
  let figureTop = (MASCOT_TOP_PERCENT / 100) * height;
  let figureHeight = imageHeight * FIGURE_HEIGHT_SHARE;

  if (figureTop + figureHeight > maxBottom) {
    figureTop = Math.max((MIN_TOP_PERCENT / 100) * height, maxBottom - figureHeight);
    if (figureTop + figureHeight > maxBottom) {
      const k = (maxBottom - figureTop) / figureHeight;
      imageWidth *= k;
      imageHeight *= k;
      figureHeight *= k;
    }
  }

  // Верх задан для фигуры, а поле над ней внутри картинки тоже надо учесть.
  const padTop = imageHeight * ((1 - FIGURE_HEIGHT_SHARE) * 0.99);
  return {
    width: imageWidth,
    height: imageHeight,
    top: figureTop - padTop,
  };
}
