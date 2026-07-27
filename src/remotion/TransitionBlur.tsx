import React from "react";
import { useCurrentFrame } from "remotion";
import { CameraMotionBlur } from "@remotion/motion-blur";
import { MIX } from "./mix";

// Motion blur на кадрах перехода. Оборачивать нужно сцену целиком: сам
// CameraMotionBlur рендерит AbsoluteFill, и если завернуть в него только
// карточку, та выпадет из потока и подпись подъедет на её место.
//
// Включаем смаз только там, где есть быстрое движение — на въезде и на уходе.
// Библиотека рендерит поддерево samples раз за кадр, поэтому на всём ролике это
// умножило бы время рендера, а в статике смазывать нечего.

interface TransitionBlurProps {
  // Сколько кадров длится въезд сцены и с какого кадра начинается уход.
  enterFrames: number;
  exitStartFrame: number;
  // Стык делает переход из библиотеки: он и так двигает весь кадр, смаз только
  // размылил бы шторку.
  disabled?: boolean;
  children: React.ReactNode;
}

export const TransitionBlur: React.FC<TransitionBlurProps> = ({
  enterFrames,
  exitStartFrame,
  disabled = false,
  children,
}) => {
  const frame = useCurrentFrame();
  const moving = frame < enterFrames || frame >= exitStartFrame;

  if (disabled || !moving) return <>{children}</>;

  return (
    <CameraMotionBlur
      samples={MIX.blurSamples}
      shutterAngle={MIX.blurShutterAngle}
    >
      {children}
    </CameraMotionBlur>
  );
};
