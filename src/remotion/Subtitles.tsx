import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { CAPTION_FONT_FAMILY } from "./font";
import { buildSubtitlePages, pageAt } from "./subtitlePages";

// Субтитры «по слову»: слова появляются в такт речи, произносимое — в чёрной
// плашке. Это то, что держит внимание в Reels: глаз цепляется за движение
// текста, даже если звук выключен. Разбивка на страницы — в subtitlePages.ts.

// Кегль и отступ снизу: на телефоне субтитры должны читаться с расстояния, а
// нижние 8-10% кадра перекрывает интерфейс площадки (подписи, кнопки).
// Отступ 13%, а не 10%: подписи под картинкой больше нет, и субтитры подняты
// ближе к карточке — иначе между ними висит белая полоса.
const FONT_SIZE = 60;
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
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;

  const page = pageAt(buildSubtitlePages(words), timeMs);
  if (!page) return null;

  const opacity =
    exitProgress > 0
      ? interpolate(exitProgress, [0, 0.4], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 1;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "13%",
        left: 0,
        right: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: "0.25em",
        padding: "0 8%",
        fontFamily: CAPTION_FONT_FAMILY,
        fontWeight: 700,
        fontSize: FONT_SIZE,
        lineHeight: 1.15,
        textTransform: "uppercase",
        opacity,
      }}
    >
      {page.tokens.map((token, index) => {
        const active = timeMs >= token.fromMs && timeMs < token.toMs;
        return (
          <span
            key={`${token.fromMs}-${index}`}
            style={{
              color: active ? "#ffffff" : INK,
              backgroundColor: active ? INK : "transparent",
              borderRadius: 10,
              padding: active ? "0.05em 0.22em" : "0.05em 0",
              // Произносимое слово чуть крупнее — движение видно и без цвета.
              transform: active ? "scale(1.06)" : "scale(1)",
            }}
          >
            {token.text}
          </span>
        );
      })}
    </div>
  );
};
