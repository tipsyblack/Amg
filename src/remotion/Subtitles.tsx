import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { CAPTION_FONT_FAMILY } from "./font";
import {
  REF_WIDTH,
  SUBTITLE_BASELINE_PERCENT,
  SUBTITLE_CAP_HEIGHT_PX,
} from "./layout";
import { wordAt } from "./subtitleWord";

// Субтитры как в референсе: в кадре одно слово, крупно, чёрным по белому, без
// плашки и без анимации. Слово меняется в такт речи — это и есть весь эффект.
//
// Геометрия — из общего модуля: высота заглавных букв 77 px и базовая линия на
// 23% высоты от нижнего края кадра. Там же по этим числам считается, насколько
// высокой можно отпустить карточку, чтобы она не легла на строку.
const CAP_HEIGHT_PX = SUBTITLE_CAP_HEIGHT_PX;
const BASELINE_PERCENT = SUBTITLE_BASELINE_PERCENT;

// Пересчёт кегля из высоты заглавной буквы. Коэффициент измерен на рендере
// (Oswald 700: кегль 112 дал заглавные 94 px), а не взят из таблиц шрифта:
// таблицы дают 0.69, и по ним текст выходил на пятую часть мельче нужного.
const CAP_PER_EM = 0.839;
const FONT_SIZE = Math.round(CAP_HEIGHT_PX / CAP_PER_EM);
// При line-height: 1 базовая линия стоит чуть выше нижнего края блока, а CSS
// отмеряет через bottom именно край блока. Зазор тоже измерен на рендере.
const BASELINE_GAP_EM = 0.035;

// Референс кегль под длину слова не меняет: «ВАШ» и «ЭЛЕКТРОЭНЕРГИЯ» одной
// высоты, и у нас так же — при 77 px даже 14 букв занимают 64% ширины кадра.
// Ниже только страховка от слова, которое всё-таки не влезет в поля: ширину
// оцениваем по числу букв с запасом на широкие (Ш, Ю, М, Ф).
const SIDE_PADDING_PERCENT = 6;
const MAX_EM_PER_CHAR = 0.62;

const INK = "#0d0d0d";

interface SubtitlesProps {
  words: { text: string; startMs: number; endMs: number }[];
  // Гаснут вместе со сценой: на стыке два текста подряд не нужны.
  exitProgress: number;
}

export const Subtitles: React.FC<SubtitlesProps> = ({
  words,
  exitProgress,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;

  const word = wordAt(words, timeMs);
  if (!word) return null;

  const opacity =
    exitProgress > 0
      ? interpolate(exitProgress, [0, 0.4], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 1;

  // Числа выше сняты на 1080×1920 — на другом разрешении масштабируем, чтобы
  // пропорции кадра не поехали.
  const scale = width / REF_WIDTH;
  const letters = word.text.replace(/[^\p{L}\p{N}]/gu, "").length;
  const safeWidth = width * (1 - (SIDE_PADDING_PERCENT * 2) / 100);
  let fontSize = FONT_SIZE * scale;
  const estimated = letters * MAX_EM_PER_CHAR * fontSize;
  if (estimated > safeWidth) fontSize *= safeWidth / estimated;

  // Базовую линию ставим на 23% высоты, а bottom отмеряет край блока — отсюда
  // поправка на зазор под базовой линией.
  const bottom = (BASELINE_PERCENT / 100) * height - fontSize * BASELINE_GAP_EM;

  return (
    <div
      style={{
        position: "absolute",
        bottom,
        left: 0,
        right: 0,
        textAlign: "center",
        padding: `0 ${SIDE_PADDING_PERCENT}%`,
        fontFamily: CAPTION_FONT_FAMILY,
        fontWeight: 700,
        fontSize,
        lineHeight: 1,
        letterSpacing: "-0.01em",
        color: INK,
        textTransform: "uppercase",
        // Слово не переносим: в референсе строка всегда одна.
        whiteSpace: "nowrap",
        opacity,
      }}
    >
      {word.text}
    </div>
  );
};
