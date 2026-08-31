import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import {
  TAP_CYCLE_SECONDS,
  TAP_HIT_SECONDS,
  tapProgress,
  type TapKind,
} from "./tap";

/**
 * Подсказка «нажми сюда» поверх кадра гайда.
 *
 * Рисуется нами, а не моделью: модель промахивается мимо кнопки, а здесь
 * координата задана явно и совпадает со звуком щелчка (моменты касаний
 * считает tap.ts, и та же функция расставляет звук в VideoComposition).
 *
 * Все пять видов подчиняются одному ритму: подъезд — касание — отход. Меняется
 * не тайминг, а форма, потому что читаемость даёт именно смена формы, а
 * разнобой в ритме выглядел бы неаккуратно.
 */

const INK = "#0d0d0d";
// Акцент, которым помечается нажатие. Тёплый красный на приглушённых экранах
// виден сразу и не спорит с синим маскотом.
const ACCENT = "#e0553f";

export interface TapProps {
  kind: TapKind;
  /** Куда показывать, в процентах от карточки. */
  xPercent: number;
  yPercent: number;
  /** Длительность сцены — по ней считаются повторы. */
  durationInFrames: number;
  /** Размер карточки в пикселях: от него зависит масштаб подсказки. */
  width: number;
  height: number;
}

export const Tap: React.FC<TapProps> = ({
  kind,
  xPercent,
  yPercent,
  durationInFrames,
  width,
  height,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { active, sinceStart } = tapProgress(frame, durationInFrames, fps);
  if (!active) return null;

  const hit = TAP_HIT_SECONDS * fps;
  const cycle = TAP_CYCLE_SECONDS * fps;
  // 0 — только появилась, 1 — касание, дальше уход.
  const approach = interpolate(sinceStart, [0, hit], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const after = Math.max(0, sinceStart - hit);
  const leave = interpolate(after, [0, cycle - hit], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Появление и исчезновение: резкое появление читается как сбой рендера.
  const opacity =
    interpolate(sinceStart, [0, hit * 0.35], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(leave, [0.55, 1], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // Отдача от касания: короткое сжатие сразу после удара.
  const press = interpolate(after, [0, fps * 0.09, fps * 0.3], [1, 0.82, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const unit = Math.min(width, height);
  const left = `${xPercent}%`;
  const top = `${yPercent}%`;
  const stroke = Math.max(3, Math.round(unit * 0.012));

  const common: React.CSSProperties = {
    position: "absolute",
    left,
    top,
    opacity,
    pointerEvents: "none",
  };

  if (kind === "ring") {
    // Кольцо стягивается к точке и щёлкает по ней.
    const size = unit * interpolate(approach, [0, 1], [0.42, 0.16]);
    return (
      <div
        style={{
          ...common,
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          borderRadius: "50%",
          border: `${stroke}px solid ${ACCENT}`,
          boxShadow: `0 0 0 ${Math.round(stroke / 2)}px rgba(13,13,13,0.15)`,
          transform: `scale(${press})`,
        }}
      />
    );
  }

  if (kind === "ripple") {
    // Волна от касания — как круг на воде: расходится ПОСЛЕ удара.
    const dot = unit * 0.055;
    const wave = unit * interpolate(leave, [0, 1], [0.06, 0.5], {
      extrapolateRight: "clamp",
    });
    return (
      <>
        <div
          style={{
            ...common,
            width: wave,
            height: wave,
            marginLeft: -wave / 2,
            marginTop: -wave / 2,
            borderRadius: "50%",
            border: `${stroke}px solid ${ACCENT}`,
            opacity: opacity * interpolate(leave, [0, 1], [0.9, 0]),
          }}
        />
        <div
          style={{
            ...common,
            width: dot,
            height: dot,
            marginLeft: -dot / 2,
            marginTop: -dot / 2,
            borderRadius: "50%",
            backgroundColor: ACCENT,
            border: `${Math.round(stroke * 0.7)}px solid ${INK}`,
            transform: `scale(${press})`,
          }}
        />
      </>
    );
  }

  if (kind === "frame") {
    // Обводка кнопки: прямоугольник обхватывает место нажатия.
    const w = unit * interpolate(approach, [0, 1], [0.72, 0.56]);
    const h = w * 0.26;
    return (
      <div
        style={{
          ...common,
          width: w,
          height: h,
          marginLeft: -w / 2,
          marginTop: -h / 2,
          borderRadius: h * 0.32,
          border: `${stroke}px solid ${ACCENT}`,
          backgroundColor: `rgba(224,85,63,${0.12 * (1 - leave)})`,
          transform: `scale(${press})`,
        }}
      />
    );
  }

  if (kind === "arrow") {
    // Стрелка снизу-справа, подрагивает и тычет в место нажатия.
    const size = unit * 0.16;
    const nudge = size * interpolate(approach, [0, 1], [0.55, 0.05]);
    return (
      <div
        style={{
          ...common,
          width: size,
          height: size,
          // Остриё стрелки в рисунке — в точке (14, 14) из ста: сдвигаем на
          // неё, чтобы стрелка показывала в кнопку, а не рядом с ней.
          marginLeft: -size * 0.14,
          marginTop: -size * 0.14,
          transform: `translate(${nudge}px, ${nudge}px) scale(${press})`,
          transformOrigin: "14% 14%",
        }}
      >
        <svg viewBox="0 0 100 100" width={size} height={size}>
          <path
            // Стрелка с ОДНИМ остриём: первый вариант оказался двусторонним
            // — на рендере это видно сразу, а по коду пути не читается.
            d="M14 14 L50 18 L38 30 L88 80 L80 88 L30 38 L18 50 Z"
            fill={ACCENT}
            stroke={INK}
            strokeWidth={7}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }

  // cursor — курсор-стрелка подъезжает к точке и щёлкает.
  //
  // Смещение не на глаз: остриё в рисунке стоит в точке (18, 8) из ста, и
  // курсор сдвигается ровно на неё. Иначе он показывает мимо кнопки — а
  // ради точности всё и затевалось.
  const size = unit * 0.15;
  const TIP_X = 0.18;
  const TIP_Y = 0.08;
  const travel = size * interpolate(approach, [0, 1], [1.1, 0]);
  return (
    <div
      style={{
        ...common,
        width: size,
        height: size,
        marginLeft: -size * TIP_X,
        marginTop: -size * TIP_Y,
        transform: `translate(${travel}px, ${travel}px) scale(${press})`,
        // Сжатие от касания идёт от острия, а не от середины картинки.
        transformOrigin: `${TIP_X * 100}% ${TIP_Y * 100}%`,
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <path
          d="M18 8 L18 78 L36 62 L48 92 L64 84 L52 56 L76 54 Z"
          fill="#ffffff"
          stroke={INK}
          strokeWidth={8}
          strokeLinejoin="round"
        />
      </svg>
      {/* Вспышка в момент касания: без неё щелчок слышно, но не видно. */}
      <div
        style={{
          position: "absolute",
          left: `${TIP_X * 100}%`,
          top: `${TIP_Y * 100}%`,
          width: size * 0.9,
          height: size * 0.9,
          marginLeft: -size * 0.45,
          marginTop: -size * 0.45,
          borderRadius: "50%",
          border: `${stroke}px solid ${ACCENT}`,
          opacity: interpolate(after, [0, fps * 0.35], [0.9, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(after, [0, fps * 0.35], [0.5, 1.6], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })})`,
        }}
      />
    </div>
  );
};
