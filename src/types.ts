import { z } from "zod";

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
  durationInFrames: z.number().int().positive(),
});

export const videoDataSchema = z.object({
  title: z.string(),
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // Необязательно: фоновая музыка из public/music/, играет тихо под озвучкой.
  musicFileName: z.string().optional(),
  // Звуки на стыках сцен (public/sfx). По умолчанию включены.
  sfxEnabled: z.boolean().optional(),
  scenes: z.array(sceneSchema).min(1),
});

export type Scene = z.infer<typeof sceneSchema>;
export type VideoData = z.infer<typeof videoDataSchema>;

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
    },
  ],
};
