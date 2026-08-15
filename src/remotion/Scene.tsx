import React from "react";
import {
  AbsoluteFill,
  Freeze,
  Img,
  OffthreadVideo,
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
import { mascotBox } from "./mascot";

// Дыхание маскота: период и размах. Период длиннее, чем у покачивания
// объектов (1.33 с) — персонаж крупный, и быстрое колебание на нём читалось бы
// как дрожь, а не как дыхание.
const MASCOT_BREATH_SECONDS = 3.2;
// Размах по вертикали в процентах высоты кадра и добавка к масштабу.
// Держим на грани заметности: движение должно ощущаться, а не бросаться в
// глаза — иначе персонаж начинает плавать по кадру.
const MASCOT_BREATH_PERCENT = 0.45;
const MASCOT_BREATH_SCALE = 0.006;
import { MIX } from "./mix";
import { coversFrame, sceneMotion } from "./transitions";
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
// Зум-блюр: с какого масштаба приходит карточка (2.2 — она перекрывает кадр
// целиком, то есть картинка идёт «во весь экран», как в референсе) и из
// скольких копий собирается смаз. Настоящий радиальный блюр в CSS взять
// неоткуда: filter: blur() размывает равномерно и даёт мутное пятно вместо
// полос от центра. Классический приём — стопка копий с растущим масштабом,
// каждая с малой прозрачностью; шесть копий уже читаются как полосы.
const ZOOM_FROM_SCALE = 2.2;
const ZOOM_BLUR_LAYERS = 6;
const ZOOM_BLUR_SPREAD = 0.16;
// Медленного наезда на картинку нет намеренно: в референсе иллюстрация стоит
// мёртво — покадровая разница внутри рамки 0.00-0.15 из 255 на протяжении
// полутора секунд, и с нашим наездом мягкий стык переставал читаться как мягкий.
//
// Но «стоит мёртво» не значит «не меняется». Тот замер я делал на спокойном
// участке и пропустил главное: внутри сцены иллюстрация РЕЗКО МЕНЯЕТСЯ на
// другую — 13 раз за 62 секунды во втором референсе. Отсюда и разрыв по
// движению: у них кадр живёт 15% времени, у нас было 4%. Смена сделана ниже
// (swapImageFileName) — не ползанием, а сменой: первая картинка уезжает вниз и
// растворяется, вторая открывается под ней.
// Наезд хука начинается не с точки: первый кадр ролика — это ещё и обложка в
// ленте, поэтому он должен быть непустым и читаемым сразу.
const HOOK_PUNCH_FROM = 0.78;

interface SceneProps {
  // Слова озвучки с таймингами — для субтитров «по слову». Нет слов — нет и
  // субтитров, кадр остаётся как раньше.
  words?: { text: string; startMs: number; endMs: number }[];
  // Объект, который появляется поверх картинки, не заменяя её.
  overlay?: OverlayData;
  // Вторая иллюстрация сцены и момент смены (мс от начала сцены). Первая
  // уезжает вниз и растворяется, вторая открывается под ней.
  swapImageFileName?: string;
  swapStartMs?: number;
  imageFileName?: string;
  imageWidth?: number;
  imageHeight?: number;
  // Оживлённая версия картинки. Есть клип — в карточке играет он; картинка
  // при этом всё равно нужна: она задаёт пропорции карточки и из неё собран
  // зум-блюр на входе.
  clipFileName?: string;
  clipDurationInFrames?: number;
  // Графические акценты вокруг карточки. В референсе их нет — см. types.ts.
  accentsEnabled?: boolean;
  // Сцена без карточки: маскот стоит прямо на белом фоне, во весь рост.
  // Отдельный приём из референса — см. mascot.ts.
  mascotOnly?: boolean;
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
  swapImageFileName,
  swapStartMs,
  imageFileName,
  imageWidth,
  imageHeight,
  clipFileName,
  clipDurationInFrames,
  accentsEnabled = false,
  mascotOnly = false,
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

  // Смена иллюстрации внутри сцены: 0 → 1 за MIX.imageSwapSeconds, начиная с
  // момента, привязанного к слову реплики. Нет второй картинки — нет и смены.
  //
  // Смену не пускаем на участок ухода сцены: два движения подряд (картинка
  // уезжает вниз, а за ней уезжает вся карточка) читаются как сбой, а не как
  // приём. Если слово попало слишком близко к концу, смену просто не делаем —
  // лучше без неё, чем поверх стыка.
  const swapDurationFrames = Math.round(MIX.imageSwapSeconds * fps);
  const swapStartFrame =
    swapImageFileName && swapStartMs !== undefined
      ? Math.round((swapStartMs / 1000) * fps)
      : undefined;
  const swapFits =
    swapStartFrame !== undefined &&
    swapStartFrame + swapDurationFrames <= exitStartFrame;
  const swapProgress =
    swapFits && swapStartFrame !== undefined
      ? interpolate(
          frame,
          [swapStartFrame, swapStartFrame + swapDurationFrames],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
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
  } else if (motion.entry === "zoomIn") {
    // Приходит во весь кадр и садится в рамку. Рамку и скругление показываем
    // только в конце: на большом масштабе они всё равно за краями кадра, а
    // проявление их «собирает» рамку вокруг картинки, как в референсе.
    cardScale = interpolate(entrance, [0, 1], [ZOOM_FROM_SCALE, 1]);
    cardX = 0;
    cardY = 0;
    cardOpacity = 1;
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

  // Прогресс входа по времени, а не по пружине: у блюра и шторки должен быть
  // ровный ход, пружина же в начале рвётся вперёд.
  const entryProgress = interpolate(frame, [0, Math.max(fadeInFrames, 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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

  // Сила смаза: максимальна в начале входа и сходит на нет к посадке.
  const zoomBlur =
    motion.entry === "zoomIn" && !plainEntry
      ? interpolate(entryProgress, [0, 0.75], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 0;

  // Рваная шторка. Прямую границу дал бы обычный wipe из библиотеки, а нужна
  // неровная — как надрыв бумаги. Собираем многоугольник, у которого граница
  // едет вниз, а её точки смещены псевдослучайно: синус от индекса даёт
  // повторяемый рисунок без Math.random, который в рендере дал бы разный кадр
  // при каждом прогоне.
  const tornClip =
    motion.entry === "tornWipe" && !plainEntry && entryProgress < 1
      ? (() => {
          // Открываем снизу вверх, как в референсе: видимая часть — под
          // границей, поэтому граница едет от 115% (ничего не видно) к -15%
          // (видно всё), а точки по пути смещены.
          // Мелкая неровность, а не пила: с крупной амплитудой край читался
          // языками пламени. Три синуса разной частоты дают рваный,
          // неповторяющийся на глаз профиль.
          const steps = 40;
          const points: string[] = [];
          for (let i = 0; i <= steps; i++) {
            const x = (i / steps) * 100;
            const jitter =
              Math.sin(i * 1.9) * 1.6 +
              Math.sin(i * 5.3) * 1.1 +
              Math.sin(i * 11.7) * 0.6;
            const y = 108 - entryProgress * 116 + jitter;
            points.push(`${x}% ${y}%`);
          }
          return `polygon(${points.join(", ")}, 100% 100%, 0% 100%)`;
        })()
      : undefined;

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

  // Сцена-маскот: карточки нет вовсе, персонаж стоит на белом. Движение
  // входа и ухода берём то же самое — оно применяется к фигуре вместо
  // карточки, поэтому стыки читаются как обычно.
  const mascot = mascotOnly ? mascotBox(width, height) : undefined;
  // Тихое дыхание маскота.
  //
  // Движение входа и ухода у него есть и всегда было — на замере присланного
  // ролика появление джина в финале даёт 37-42 единицы покадровой разницы
  // против 7-15 у хука. А вот МЕЖДУ входом и уходом он стоит совершенно
  // неподвижно: 2.0 единицы, то есть кадр не меняется вовсе, и три секунды
  // подряд зритель смотрит на картинку. Ровно та же беда была у появляющихся
  // объектов, и лечится она тем же: замерший персонаж читается как наклейка,
  // а не как герой.
  //
  // Амплитуда нарочно маленькая. Это не анимация персонажа (её нам взять
  // неоткуда — эталон один-единственный PNG), а признак жизни: плавное
  // покачивание вверх-вниз с едва заметным изменением масштаба, как дыхание.
  const breath = mascotOnly
    ? Math.sin((frame / fps / MASCOT_BREATH_SECONDS) * Math.PI * 2)
    : 0;
  const breathY = breath * MASCOT_BREATH_PERCENT * 0.01 * height;
  const breathScale = 1 + breath * MASCOT_BREATH_SCALE;
  const card = mascot ? (
    <Img
      src={staticFile("characters/shamil.png")}
      style={{
        position: "absolute",
        top: mascot.top,
        width: mascot.width,
        height: mascot.height,
        opacity: cardOpacity,
        transform:
          `translate(${cardX}px, ${cardY + breathY}px) ` +
          `rotate(${cardRotate}deg) skewY(${crumpleSkew}deg) ` +
          `scale(${cardScale * squeezeX * breathScale}, ${cardScale * breathScale})`,
      }}
    />
  ) : (
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
          <>
            {/* Вторая иллюстрация лежит ПОД первой и не двигается: в референсе
                открывается именно она, а уезжает старая. Рисуем её только когда
                смена уже началась — до этого момента она не нужна. */}
            {swapImageFileName && swapProgress > 0 && (
              <Img
                src={staticFile(`images/${swapImageFileName}`)}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            )}
            {clipFileName ? (
              // Оживлённый кадр. Клип короче сцены (обычно 2 с против трёх), и
              // остаток сцены мы подмораживаем на его последнем кадре, а не
              // повторяем с начала: повтор виден как рывок, а замершая сцена
              // читается как «движение улеглось». Звук клипа выключен — у нас
              // своя озвучка.
              //
              // Первый кадр клипа — это ровно та картинка сцены, из которой он
              // сделан, поэтому подмена картинки клипом не видна на стыке.
              <Freeze
                frame={Math.max((clipDurationInFrames ?? 1) - 1, 0)}
                active={(f) => f >= (clipDurationInFrames ?? Infinity)}
              >
                <OffthreadVideo
                  src={staticFile(`clips/${clipFileName}`)}
                  muted
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </Freeze>
            ) : (
              <Img
                src={staticFile(`images/${imageFileName}`)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  // Уход первой картинки. Растворение начинается позже съезда:
                  // в референсе уходящая картинка видна почти до конца движения,
                  // и если гасить её сразу, смена читается как простое
                  // растворение, а не как «сдвинули и убрали».
                  transform: `translateY(${swapProgress * 100}%)`,
                  opacity: interpolate(swapProgress, [0.45, 1], [1, 0], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              />
            )}
            {/* Стопка копий с растущим масштабом поверх картинки — так
                собирается зум-блюр. К концу входа копии гаснут, и остаётся
                чистый кадр. */}
            {zoomBlur > 0 &&
              Array.from({ length: ZOOM_BLUR_LAYERS }, (_, i) => (
                <Img
                  key={`blur-${i}`}
                  src={staticFile(`images/${imageFileName}`)}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    opacity: zoomBlur / ZOOM_BLUR_LAYERS,
                    transform: `scale(${1 + ((i + 1) / ZOOM_BLUR_LAYERS) * ZOOM_BLUR_SPREAD * zoomBlur})`,
                  }}
                />
              ))}
          </>
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
        // Рваная шторка вырезает сцену по неровной границе. Прозрачностью при
        // этом не играем: два растворяющихся кадра под рваным краем дали бы
        // грязь вместо надрыва.
        clipPath: tornClip,
        // Отступ считаем в пикселях от высоты кадра. Процентный padding в CSS
        // отмеряется от ШИРИНЫ контейнера — на вертикальном кадре это давало
        // почти вдвое меньший отступ, и карточка стояла выше, чем в референсе.
        paddingTop: mascotOnly ? 0 : (CARD_TOP_PERCENT / 100) * height,
        // Кроссфейд нужен только тем появлениям, которые не закрывают кадр
        // сами. Зум-блюр приходит во весь экран, и проявление делало его
        // полупрозрачным: под ним просвечивала уходящая сцена.
        opacity: coversFrame(motion) && !plainEntry ? 1 : sceneOpacity,
      }}
    >
      {/* Акценты под карточкой: они украшение, а не содержание. */}
      {accentsEnabled && (
        <Accents sceneIndex={sceneIndex} exitProgress={plainExit ? 0 : exit} />
      )}

      {shuffleGhosts}
      {card}

      {words && words.length > 0 && (
        <Subtitles words={words} exitProgress={plainExit ? 0 : exit} />
      )}
    </AbsoluteFill>
  );
};
