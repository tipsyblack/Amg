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
import { CAPTION_FONT_FAMILY, loadCaptionFont } from "./font";

loadCaptionFont();
const fontFamily = CAPTION_FONT_FAMILY;

// Единый язык движения: все сцены анимируются одинаково, меняется только
// направление наплыва — чтобы ролик читался как одно целое.
const ENTRANCE_DAMPING = 200;
const IMAGE_ZOOM = 0.07; // насколько картинка подъезжает за сцену
const CARD_DRIFT = 14; // px, вертикальный сдвиг карточки на входе
const CAPTION_RISE = 46; // px, подъём подписи на входе
const CAPTION_DELAY = 5; // кадров: подпись появляется чуть позже карточки

// Пропорции карточки, если размеры картинки неизвестны — как в референсе.
const DEFAULT_CARD_ASPECT = 0.74;
// Границы: слишком узкая карточка выдавила бы подпись за кадр, слишком
// широкая перестала бы походить на референс.
const MIN_CARD_ASPECT = 0.66;
const MAX_CARD_ASPECT = 1;

/**
 * Карточка повторяет пропорции самой картинки: модели иногда отдают квадрат
 * вместо вертикали, и жёсткая рамка обрезала бы его по бокам.
 */
function cardAspect(width?: number, height?: number): number {
  if (!width || !height) return DEFAULT_CARD_ASPECT;
  return Math.min(Math.max(width / height, MIN_CARD_ASPECT), MAX_CARD_ASPECT);
}

interface SceneProps {
  caption: string;
  imageFileName?: string;
  imageWidth?: number;
  imageHeight?: number;
  sceneIndex: number;
  // Кроссфейд со предыдущей сценой: сколько кадров проявляется вся сцена
  // целиком, включая фон. У первой сцены — 0.
  fadeInFrames: number;
  // Длительность этой сцены с учётом перекрытия — по ней считается наплыв на
  // картинку. Из useVideoConfig пришла бы длина всего ролика.
  visualDuration: number;
}

/**
 * Подпись набирается в одну-две строки, поэтому длинным словам нужен меньший
 * кегль — иначе они вылезают за поля и каждая сцена смотрится по-своему.
 */
function captionFontSize(caption: string): number {
  const longestWord = Math.max(...caption.split(/\s+/).map((w) => w.length), 1);
  if (longestWord > 13) return 62;
  if (longestWord > 10) return 74;
  if (caption.length > 26) return 78;
  return 92;
}

export const Scene: React.FC<SceneProps> = ({
  caption,
  imageFileName,
  imageWidth,
  imageHeight,
  sceneIndex,
  fadeInFrames,
  visualDuration,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    config: { damping: ENTRANCE_DAMPING },
  });
  const captionEntrance = spring({
    frame: frame - CAPTION_DELAY,
    fps,
    config: { damping: ENTRANCE_DAMPING },
  });

  // Медленный наплыв на картинку весь кадр — оживляет статичную иллюстрацию.
  // Направление чередуется по номеру сцены, но задано детерминированно.
  const progress = interpolate(
    frame,
    [0, Math.max(visualDuration - 1, 1)],
    [0, 1],
    { extrapolateRight: "clamp" },
  );

  // Проявление всей сцены поверх предыдущей — это и есть переход.
  const sceneOpacity =
    fadeInFrames > 0
      ? interpolate(frame, [0, fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const zoomsIn = sceneIndex % 2 === 0;
  const imageScale = zoomsIn
    ? 1 + IMAGE_ZOOM * progress
    : 1 + IMAGE_ZOOM * (1 - progress);
  const imageShift = interpolate(progress, [0, 1], zoomsIn ? [0, -10] : [-10, 0]);

  const cardScale = interpolate(entrance, [0, 1], [0.94, 1]);
  const cardShift = interpolate(entrance, [0, 1], [CARD_DRIFT, 0]);
  const cardOpacity = interpolate(entrance, [0, 0.6], [0, 1], {
    extrapolateRight: "clamp",
  });

  const captionShift = interpolate(captionEntrance, [0, 1], [CAPTION_RISE, 0]);
  const captionOpacity = interpolate(captionEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#ffffff",
        alignItems: "center",
        paddingTop: "9%",
        opacity: sceneOpacity,
      }}
    >
      <div
        style={{
          width: "82%",
          aspectRatio: String(cardAspect(imageWidth, imageHeight)),
          border: "10px solid #0d0d0d",
          borderRadius: 28,
          overflow: "hidden",
          backgroundColor: "#ececeb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: cardOpacity,
          transform: `translateY(${cardShift}px) scale(${cardScale})`,
        }}
      >
        {imageFileName ? (
          <Img
            src={staticFile(`images/${imageFileName}`)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${imageScale}) translateY(${imageShift}px)`,
            }}
          />
        ) : (
          <div
            style={{
              fontFamily,
              fontSize: 32,
              color: "#9a9a97",
              textAlign: "center",
              padding: "0 10%",
            }}
          >
            изображение сцены
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "6%",
          padding: "0 6%",
          fontFamily,
          fontWeight: 700,
          fontSize: captionFontSize(caption),
          lineHeight: 1.05,
          letterSpacing: "-0.01em",
          color: "#0d0d0d",
          textTransform: "uppercase",
          textAlign: "center",
          opacity: captionOpacity,
          transform: `translateY(${captionShift}px)`,
        }}
      >
        {caption}
      </div>
    </AbsoluteFill>
  );
};
