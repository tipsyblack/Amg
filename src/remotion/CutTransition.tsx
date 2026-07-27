import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
// Классические пресентации лежат в отдельных точках входа пакета — в
// основном индексе их нет.
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { flip } from "@remotion/transitions/flip";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { LibraryTransition } from "./transitions";

// Готовые переходы из @remotion/transitions. Своими руками они уже написаны на
// уровне карточки (смятие, наложение, выезд); библиотека даёт другой класс —
// переходы всего кадра целиком: шторка, переворот, круговая развёртка.
//
// Пресентации в библиотеке рассчитаны на TransitionSeries, но сами компоненты
// зависят только от прогресса и направления, поэтому мы используем их внутри
// собственных Sequence: TransitionSeries сдвинул бы тайминги, а у нас на них
// завязана озвучка (сцены обязаны остаться на своих кадрах).

// У каждой пресентации свой тип props (ClockWipeProps, FlipProps и так далее),
// и общего супертипа у них нет — поэтому фабрика отдаёт «какую-нибудь»
// пресентацию, а на месте отрисовки тип сужается до реально нужных полей.
// В полном типе есть ещё поля для канвасных переходов
// (onElementImage/onUnmount/bothEnteringAndExiting) — шторка, переворот и
// круговая развёртка их не читают.
interface AnyPresentation {
  component: unknown;
  props: unknown;
}

type PresentationComponentProps = {
  presentationProgress: number;
  presentationDirection: "entering" | "exiting";
  passedProps: Record<string, unknown>;
  children: React.ReactNode;
};

// Не хук: обычная фабрика, поэтому её можно звать после раннего выхода.
function buildPresentation(
  kind: LibraryTransition,
  width: number,
  height: number,
): AnyPresentation {
  switch (kind) {
    case "wipe":
      // Шторка снизу вверх — хорошо читается в вертикальном кадре.
      return wipe({ direction: "from-bottom" });
    case "flip":
      return flip({ direction: "from-right", perspective: 1600 });
    case "clockWipe":
      // Круговой развёртке нужны размеры кадра: она строит сектор круга.
      return clockWipe({ width, height });
    case "slide":
      return slide({ direction: "from-right" });
  }
}

interface CutTransitionProps {
  // Переход, которым эта сцена появляется (задан предыдущей сценой).
  entering?: LibraryTransition;
  // Переход, которым эта сцена уходит.
  exiting?: LibraryTransition;
  // Сколько кадров длится появление и с какого кадра начинается уход.
  transitionFrames: number;
  exitStartFrame: number;
  visualDuration: number;
  children: React.ReactNode;
}

/**
 * Оборачивает сцену в переход из библиотеки — на входе, на выходе или никак.
 * Одновременно и то и другое не бывает: перекрытие короткое, а сцены длинные.
 */
export const CutTransition: React.FC<CutTransitionProps> = ({
  entering,
  exiting,
  transitionFrames,
  exitStartFrame,
  visualDuration,
  children,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const inEnterWindow = Boolean(entering) && frame < transitionFrames;
  const inExitWindow = Boolean(exiting) && frame >= exitStartFrame;

  if (!inEnterWindow && !inExitWindow) {
    return <>{children}</>;
  }

  const kind = (inEnterWindow ? entering : exiting) as LibraryTransition;
  const presentation = buildPresentation(kind, width, height);
  const Component =
    presentation.component as React.FC<PresentationComponentProps>;

  const progress = inEnterWindow
    ? Math.min(frame / Math.max(transitionFrames, 1), 1)
    : Math.min(
        (frame - exitStartFrame) /
          Math.max(visualDuration - exitStartFrame, 1),
        1,
      );

  return (
    <Component
      presentationProgress={progress}
      presentationDirection={inEnterWindow ? "entering" : "exiting"}
      passedProps={presentation.props as Record<string, unknown>}
    >
      {children}
    </Component>
  );
};
