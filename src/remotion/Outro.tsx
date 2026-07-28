import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CAPTION_FONT_FAMILY } from "./font";
import { CARD_RADIUS_PX, REF_WIDTH } from "./layout";
import type { Outro as OutroData } from "../types";

// Брендовая концовка. В референсе ролик заканчивается не последней сценой, а
// отдельным кадром: тёмная плашка со скруглёнными углами, логотип, название и
// строчка помельче под ним. Приходит она тем же зум-блюром, что и обычные
// сцены, — так концовка не выглядит приклеенной от другого ролика.
//
// Логотип необязателен: файла может не быть, и тогда кадр собирается из одного
// текста. Ставить <Img> на несуществующий файл нельзя — Remotion уронит рендер
// на последнем кадре, то есть после всей дорогой работы.

// Всё снято с кадра референса (1440×2562) и приведено к 1080×1920 — как и
// геометрия карточки в layout.ts, на глаз ничего не подбиралось.
//
// Плашка 1082×836 px, верх на 24% высоты кадра. Логотип — круг 398 px, то есть
// 36.8% ширины плашки. Названия: высота заглавных 122 px, подпись 55 px;
// просветы 54 px под кругом и 44 px между строками.
const CARD_WIDTH_PERCENT = 75.1;
const CARD_ASPECT = 1.294;
const CARD_TOP_PERCENT = 24;
// Цвет плашки взят пипеткой из того же кадра.
const CARD_BG = "#212d3a";
// Кегли считаем из высоты заглавных: у Oswald она занимает 0.839 em (это
// измерено на нашем рендере, см. Subtitles.tsx).
const TITLE_SIZE = Math.round((122 * 0.75) / 0.839);
const TAGLINE_SIZE = Math.round((55 * 0.75) / 0.839);
const LOGO_WIDTH_PERCENT = 36.8;
const LOGO_GAP = 54 * 0.75;
const TITLE_GAP = 44 * 0.75;

// Поля внутри плашки и запас по ширине буквы. Наш Oswald шире шрифта из
// референса (то же расхождение, что и в субтитрах), поэтому строка, которая там
// умещалась в одну, у нас переносилась и обрезалась нижним краем плашки.
// Поэтому не переносим вовсе, а ужимаем кегль под ширину.
const SIDE_PADDING_PERCENT = 6;
const MAX_EM_PER_CHAR = 0.55;

const ZOOM_FROM_SCALE = 2.4;
const BLUR_LAYERS = 6;
const BLUR_SPREAD = 0.18;

interface OutroProps {
  outro: OutroData;
  // Сколько кадров длится въезд.
  enterFrames: number;
}

export const Outro: React.FC<OutroProps> = ({ outro, enterFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = width / REF_WIDTH;

  const entrance = spring({ frame, fps, config: { damping: 26 } });
  const cardScale = interpolate(entrance, [0, 1], [ZOOM_FROM_SCALE, 1]);
  const progress = interpolate(frame, [0, Math.max(enterFrames, 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blur = interpolate(progress, [0, 0.75], [1, 0], {
    extrapolateRight: "clamp",
  });

  const cardWidth = (CARD_WIDTH_PERCENT / 100) * width;
  const logo = outro.logoFileName;

  // Кегль, при котором строка гарантированно умещается в одну.
  const safeWidth = cardWidth * (1 - (SIDE_PADDING_PERCENT * 2) / 100);
  const fit = (text: string, size: number): number => {
    const estimated = text.length * MAX_EM_PER_CHAR * size * scale;
    return estimated > safeWidth ? size * (safeWidth / estimated) : size;
  };
  const titleSize = fit(outro.title, TITLE_SIZE);
  const taglineSize = outro.tagline ? fit(outro.tagline, TAGLINE_SIZE) : 0;

  const content = (
    <>
      {logo && (
        <Img
          src={staticFile(`brand/${logo}`)}
          style={{ width: `${LOGO_WIDTH_PERCENT}%`, height: "auto" }}
        />
      )}
      <div
        style={{
          fontFamily: CAPTION_FONT_FAMILY,
          fontWeight: 700,
          fontSize: titleSize * scale,
          letterSpacing: "0.04em",
          color: "#ffffff",
          textTransform: "uppercase",
          textAlign: "center",
          whiteSpace: "nowrap",
          marginTop: logo ? LOGO_GAP * scale : 0,
        }}
      >
        {outro.title}
      </div>
      {outro.tagline && (
        <div
          style={{
            fontFamily: CAPTION_FONT_FAMILY,
            fontWeight: 700,
            fontSize: taglineSize * scale,
            letterSpacing: "0.06em",
            // В референсе подпись такая же белая, как название, — только
            // мельче. Серый читался как «неактивная» строка.
            color: "#ffffff",
            textTransform: "uppercase",
            textAlign: "center",
            whiteSpace: "nowrap",
            marginTop: TITLE_GAP * scale,
          }}
        >
          {outro.tagline}
        </div>
      )}
    </>
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#ffffff",
        alignItems: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          // Плашка стоит выше центра кадра — как в референсе.
          top: (CARD_TOP_PERCENT / 100) * height,
          width: cardWidth,
          height: cardWidth / CARD_ASPECT,
          transform: `scale(${cardScale})`,
        }}
      >
        {/* Копии плашки с растущим масштабом дают тот же зум-блюр, что и на
            стыках сцен: собственного радиального блюра в CSS нет. */}
        {blur > 0 &&
          Array.from({ length: BLUR_LAYERS }, (_, i) => (
            <div
              key={`blur-${i}`}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: CARD_RADIUS_PX * scale,
                backgroundColor: CARD_BG,
                opacity: blur / BLUR_LAYERS,
                transform: `scale(${1 + ((i + 1) / BLUR_LAYERS) * BLUR_SPREAD * blur})`,
              }}
            />
          ))}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: CARD_RADIUS_PX * scale,
            backgroundColor: CARD_BG,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {content}
        </div>
      </div>
    </AbsoluteFill>
  );
};
