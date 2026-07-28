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

// Пропорции сняты с кадра референса и приведены к 1080×1920.
const CARD_WIDTH_PERCENT = 62;
const CARD_ASPECT = 1.42;
const CARD_BG = "#1c2530";
const TITLE_SIZE = 66;
const TAGLINE_SIZE = 24;
const LOGO_WIDTH_PERCENT = 46;

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
  const { fps, width } = useVideoConfig();
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
          fontSize: TITLE_SIZE * scale,
          letterSpacing: "0.04em",
          color: "#ffffff",
          textTransform: "uppercase",
          textAlign: "center",
          marginTop: logo ? 28 * scale : 0,
        }}
      >
        {outro.title}
      </div>
      {outro.tagline && (
        <div
          style={{
            fontFamily: CAPTION_FONT_FAMILY,
            fontWeight: 700,
            fontSize: TAGLINE_SIZE * scale,
            letterSpacing: "0.06em",
            color: "#c9d3e0",
            textTransform: "uppercase",
            textAlign: "center",
            marginTop: 10 * scale,
            padding: "0 8%",
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
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "relative",
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
