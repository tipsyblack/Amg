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
import { Accents } from "./Accents";
import { Overlay } from "./Overlay";
import { Subtitles } from "./Subtitles";
import { CAPTION_FONT_FAMILY, loadCaptionFont } from "./font";
import { sceneMotion } from "./transitions";
import type { Overlay as OverlayData } from "../types";

loadCaptionFont();
const fontFamily = CAPTION_FONT_FAMILY;

// Пружина входа. 200 — это сильно передемпфированно: карточка подъезжала так
// медленно и мелко, что движение почти не читалось. 26 даёт быстрый вход с
// едва заметной посадкой на место, без болтанки.
const ENTRANCE_DAMPING = 26;
// У хука пружина мягче — карточка чуть перелетает и садится на место.
const HOOK_DAMPING = 14;
const IMAGE_ZOOM = 0.13; // насколько картинка подъезжает за сцену
const CAPTION_RISE = 72; // px, подъём подписи на входе
const CAPTION_DELAY = 5; // кадров: подпись появляется чуть позже карточки
// В хуке текст не ждёт: он и есть то, что цепляет.
const HOOK_CAPTION_DELAY = 2;
const HOOK_CAPTION_OVERSHOOT = 1.14;
// Наезд хука начинается не с точки: первый кадр ролика — это ещё и обложка в
// ленте, поэтому он должен быть непустым и читаемым сразу.
const HOOK_PUNCH_FROM = 0.78;

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

interface SceneProps {
  caption: string;
  // Слова озвучки с таймингами — для субтитров «по слову». Нет слов — нет и
  // субтитров, кадр остаётся как раньше.
  words?: { text: string; startMs: number; endMs: number }[];
  // Объект, который появляется поверх картинки, не заменяя её.
  overlay?: OverlayData;
  imageFileName?: string;
  imageWidth?: number;
  imageHeight?: number;
  sceneIndex: number;
  // Кроссфейд с предыдущей сценой: сколько кадров проявляется вся сцена
  // целиком, включая фон. У первой сцены — 0.
  fadeInFrames: number;
  // Длительность этой сцены с учётом перекрытия — по ней считается наплыв на
  // картинку. Из useVideoConfig пришла бы длина всего ролика.
  visualDuration: number;
  // С этого кадра сцена уходит: под ней уже проявляется следующая.
  exitStartFrame: number;
  // На стыке работает переход из библиотеки — своё движение карточки на этом
  // стыке отключаем, иначе два перехода наложатся друг на друга.
  plainEntry?: boolean;
  plainExit?: boolean;
}

export const Scene: React.FC<SceneProps> = ({
  caption,
  words,
  overlay,
  imageFileName,
  imageWidth,
  imageHeight,
  sceneIndex,
  fadeInFrames,
  visualDuration,
  exitStartFrame,
  plainEntry = false,
  plainExit = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const motion = sceneMotion(sceneIndex);

  const damping = motion.emphasis ? HOOK_DAMPING : ENTRANCE_DAMPING;
  const entrance = spring({ frame, fps, config: { damping } });
  const captionEntrance = spring({
    frame: frame - (motion.emphasis ? HOOK_CAPTION_DELAY : CAPTION_DELAY),
    fps,
    config: { damping },
  });

  // 0 → 1 за всю сцену: по этому идёт медленный наплыв на картинку.
  const progress = interpolate(
    frame,
    [0, Math.max(visualDuration - 1, 1)],
    [0, 1],
    { extrapolateRight: "clamp" },
  );

  // 0 → 1 на участке ухода сцены. У последней сцены участка нет (границы
  // совпадают) — тогда ухода не происходит вовсе.
  const exit =
    visualDuration > exitStartFrame
      ? interpolate(frame, [exitStartFrame, visualDuration], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

  // Проявление всей сцены поверх предыдущей — основа любого перехода.
  const sceneOpacity =
    fadeInFrames > 0
      ? interpolate(frame, [0, fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  // ——— движение картинки внутри карточки ———
  const zoom =
    motion.pan === "out"
      ? 1 + IMAGE_ZOOM * (1 - progress)
      : 1 + IMAGE_ZOOM * progress;
  const panX =
    motion.pan === "left"
      ? interpolate(progress, [0, 1], [26, -26])
      : motion.pan === "right"
        ? interpolate(progress, [0, 1], [-26, 26])
        : 0;
  const panY =
    motion.pan === "in" || motion.pan === "out"
      ? interpolate(progress, [0, 1], motion.pan === "in" ? [0, -20] : [-20, 0])
      : 0;

  // ——— появление карточки ———
  let cardScale = interpolate(entrance, [0, 1], [0.88, 1]);
  let cardX = 0;
  let cardY = interpolate(entrance, [0, 1], [34, 0]);
  let cardRotate = 0;
  // Хук не проявляется: он врубается на первом же кадре и только доезжает
  // масштабом. Проявление съело бы те самые полсекунды внимания.
  let cardOpacity = motion.emphasis
    ? 1
    : interpolate(entrance, [0, 0.6], [0, 1], { extrapolateRight: "clamp" });

  if (plainEntry) {
    // Кадр целиком уже въезжает переходом — карточке достаётся только лёгкий
    // масштаб, чтобы сцена не выглядела статичной картинкой.
    cardScale = interpolate(entrance, [0, 1], [0.96, 1]);
    cardX = 0;
    cardY = 0;
    cardOpacity = 1;
  } else if (motion.entry === "overlay") {
    // Наложение: карточка приходит крупнее и ложится поверх предыдущей.
    cardScale = interpolate(entrance, [0, 1], [1.32, 1]);
    cardY = interpolate(entrance, [0, 1], [-70, 0]);
  } else if (motion.entry === "slide") {
    cardX = interpolate(entrance, [0, 1], [780, 0]);
    cardY = 0;
  } else if (motion.entry === "punch") {
    cardScale = interpolate(
      entrance,
      [0, 1],
      [motion.emphasis ? HOOK_PUNCH_FROM : 0.62, 1],
    );
    cardY = 0;
  } else if (motion.entry === "swing") {
    cardRotate = interpolate(entrance, [0, 1], [-13, 0]);
    cardScale = interpolate(entrance, [0, 1], [0.84, 1]);
  }

  // ——— уход карточки (играет под проявляющейся следующей сценой) ———
  if (exit > 0 && !plainExit) {
    if (motion.exit === "crumple") {
      // Смятие: карточка резко сжимается, кренится и слегка перекашивается —
      // как комкают лист бумаги.
      cardScale *= interpolate(exit, [0, 1], [1, 0.32]);
      cardRotate += interpolate(exit, [0, 1], [0, 21]);
      cardY += interpolate(exit, [0, 1], [0, 130]);
      cardOpacity *= interpolate(exit, [0, 1], [1, 0.15]);
    } else if (motion.exit === "shrink") {
      cardScale *= interpolate(exit, [0, 1], [1, 0.76]);
      cardOpacity *= interpolate(exit, [0, 1], [1, 0.25]);
    } else if (motion.exit === "driftUp") {
      cardY += interpolate(exit, [0, 1], [0, -150]);
      cardOpacity *= interpolate(exit, [0, 1], [1, 0.15]);
    }
  }

  // Перекос применяем отдельно: он нужен только смятию.
  const crumpleSkew =
    motion.exit === "crumple" && !plainExit
      ? interpolate(exit, [0, 1], [0, 10])
      : 0;

  const captionShift = interpolate(captionEntrance, [0, 1], [CAPTION_RISE, 0]);
  // Подпись хука приходит крупнее и садится в размер — короткий удар по глазу.
  const captionScale = motion.emphasis
    ? interpolate(captionEntrance, [0, 1], [HOOK_CAPTION_OVERSHOOT, 1])
    : 1;
  // Подпись уходит быстрее карточки и до конца: иначе на удлинённом стыке
  // старый и новый текст видны одновременно и накладываются друг на друга.
  const captionExitFade =
    exit > 0 && !plainExit
      ? interpolate(exit, [0, 0.4], [1, 0], { extrapolateRight: "clamp" })
      : 1;
  const captionOpacity =
    (motion.emphasis
      ? 1
      : interpolate(captionEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        })) * captionExitFade;

  const card = (
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
          transform:
            `translate(${cardX}px, ${cardY}px) ` +
            `rotate(${cardRotate}deg) skewY(${crumpleSkew}deg) ` +
            `scale(${cardScale})`,
        }}
      >
        {imageFileName ? (
          <Img
            src={staticFile(`images/${imageFileName}`)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
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

        {/* Появляющийся объект лежит внутри карточки, поверх картинки: так он
            обрезается её рамкой и выглядит частью кадра, а не наклейкой на
            белом фоне. */}
        {overlay && (
          <Overlay overlay={overlay} exitProgress={plainExit ? 0 : exit} />
        )}
      </div>
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#ffffff",
        alignItems: "center",
        paddingTop: "9%",
        opacity: sceneOpacity,
      }}
    >
      {/* Акценты под карточкой: они украшение, а не содержание. */}
      <Accents sceneIndex={sceneIndex} exitProgress={plainExit ? 0 : exit} />

      {card}

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
          transform: `translateY(${captionShift}px) scale(${captionScale})`,
        }}
      >
        {caption}
      </div>

      {words && words.length > 0 && (
        <Subtitles words={words} exitProgress={plainExit ? 0 : exit} />
      )}
    </AbsoluteFill>
  );
};
