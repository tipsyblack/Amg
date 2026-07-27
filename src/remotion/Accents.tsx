import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Circle, makeArrow, Spark, Star } from "@remotion/shapes";
import { evolvePath, getLength } from "@remotion/paths";

// Графические акценты вокруг карточки: искра, звезда, стрелка, кольцо. Нужны,
// чтобы кадр не был «картинка плюс подпись» — но по одному на сцену, иначе
// внимание уходит с содержания. Набор перебирается по номеру сцены, как и
// движение, поэтому рендер остаётся повторяемым.
//
// Про размещение: карточка занимает 92% ширины и полосу 8-78% по высоте, ниже
// идут субтитры по словам. Свободна поэтому только полоска над карточкой — все
// акценты живут там. Первая версия стояла у верхнего угла карточки и почти
// целиком оказалась под ней: акценты рисуются ДО карточки, а та непрозрачная.

export type AccentKind = "none" | "spark" | "star" | "arrow" | "ring";

const CYCLE: AccentKind[] = [
  "spark",
  "none",
  "arrow",
  "star",
  "none",
  "ring",
  "none",
  "spark",
];

export function sceneAccent(index: number): AccentKind {
  return CYCLE[index % CYCLE.length];
}

const INK = "#0d0d0d";
// Акценты появляются позже карточки: сначала кадр, потом украшение.
const ACCENT_DELAY = 8;

interface AccentsProps {
  sceneIndex: number;
  // Акцент гаснет вместе с уходом сцены.
  exitProgress: number;
}

export const Accents: React.FC<AccentsProps> = ({
  sceneIndex,
  exitProgress,
}) => {
  const kind = sceneAccent(sceneIndex);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (kind === "none") return null;

  const appear = spring({
    frame: frame - ACCENT_DELAY,
    fps,
    config: { damping: 18 },
  });
  const opacity =
    interpolate(appear, [0, 0.6], [0, 1], { extrapolateRight: "clamp" }) *
    (exitProgress > 0
      ? interpolate(exitProgress, [0, 0.5], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 1);
  const scale = interpolate(appear, [0, 1], [0.4, 1]);

  if (kind === "spark") {
    // Искра у верхнего угла карточки — «вот тут интересное».
    return (
      <div
        style={{
          position: "absolute",
          top: "1%",
          right: "4%",
          opacity,
          transform: `scale(${scale}) rotate(${interpolate(frame, [0, 120], [0, 25])}deg)`,
        }}
      >
        <Spark width={112} height={140} edgeRoundness={0.9} fill={INK} />
      </div>
    );
  }

  if (kind === "star") {
    return (
      <div
        style={{
          position: "absolute",
          top: "1.5%",
          left: "5%",
          opacity: opacity * 0.9,
          transform: `scale(${scale}) rotate(${interpolate(frame, [0, 150], [-12, 12])}deg)`,
        }}
      >
        <Star innerRadius={26} outerRadius={62} points={5} fill={INK} />
      </div>
    );
  }

  if (kind === "ring") {
    // Кольцо-обводка пульсирует у нижнего края карточки.
    const pulse = 1 + Math.sin(frame / 9) * 0.04;
    return (
      <div
        style={{
          position: "absolute",
          top: "1.5%",
          right: "6%",
          opacity: opacity * 0.75,
          transform: `scale(${scale * pulse})`,
        }}
      >
        <Circle radius={64} fill="transparent" stroke={INK} strokeWidth={9} />
      </div>
    );
  }

  // Стрелка: контур берём у makeArrow из @remotion/shapes, но рисуем сами
  // обводкой — так линию можно «прочертить» на входе (evolvePath из
  // @remotion/paths режет контур по прогрессу).
  const arrow = makeArrow({
    length: 170,
    headWidth: 90,
    headLength: 60,
    shaftWidth: 22,
    direction: "right",
    cornerRadius: 6,
  });
  const length = getLength(arrow.path);
  const { strokeDashoffset } = evolvePath(
    interpolate(appear, [0, 1], [0, 1], { extrapolateRight: "clamp" }),
    arrow.path,
  );
  return (
    <div
      style={{
        position: "absolute",
        top: "1%",
        left: "4%",
        opacity,
        transform: "rotate(-24deg)",
      }}
    >
      <svg
        width={arrow.width}
        height={arrow.height}
        viewBox={`0 0 ${arrow.width} ${arrow.height}`}
      >
        <path
          d={arrow.path}
          fill="none"
          stroke={INK}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>
    </div>
  );
};
