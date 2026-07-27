import React from "react";
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Overlay as OverlayData } from "../types";

// Объект, который появляется поверх картинки сцены. Картинка при этом не
// меняется: зритель видит тот же кадр, в который что-то «прилетело». Файл —
// PNG с прозрачным фоном из public/overlays (фон вырезан в пайплайне).

// Появление: короткий упругий наскок с перелётом. Объект должен «прилететь», а
// не проявиться — иначе его не замечают.
const POP_DAMPING = 11;
const POP_FROM_SCALE = 0.3;
// Небольшое покачивание после появления — объект выглядит живым, а не
// приклеенным.
const IDLE_TILT_DEG = 2.5;
const IDLE_PERIOD_FRAMES = 40;

function anchorStyle(anchor: OverlayData["anchor"]): React.CSSProperties {
  const inset = "4%";
  switch (anchor) {
    case "topLeft":
      return { top: inset, left: inset };
    case "topRight":
      return { top: inset, right: inset };
    case "bottomLeft":
      return { bottom: inset, left: inset };
    case "bottomRight":
      return { bottom: inset, right: inset };
    case "center":
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
  }
}

interface OverlayProps {
  overlay: OverlayData;
  // Прогресс ухода сцены: объект гаснет вместе с ней.
  exitProgress: number;
}

export const Overlay: React.FC<OverlayProps> = ({ overlay, exitProgress }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = (overlay.startMs / 1000) * fps;
  if (frame < startFrame) return null;

  const pop = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: POP_DAMPING },
  });
  const scale = interpolate(pop, [0, 1], [POP_FROM_SCALE, 1]);
  const opacity =
    interpolate(pop, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }) *
    (exitProgress > 0
      ? interpolate(exitProgress, [0, 0.5], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 1);
  const tilt =
    Math.sin((frame - startFrame) / IDLE_PERIOD_FRAMES) * IDLE_TILT_DEG;

  const positioning = anchorStyle(overlay.anchor);
  const baseTransform =
    overlay.anchor === "center" ? "translate(-50%, -50%) " : "";

  return (
    <div
      style={{
        position: "absolute",
        ...positioning,
        width: `${overlay.widthPercent}%`,
        opacity,
        transform: `${baseTransform}scale(${scale}) rotate(${tilt}deg)`,
        // Тень отделяет объект от картинки под ним: без неё наложение
        // читается как часть иллюстрации.
        filter: "drop-shadow(0 10px 18px rgba(0, 0, 0, 0.28))",
      }}
    >
      <Img
        src={staticFile(`overlays/${overlay.fileName}`)}
        style={{ width: "100%", height: "auto", display: "block" }}
      />
    </div>
  );
};
