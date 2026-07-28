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
import {
  CARD_BORDER_PX,
  CARD_RADIUS_PX,
  CARD_TOP_PERCENT,
  CARD_WIDTH_PERCENT,
  REF_WIDTH,
  cardAspect,
} from "./layout";
import { sceneMotion } from "./transitions";
import type { Overlay as OverlayData } from "../types";

// Шрифт грузим здесь же: им набраны субтитры, а в самой сцене остался только
// текст заглушки на случай отсутствия картинки.
loadCaptionFont();
const fontFamily = CAPTION_FONT_FAMILY;

// Пружина входа. 200 — это сильно передемпфированно: карточка подъезжала так
// медленно и мелко, что движение почти не читалось. 26 даёт быстрый вход с
// едва заметной посадкой на место, без болтанки.
const ENTRANCE_DAMPING = 26;
// У хука пружина мягче — карточка чуть перелетает и садится на место.
const HOOK_DAMPING = 14;
// Влёт повёрнутой карточкой: приходит крупнее кадра и под углом.
const SPIN_FROM_SCALE = 1.28;
const SPIN_FROM_DEG = -9;
// Тасовка: сколько карточек проходит перед основной, с каким шагом по времени
// и сколько живёт каждая. Больше трёх копий — каша, меньше двух — не читается
// как перебор. Время жизни задаём в долях секунды, а не пружиной: пружина к
// единице только стремится, и копии оставались на экране еле заметными
// контурами до конца сцены.
const SHUFFLE_COPIES = 2;
const SHUFFLE_STEP_SECONDS = 0.05;
const SHUFFLE_LIFE_SECONDS = 0.22;
// Наезда на картинку нет намеренно. В референсе иллюстрация стоит мёртво —
// я мерил покадровую разницу внутри рамки, 0.00-0.15 из 255 на протяжении
// полутора секунд. Вся жизнь кадра там в стыках и в маскоте, а не в ползающей
// картинке; с нашим наездом мягкий стык переставал читаться как мягкий.
// Наезд хука начинается не с точки: первый кадр ролика — это ещё и обложка в
// ленте, поэтому он должен быть непустым и читаемым сразу.
const HOOK_PUNCH_FROM = 0.78;

interface SceneProps {
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
  const { fps, width, height } = useVideoConfig();
  const scale = width / REF_WIDTH;
  const motion = sceneMotion(sceneIndex);

  const damping = motion.emphasis ? HOOK_DAMPING : ENTRANCE_DAMPING;
  const entrance = spring({ frame, fps, config: { damping } });

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

  // ——— появление карточки ———
  let cardScale = interpolate(entrance, [0, 1], [0.88, 1]);
  let cardX = 0;
  let cardY = interpolate(entrance, [0, 1], [34, 0]);
  let cardRotate = 0;
  // Отдельный масштаб по горизонтали — только для схлопывания.
  let squeezeX = 1;
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
  } else if (motion.entry === "spin" || motion.entry === "shuffle") {
    // Карточка влетает крупнее кадра и повёрнутой, с промахом мимо центра, и
    // раскручивается на место — как брошенная на стол карта. У тасовки то же
    // движение: она отличается копиями, которые проходят перед ней (ниже).
    cardScale = interpolate(entrance, [0, 1], [SPIN_FROM_SCALE, 1]);
    cardRotate = interpolate(entrance, [0, 1], [SPIN_FROM_DEG, 0]);
    cardX = interpolate(entrance, [0, 1], [-90, 0]);
    cardY = interpolate(entrance, [0, 1], [40, 0]);
    cardOpacity = 1;
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
    } else if (motion.exit === "squeeze") {
      // Схлопывание по горизонтали: карточка сжимается в вертикальную полоску.
      // Масштаб по X ведём отдельно от общего — иначе она просто уменьшится.
      squeezeX = interpolate(exit, [0, 1], [1, 0.02]);
      cardRotate += interpolate(exit, [0, 1], [0, -3]);
      cardOpacity *= interpolate(exit, [0.7, 1], [1, 0], {
        extrapolateLeft: "clamp",
      });
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

  // Тасовка: перед основной карточкой проходят её копии — те же пропорции и
  // рамка, но пустые и приглушённые. Каждая стартует на несколько кадров
  // раньше, поэтому в кадре они оказываются внахлёст и читаются как перебор
  // колоды. Копии рисуем только на входе: дальше они не нужны.
  const shuffleGhosts =
    motion.entry === "shuffle" && !plainEntry
      ? Array.from({ length: SHUFFLE_COPIES }, (_, i) => {
          // Копии стартуют раньше основной карточки: чем дальше копия, тем
          // раньше она началась и тем дальше уже ушла.
          const lead = (SHUFFLE_COPIES - i) * SHUFFLE_STEP_SECONDS * fps;
          const ghost = (frame + lead) / (SHUFFLE_LIFE_SECONDS * fps);
          if (ghost >= 1) return null;
          return (
            <div
              key={`ghost-${i}`}
              style={{
                position: "absolute",
                width: `${CARD_WIDTH_PERCENT}%`,
                aspectRatio: String(cardAspect(imageWidth, imageHeight)),
                border: `${CARD_BORDER_PX * scale}px solid #0d0d0d`,
                borderRadius: CARD_RADIUS_PX * scale,
                overflow: "hidden",
                backgroundColor: "#ececeb",
                opacity: interpolate(ghost, [0.55, 1], [1, 0], {
                  extrapolateLeft: "clamp",
                }),
                transform:
                  `translate(${interpolate(ghost, [0, 1], [-120, 90])}px, ` +
                  `${interpolate(ghost, [0, 1], [50, -30])}px) ` +
                  `rotate(${interpolate(ghost, [0, 1], [SPIN_FROM_DEG - 4, 8])}deg) ` +
                  `scale(${interpolate(ghost, [0, 1], [SPIN_FROM_SCALE, 1])})`,
              }}
            >
              {/* Внутри копии та же картинка: пустые листы читаются как брак
                  вёрстки, а не как перебираемая колода. */}
              {imageFileName && (
                <Img
                  src={staticFile(`images/${imageFileName}`)}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
            </div>
          );
        })
      : null;

  const card = (
      <div
        style={{
          width: `${CARD_WIDTH_PERCENT}%`,
          aspectRatio: String(cardAspect(imageWidth, imageHeight)),
          border: `${CARD_BORDER_PX * scale}px solid #0d0d0d`,
          borderRadius: CARD_RADIUS_PX * scale,
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
            `scale(${cardScale * squeezeX}, ${cardScale})`,
        }}
      >
        {imageFileName ? (
          <Img
            src={staticFile(`images/${imageFileName}`)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
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
        // Отступ считаем в пикселях от высоты кадра. Процентный padding в CSS
        // отмеряется от ШИРИНЫ контейнера — на вертикальном кадре это давало
        // почти вдвое меньший отступ, и карточка стояла выше, чем в референсе.
        paddingTop: (CARD_TOP_PERCENT / 100) * height,
        opacity: sceneOpacity,
      }}
    >
      {/* Акценты под карточкой: они украшение, а не содержание. */}
      <Accents sceneIndex={sceneIndex} exitProgress={plainExit ? 0 : exit} />

      {shuffleGhosts}
      {card}

      {words && words.length > 0 && (
        <Subtitles words={words} exitProgress={plainExit ? 0 : exit} />
      )}
    </AbsoluteFill>
  );
};
