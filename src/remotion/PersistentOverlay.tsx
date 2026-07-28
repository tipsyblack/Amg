import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Overlay } from "./Overlay";
import {
  CARD_ASPECT,
  CARD_TOP_PERCENT,
  CARD_WIDTH_PERCENT,
} from "./layout";
import type { Overlay as OverlayData } from "../types";

// Объект, который переживает стык сцен.
//
// Обычный появляющийся объект живёт внутри карточки и уходит вместе со своей
// сценой. Здесь другой приём из референса: предмет висит неподвижно, а картинка
// под ним меняется целиком — так две сцены связываются в одну мысль. Значит
// рисовать его надо не внутри сцены, а отдельным слоем поверх обеих.
//
// Из-за этого он не обрезается рамкой карточки, а лежит поверх неё. Коробку под
// него строим по геометрии карточки, чтобы «сверху справа» означало тот же угол,
// что и у обычного объекта. Пропорции берём эталонные: чья именно картинка под
// ним окажется в момент стыка — вопрос без ответа, их там две.

interface PersistentOverlayProps {
  overlay: OverlayData;
  // Сколько кадров объект гаснет в конце — уже на новой сцене.
  fadeOutFrames: number;
  totalFrames: number;
}

export const PersistentOverlay: React.FC<PersistentOverlayProps> = ({
  overlay,
  fadeOutFrames,
  totalFrames,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const fadeStart = Math.max(totalFrames - fadeOutFrames, 0);
  const exitProgress =
    frame > fadeStart && fadeOutFrames > 0
      ? interpolate(frame, [fadeStart, totalFrames], [0, 1], {
          extrapolateRight: "clamp",
        })
      : 0;

  const cardWidth = (CARD_WIDTH_PERCENT / 100) * width;

  return (
    <AbsoluteFill style={{ alignItems: "center" }}>
      <div
        style={{
          position: "absolute",
          top: (CARD_TOP_PERCENT / 100) * height,
          width: cardWidth,
          height: cardWidth / CARD_ASPECT,
        }}
      >
        {/* startMs уже учтён снаружи — Sequence начинается ровно в момент
            появления, поэтому здесь объект показываем с нулевого кадра. */}
        <Overlay
          overlay={{ ...overlay, startMs: 0 }}
          exitProgress={exitProgress}
        />
      </div>
    </AbsoluteFill>
  );
};
