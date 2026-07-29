import { z } from "zod";

// Объект, который появляется поверх картинки сцены, не заменяя её: отдельно
// сгенерированный PNG с прозрачным фоном. Смысл в том, чтобы кадр жил, а
// зритель не терял контекст — фон остаётся тем же.
export const overlaySchema = z.object({
  // Файл в public/overlays/.
  fileName: z.string(),
  // Когда появляется — миллисекунды от начала сцены (обычно на слове, которое
  // этот объект и называет).
  startMs: z.number().nonnegative(),
  // Куда ставить относительно карточки.
  anchor: z.enum(["topLeft", "topRight", "bottomLeft", "bottomRight", "center"]),
  // Ширина в процентах от ширины карточки.
  widthPercent: z.number().positive().max(100),
  // Объект переживает стык: остаётся неподвижно висеть, пока картинка под ним
  // меняется. В референсе так связаны две сцены — знак вопроса из воды стоит
  // на месте, а фон под ним сменяется целиком.
  acrossCut: z.boolean().optional(),
});

// Брендовая концовка: последний кадр ролика. В референсе он не сцена, а
// отдельный экран с логотипом — поэтому и у нас лежит рядом со сценами, а не
// среди них.
export const outroSchema = z.object({
  title: z.string(),
  tagline: z.string().optional(),
  // Файл в public/brand/. Нет файла — кадр собирается из одного текста.
  logoFileName: z.string().optional(),
  durationInFrames: z.number().int().positive(),
});

export type Outro = z.infer<typeof outroSchema>;

export const sceneSchema = z.object({
  caption: z.string(),
  voiceoverText: z.string(),
  audioFileName: z.string(),
  // Необязательно: без картинки Scene.tsx покажет заглушку.
  // Пайплайн кладёт сюда сгенерированный файл из public/images/.
  imageFileName: z.string().optional(),
  // Реальные размеры картинки: по ним карточка подстраивает пропорции, чтобы
  // не обрезать изображение, если модель вернула не вертикаль.
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  // Оживлённая версия картинки — файл в public/clips/. Если он есть, карточка
  // показывает клип вместо картинки. Картинку при этом не выбрасываем: клип
  // сделан из неё, она задаёт пропорции карточки и остаётся запасным вариантом.
  clipFileName: z.string().optional(),
  // Сколько кадров длится сам клип. Сцена обычно длиннее его (клип 2 с,
  // сцена около трёх), и по этому числу Scene.tsx понимает, с какого момента
  // подморозить последний кадр вместо повтора с начала.
  clipDurationInFrames: z.number().int().positive().optional(),
  durationInFrames: z.number().int().positive(),
  // Объект поверх картинки (не заменяет её).
  overlay: overlaySchema.optional(),
  // Слова озвучки с таймингами от начала сцены — для субтитров «по слову».
  // Необязательно: без них субтитров просто не будет.
  words: z
    .array(
      z.object({
        text: z.string(),
        startMs: z.number(),
        endMs: z.number(),
      }),
    )
    .optional(),
});

export const videoDataSchema = z.object({
  title: z.string(),
  fps: z.number().int().positive(),
  outro: outroSchema.optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // Необязательно: фоновая музыка из public/music/, играет тихо под озвучкой.
  musicFileName: z.string().optional(),
  // Звуки на стыках сцен (public/sfx). По умолчанию включены.
  sfxEnabled: z.boolean().optional(),
  // Графические акценты вокруг карточки — искра, звезда, стрелка, кольцо.
  // ВЫКЛЮЧЕНЫ по умолчанию: в присланном референсе их нет вовсе. Я проверил
  // полосу над карточкой на 259 кадрах всех семи частей — она пуста, а
  // редкие «непустые» кадры оказались зум-блюром на стыке, закрывающим кадр
  // целиком. То есть акценты были моей выдумкой, а не замером.
  //
  // Код оставлен: приём сам по себе рабочий, и если однажды захочется
  // отойти от референса — accentsEnabled: true возвращает их.
  accentsEnabled: z.boolean().optional(),
  // Субтитры по словам под подписью. Включены, если у сцен есть words.
  subtitlesEnabled: z.boolean().optional(),
  // Смаз на кадрах перехода. Включён по умолчанию: замер на ролике из 500
  // кадров разницы во времени рендера не показал (34.3 с против 34.5 с) —
  // смазанных кадров мало, и время уходит не на них.
  motionBlurEnabled: z.boolean().optional(),
  scenes: z.array(sceneSchema).min(1),
});

export type Overlay = z.infer<typeof overlaySchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type VideoData = z.infer<typeof videoDataSchema>;

// Заглушка для Studio: аудио scene-0.wav лежит в репозитории, поэтому
// композиция открывается и без запуска пайплайна. Слова прописаны, чтобы сразу
// были видны субтитры «по слову».
export const defaultVideoData: VideoData = {
  title: "Демо-ролик",
  fps: 30,
  width: 1080,
  height: 1920,
  scenes: [
    {
      caption: "Замените меня командой npm run generate",
      voiceoverText: "Это заглушка, пока не сгенерирован реальный сценарий.",
      audioFileName: "scene-0.wav",
      durationInFrames: 90,
      words: [
        { text: "Это", startMs: 0, endMs: 400 },
        { text: "заглушка,", startMs: 400, endMs: 1100 },
        { text: "пока", startMs: 1100, endMs: 1500 },
        { text: "нет", startMs: 1500, endMs: 1800 },
        { text: "сценария", startMs: 1800, endMs: 2600 },
      ],
    },
  ],
};

/**
 * Данные для стенда движения в Studio: по сцене на каждый вариант анимации,
 * включая стыки с библиотечными переходами. Картинок нет намеренно — видно
 * само движение, а не иллюстрации.
 */
export function motionLabData(sceneCount = 10): VideoData {
  // 10 сцен, а не 8: цикл движений длиной 8, и чтобы увидеть ВСЕ варианты
  // входа и ухода, нужен один полный оборот плюс запас — хук занимает нулевую
  // позицию и сдвигает цикл.
  const fps = 60;
  return {
    title: "Стенд движения",
    fps,
    width: 1080,
    height: 1920,
    sfxEnabled: true,
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      caption: `Вариант ${index + 1}`,
      voiceoverText: `Сцена ${index + 1}`,
      audioFileName: "scene-0.wav",
      durationInFrames: Math.round(fps * 1.4),
    })),
  };
}
